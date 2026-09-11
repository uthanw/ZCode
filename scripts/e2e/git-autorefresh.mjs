/** GitPane 自动刷新 E2E: 打开源面板 → 服务端直接创建未跟踪文件 → 面板自动出现该文件 */
import { launch, loginAndOpen, ev, click } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-gar-');
const client = await launch({ port: 9385, profile });
const MARK = 'autorefresh-probe-' + Date.now() + '.md';
const WS = '/root/zcode-web-service/workspace';
const failExit = async (msg) => {
  console.log('FAIL ', msg);
  try { unlinkSync(WS + '/' + MARK); } catch {}
  try { client.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
};
try {
  await loginAndOpen(client);
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const ok = await ev(client, `!!document.querySelector('[data-testid^=task-item-]') || document.body.innerText.includes('暂无任务')`);
    if (ok) break;
  }
  // 打开 GitPane (带面板状态重试)
  let item = null;
  for (let attempt = 0; attempt < 3 && !item; attempt++) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
    await sleep(1200);
    const hasPal = await ev(client, `document.body.innerText.includes('搜索并执行')`);
    if (!hasPal) { console.log('attempt', attempt, '面板未开'); await sleep(1500); continue; }
    console.log('attempt', attempt, '面板已开, items=', await ev(client, `[...document.querySelectorAll('[role=option]')].length`));
    await client.send('Input.insertText', { text: '审查标签' });
    await sleep(900);
    item = await ev(client, `(() => {
      const el = [...document.querySelectorAll('[role=option]')].find(e => (e.textContent||'').includes('添加审查标签'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`);
  }
  if (!item) await failExit('命令「添加审查标签」未找到 (重试 3 次)');
  await click(client, item.x, item.y);
  for (let w = 0; w < 15; w++) { await sleep(1000); const t = await ev(client, `document.body.innerText`); if (/未暂存/.test(t)) break; }
  const before = await ev(client, `document.body.innerText.includes(${JSON.stringify(MARK)})`);
  if (before) await failExit('标记文件不应预先存在');
  // 服务端直接创建未跟踪文件 (渲染器不知道) → autoRefreshWatchPaths watch 事件应触发面板刷新
  writeFileSync(WS + '/' + MARK, '# autorefresh probe\n');
  let seen = false;
  for (let w = 0; w < 25; w++) {
    await sleep(1000);
    seen = await ev(client, `document.body.innerText.includes(${JSON.stringify(MARK)})`);
    if (seen) break;
  }
  try { unlinkSync(WS + '/' + MARK); } catch {}
  if (seen) {
    console.log('PASS  GitPane 自动刷新: 服务端新文件 ' + MARK + ' 无需手动刷新即出现在面板');
    client.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(0);
  } else {
    await failExit('25s 内面板未自动出现新文件');
  }
} catch (e) {
  console.log('FAIL 异常:', e.message);
  try { unlinkSync(WS + '/' + MARK); } catch {}
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
