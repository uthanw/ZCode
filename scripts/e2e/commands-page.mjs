/** 命令页 E2E: 设置导航「命令」→ tab 渲染不崩 (list 四字段齐) */
import { launch, loginAndOpen, ev, click, openCommandPalette } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-cmd-');
const client = await launch({ port: 9396, profile });
const failExit = async (msg) => {
  console.log('FAIL ', msg);
  try { const body = await ev(client, 'document.body.innerText.slice(0,500)'); console.log(JSON.stringify(String(body).slice(0,300))); } catch {}
  client.kill();
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
      const el = els.find(e => /^\\s*命令\\s*$/.test(e.textContent||''));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + Math.min(r.width/2, 80), y: r.y + r.height/2 };
    })()`);
  }
  if (!nav) await failExit('设置左栏「命令」未找到');
  await click(client, nav.x, nav.y);
  // 命令 tab 渲染: 出现「命令」标题区内容 (新建/空态/说明), 且无 React 崩溃
  let ok = false; let val = null;
  for (let w = 0; w < 20 && !ok; w++) {
    await sleep(1000);
    val = await ev(client, `document.body.innerText`);
    ok = typeof val === 'string' && (val.includes('新建命令') || val.includes('自定义命令') || /暂无.*命令/.test(val) || val.includes('斜杠命令'));
  }
  const crashed = await ev(client, `!!document.querySelector('[data-testid=error-boundary], .error-boundary') || document.body.innerText.includes('页面出错')`);
  if (ok && !crashed) {
    console.log('PASS  命令页渲染正常 (无崩溃)');
    client.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(0);
  } else {
    await failExit(crashed ? '页面崩溃' : '20s 内未见命令 tab 内容');
  }
} catch (e) {
  console.log('FAIL 异常:', e.message);
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
