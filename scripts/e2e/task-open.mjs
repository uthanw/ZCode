// E2E: 侧栏点击任务 → 主区域渲染对话 transcript
// 覆盖回归: v4 帧按 subscriptionId 路由 (52b262a)
import { launch, loginAndOpen, ev, click } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { rmSync, mkdtempSync } from 'node:fs';

const CASES = [
  { name: '请只回复: ok', minLen: 120 },   // 同工作区任务
  { name: 'hi', minLen: 120 },             // 跨工作区任务 (~/.zcode/workspace/default)
];

const profile = mkdtempSync('/tmp/e2e-taskopen-');
const client = await launch({ port: 9361, profile });
try {
  await loginAndOpen(client);
  let pass = 0, fail = 0;
  for (const c of CASES) {
    let target = null;
    for (let i = 0; i < 90 && !target; i++) {
      await sleep(1000);
      target = await ev(client, `(() => {
        const els = [...document.querySelectorAll('[data-testid^=task-item-]')];
        const el = els.find(e => (e.innerText||'').trim().split('\\n')[0] === ${JSON.stringify(c.name)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2 };
      })()`);
    }
    if (!target) { console.log(`FAIL  未找到任务「${c.name}」`); fail++; continue; }
    await click(client, target.x, target.y);
    let ok = false;
    for (let w = 0; w < 24; w++) {
      await sleep(5000);
      const len = await ev(client, `document.querySelector('main')?.innerText?.length ?? 0`);
      if (len >= c.minLen) { ok = true; break; }
    }
    const head = await ev(client, `document.querySelector('main')?.innerText?.slice(0, 60)`);
    if (ok) { console.log(`PASS  任务「${c.name}」transcript 渲染 (${JSON.stringify(head)})`); pass++; }
    else { console.log(`FAIL  任务「${c.name}」超时未渲染 (head=${JSON.stringify(head)})`); fail++; }
  }
  console.log(pass === CASES.length ? '全部通过 ✓' : `有失败 (${fail})`);
  process.exit(pass === CASES.length ? 0 : 1);
} finally {
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
