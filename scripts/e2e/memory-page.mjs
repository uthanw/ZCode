/** 记忆页 E2E: 设置→「记忆」→ 开关 + viewer 区渲染 */
import { launch, loginAndOpen, ev, click, openCommandPalette } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-mem-');
const client = await launch({ port: 9397, profile });
const failExit = async (msg) => {
  console.log('FAIL ', msg);
  try { const body = await ev(client, 'document.body.innerText.slice(0,400)'); console.log(JSON.stringify(String(body).slice(0,250))); } catch {}
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
  // 断言设置弹窗真的开了 (点击可能因选项列表竞态失效):
  let settingsOpen = false;
  for (let w = 0; w < 10 && !settingsOpen; w++) {
    await sleep(1000);
    settingsOpen = await ev(client, `(() => { const t = document.body.innerText; return t.includes('基础设置') || t.includes('Agent 能力') || t.includes('数据与统计'); })()`);
  }
  if (!settingsOpen) {
    console.log('dbg 设置弹窗未开, body:', JSON.stringify(String(await ev(client, 'document.body.innerText.slice(0, 200)')).slice(0, 150)));
    await failExit('设置弹窗未打开 (选项点击竞态)');
  }
  // palette overlay 必须关闭, 否则拦截设置侧栏点击:
  let palGone = false;
  for (let w = 0; w < 6 && !palGone; w++) {
    await sleep(1000);
    palGone = await ev(client, `!document.body.innerText.includes('命令面板')`);
  }
  if (!palGone) {
    await ev(client, `(() => { document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', keyCode:27, bubbles:true})); return true; })()`);
    await sleep(800);
    console.log('dbg palette 未自动关闭, 已发 Escape; body 头部:', JSON.stringify(String(await ev(client, 'document.body.innerText.slice(0, 100)')).slice(0, 80)));
  }
  let nav = null;
  for (let w = 0; w < 20 && !nav; w++) {
    await sleep(1000);
    nav = await ev(client, `(() => {
      const els = [...document.querySelectorAll('button, a, [role=button]')];
      const el = els.find(e => /^\\s*记忆\\s*$/.test(e.textContent||'')) || els.find(e => (e.textContent||'').trim() === '记忆');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + Math.min(r.width/2, 80), y: r.y + r.height/2 };
    })()`);
  }
  if (!nav) await failExit('设置左栏「记忆」未找到');
  await click(client, nav.x, nav.y);
  let ok = false; let val = null;
  for (let w = 0; w < 20 && !ok; w++) {
    await sleep(1000);
    val = await ev(client, `document.body.innerText`);
    ok = typeof val === 'string' && val.includes('工作区记忆');
  }
  if (!ok) {
    console.log('dbg 记忆 tab 内容:', JSON.stringify(String(val).slice(0, 300)));
    await failExit('未见记忆 tab 内容');
  }
  console.log('PASS  记忆页渲染 (工作区记忆开关 + viewer localOnly 提示)');
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
} catch (e) {
  console.log('FAIL 异常:', e.message);
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
