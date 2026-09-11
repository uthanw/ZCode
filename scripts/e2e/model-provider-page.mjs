/** 模型设置页 E2E: 设置→「模型设置」→ DeepSeek Relay provider 可见且无 RPC 报错 */
import { launch, loginAndOpen, ev, click, openCommandPalette } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-mp-');
const client = await launch({ port: 9396, profile });
const failExit = async (msg) => {
  console.log('FAIL ', msg);
  try { const body = await ev(client, 'document.body.innerText.slice(0,400)'); console.log(JSON.stringify(String(body).slice(0,250))); } catch {}
  try { client.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
};
try {
  await loginAndOpen(client);
  for (let i = 0; i < 90; i++) { await sleep(1000); const ok = await ev(client, `!!document.querySelector('[data-testid^=task-item-]') || document.body.innerText.includes('暂无任务')`); if (ok) break; }
  const palOpen = await openCommandPalette(client);
  if (!palOpen) await failExit('命令面板未打开');
  await client.send('Input.insertText', { text: '设置' });
  await sleep(900);
  const item = await ev(client, `(() => {
    const els = [...document.querySelectorAll('[role=option]')];
    const el = els.find(e => /^设置$/.test((e.textContent||'').trim())) || els.find(e => (e.textContent||'').includes('设置'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  if (!item) await failExit('命令「设置」未找到');
  await click(client, item.x, item.y);
  let settingsOpen = false;
  for (let w = 0; w < 10 && !settingsOpen; w++) {
    await sleep(1000);
    settingsOpen = await ev(client, `(() => { const t = document.body.innerText; return t.includes('基础设置') || t.includes('Agent 能力') || t.includes('数据与统计'); })()`);
  }
  if (!settingsOpen) await failExit('设置弹窗未打开 (选项点击竞态)');
  let nav = null;
  for (let w = 0; w < 20 && !nav; w++) {
    await sleep(1000);
    nav = await ev(client, `(() => {
      const els = [...document.querySelectorAll('[data-testid^=settings-section-nav]')];
      const el = els.find(e => (e.getAttribute('aria-label')||'').trim() === '模型设置' || /^\\s*模型设置\\s*$/.test(e.textContent||''));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: r.x + Math.min(r.width/2, 80), y: r.y + r.height/2 };
    })()`);
  }
  if (!nav) await failExit('设置左栏「模型设置」未找到');
  await click(client, nav.x, nav.y);
  let ok = false; let val = null;
  for (let w = 0; w < 20 && !ok; w++) {
    await sleep(1000);
    val = await ev(client, `document.body.innerText`);
    // model-provider channel 真实数据: DeepSeek Relay + deepseek-v4-flash 模型
    ok = typeof val === 'string' && val.includes('DeepSeek') && !val.includes('Method not found');
  }
  if (!ok) {
    console.log('dbg 模型设置 tab:', JSON.stringify(String(val).slice(0, 300)));
    await failExit('未见模型 provider 内容');
  }
  console.log('PASS  模型设置页渲染 (DeepSeek Relay provider 可见, 无 Method not found)');
  try { client.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
} catch (e) {
  console.log('FAIL 异常:', e.message);
  try { client.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
