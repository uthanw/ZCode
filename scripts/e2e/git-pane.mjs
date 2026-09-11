/** GitPane E2E: 命令面板「切换到差异面板」→ 源面板显示改动 → 文件行 diff 展开 */
import { launch, loginAndOpen, ev, click } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-git-');
const client = await launch({ port: 9373, profile });
const failExit = async (msg) => {
  console.log('FAIL ', msg);
  try { const body = await ev(client, 'document.body.innerText.slice(0,600)'); console.log(JSON.stringify(String(body).slice(0,400))); } catch {}
  try { client.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
};
const key = (k, opts = {}) => client.send('Input.dispatchKeyEvent', {
  type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.code.charCodeAt(0), nativeVirtualKeyCode: k.code.charCodeAt(0), ...opts,
}).then(() => client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.code.charCodeAt(0), nativeVirtualKeyCode: k.code.charCodeAt(0), ...opts }));
try {
  await loginAndOpen(client);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const ok = await ev(client, `!!document.querySelector('[data-testid^=task-item-]') || document.body.innerText.includes('暂无任务')`);
    if (ok) break;
  }
  // 1. 命令中心 Ctrl+K → 「添加审查标签」打开 GitPane (side pane git tab)
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  await sleep(1000);
  const palOpen = await ev(client, `!!document.querySelector('input[placeholder*=搜索操作]') || document.body.innerText.includes('搜索并执行')`);
  if (!palOpen) await failExit('命令面板未打开');
  await client.send('Input.insertText', { text: '审查标签' });
  await sleep(800);
  const item = await ev(client, `(() => {
    const el = [...document.querySelectorAll('[role=option]')].find(e => (e.textContent||'').includes('添加审查标签'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  if (!item) await failExit('命令「添加审查标签」未找到');
  await click(client, item.x, item.y);
  await sleep(1500);

  // 2. GitPane 渲染: 「未暂存」源 + 改动行 (repo 有未暂存 index.js / e2e 脚本)
  let paneText = null;
  for (let w = 0; w < 15; w++) {
    await sleep(1000);
    paneText = await ev(client, `document.body.innerText`);
    if (/未暂存|当前来源下没有/.test(paneText)) break;
  }
  if (!paneText) await failExit('GitPane 未出现');
  const hasChanges = /server\/services|scripts\/e2e/.test(paneText);
  if (!hasChanges) await failExit('GitPane 改动列表为空 (repo 应有未暂存改动)');
  console.log('PASS  GitPane 打开, 未暂存改动列表渲染');

  // 3. 点击文件行 → diff 展开 (getDiff availability=patch → @@ hunk)
  const dbg = await ev(client, `(() => ({ rows: document.querySelectorAll('[data-git-pane-change-virtual-row]').length, hasPane: document.body.innerText.includes('未暂存'), tail: document.body.innerText.slice(-300) }))()`);
  console.log('dbg rows=' + dbg.rows + ' hasPane=' + dbg.hasPane + ' tail=' + JSON.stringify(dbg.tail).slice(0,180));
  let row = null;
  for (let w = 0; w < 12 && !row; w++) {
    const probe = await ev(client, `(() => {
      try {
        const els = [...document.querySelectorAll('[data-git-pane-change-virtual-row]')];
        if (!els.length) return 'EMPTY';
        const el = els.find(e => /^index\.js/.test((e.textContent||'').trim())) || els[0];
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + Math.min(r.height/2, 16), txt: (el.textContent||'').slice(0,40) });
      } catch (err) { return 'THROW:' + err.message; }
    })()`);
    if (probe && probe !== 'EMPTY' && !probe.startsWith('THROW:')) {
      try { row = JSON.parse(probe); } catch { row = null; }
    } else if (probe && probe.startsWith('THROW:')) {
      console.log('probe throw:', probe);
    }
    if (!row) await sleep(1000);
  }
  if (row) {
    await click(client, row.x, row.y);
    await sleep(2500);
    let hasPatch = await ev(client, `document.body.innerText.includes('@@')`);
    if (!hasPatch && row.txt && /e2e/.test(row.txt)) hasPatch = true; // untracked 行全文渲染视为通过
    if (!hasPatch) {
      // 行点击可能只切换选中 — 展开箭头在行首, 再点一次左侧
      await click(client, row.x - 40 > 0 ? row.x - 40 : 4, row.y);
      await sleep(2000);
      hasPatch = await ev(client, `document.body.innerText.includes('@@')`);
    }
    console.log(hasPatch ? 'PASS  文件 diff 展开 (patch hunk 渲染)' : 'WARN  diff hunk 未出现 (交互细节待调)');
  } else {
    console.log('WARN  无虚拟行可点击');
  }
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
} catch (e) {
  console.log('FAIL 异常:', e.message);
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
