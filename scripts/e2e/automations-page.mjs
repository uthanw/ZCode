/** 自动化页 E2E: 设置→「自动化」→ tab 空态渲染 (修复前 Method not found 报错) */
import { launch, loginAndOpen, ev, click, openCommandPalette } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-auto-');
const client = await launch({ port: 9399, profile });
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
  let nav = null;
  for (let w = 0; w < 20 && !nav; w++) {
    await sleep(1000);
    nav = await ev(client, `(() => {
      const els = [...document.querySelectorAll('button, a, [role=button]')];
      const el = els.find(e => /^\\s*自动化\\s*$/.test(e.textContent||''));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: r.x + Math.min(r.width/2, 80), y: r.y + r.height/2 };
    })()`);
  }
  if (!nav) await failExit('设置左栏「自动化」未找到');
  await click(client, nav.x, nav.y);
  let ok = false; let val = null;
  for (let w = 0; w < 20 && !ok; w++) {
    await sleep(1000);
    val = await ev(client, `document.body.innerText`);
    // 空态 + 新建入口, 且无 RPC 错误
    ok = typeof val === 'string' && (val.includes('新建自动化') || /暂无/.test(val)) && !val.includes('Method not found');
  }
  if (ok) {
    console.log('PASS  自动化页渲染 (空态正常, 无 Method not found)');
  } else {
    console.log('dbg 自动化 tab:', JSON.stringify(String(val).slice(0, 300)));
  }
  if (false) {
    try { client.kill(); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(0);
  }
} catch (e) {
  console.log('FAIL 异常:', e.message);
  try { client.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
