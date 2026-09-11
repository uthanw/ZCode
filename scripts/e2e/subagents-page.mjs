/** 子智能体页 E2E: 设置导航「子智能体」→ built-in agents 列表渲染 */
import { launch, loginAndOpen, ev, click, openCommandPalette } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-sa-');
const client = await launch({ port: 9395, profile });
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
  // 设置页加载 → 左栏「子智能体」入口
  let nav = null;
  for (let w = 0; w < 20 && !nav; w++) {
    await sleep(1000);
    nav = await ev(client, `(() => {
      const els = [...document.querySelectorAll('button, a, [role=button]')];
      const el = els.find(e => /^\\s*子智能体\\s*$/.test(e.textContent||''));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + Math.min(r.width/2, 80), y: r.y + r.height/2 };
    })()`);
  }
  if (!nav) await failExit('设置左栏「子智能体」未找到');
  await click(client, nav.x, nav.y);
  // agents 渲染: general-purpose / Explore 出现
  let ok = false; let val = null;
  for (let w = 0; w < 25 && !ok; w++) {
    await sleep(1000);
    val = await ev(client, `document.body.innerText`);
    ok = typeof val === 'string' && val.includes('general-purpose') && val.includes('Explore');
  }
  if (ok) {
    console.log('PASS  子智能体页渲染 (general-purpose + Explore 内置 agent 在列)');
    client.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(0);
  } else {
    await failExit('25s 内未见内置 agents');
  }
} catch (e) {
  console.log('FAIL 异常:', e.message);
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
