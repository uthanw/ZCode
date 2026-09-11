// E2E: composer 输入 → 发送 → 流式回复渲染 (完整聊天闭环)
import { launch, loginAndOpen, ev, click } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { rmSync, mkdtempSync } from 'node:fs';

const profile = mkdtempSync('/tmp/e2e-comp-');
const client = await launch({ port: 9362, profile });
try {
  await loginAndOpen(client);
  const MSG = '请只回复: e2e-ok-' + Date.now();
  // composer 出现
  let comp = null;
  for (let i = 0; i < 90 && !comp; i++) {
    await sleep(1000);
    comp = await ev(client, `(() => {
      const ce = document.querySelector('[contenteditable=true]');
      if (!ce) return null;
      const r = ce.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + Math.min(r.height/2, 30) };
    })()`);
  }
  if (!comp) { console.log('FAIL  composer 未出现'); process.exit(1); }
  await click(client, comp.x, comp.y);
  await sleep(400);
  await client.send('Input.insertText', { text: MSG });
  await sleep(600);
  const typed = await ev(client, `document.querySelector('[contenteditable=true]')?.innerText?.slice(0, 50)`);
  if (!typed?.includes('e2e-ok-')) { console.log(`FAIL  输入未进入编辑器: ${JSON.stringify(typed)}`); process.exit(1); }
  console.log('PASS  输入: ' + JSON.stringify(typed));
  // 发送
  const btn = await ev(client, `(() => {
    const cands = [...document.querySelectorAll('button')].filter(b => /发送|Send/.test((b.getAttribute('aria-label')||'') + (b.innerText||'')) && !b.disabled);
    if (!cands.length) return null;
    const r = cands[cands.length-1].getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  if (!btn) { console.log('FAIL  无发送按钮'); process.exit(1); }
  await click(client, btn.x, btn.y);
  // 流式回复 (最多 150s; app-server 冷启动可能 ~30s)
  let sawUser = false, sawReply = false, head = '', tail = '';
  for (let w = 0; w < 30; w++) {
    await sleep(5000);
    head = (await ev(client, `document.querySelector('main')?.innerText?.slice(0, 200)`)) ?? '';
    const all = (await ev(client, `document.querySelector('main')?.innerText ?? ''`)) ?? '';
    tail = all.slice(-300);
    if (head.includes(MSG)) sawUser = true;
    // 模型回复完成标志: composer 已清空 + main 里 MSG 出现 >= 2 次 (用户气泡 + 模型复述/回复)
    // 或回复气泡时间戳出现且无「正在思考/工作中」
    const composerEmpty = await ev(client, `!document.querySelector('[contenteditable=true]')?.innerText?.trim()`);
    const msgCount = all.split(MSG).length - 1;
    if (sawUser && composerEmpty && !/正在思考|工作中/.test(all) && (msgCount >= 2 || tail.length > 150)) { sawReply = true; break; }
  }
  console.log((sawUser ? 'PASS  ' : 'FAIL  ') + '用户消息渲染');
  console.log((sawReply ? 'PASS  ' : 'FAIL  ') + '流式回复完成: ' + JSON.stringify(tail.slice(0, 120)));
  console.log(sawUser && sawReply ? '全部通过 ✓' : '有失败');
  process.exit(sawUser && sawReply ? 0 : 1);
} finally {
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
