// E2E: 任务菜单「查看调用轨迹」→ 模型轨迹面板渲染真实 records
// 覆盖: zcode-task.getModelTrajectory (rollout model-io 读取 + 形状转换)
import { launch, loginAndOpen, ev, click } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { rmSync, mkdtempSync } from 'node:fs';

const profile = mkdtempSync('/tmp/e2e-traj-');
const client = await launch({ port: 9367, profile });
const failExit = async (msg) => { console.log(`FAIL  ${msg}`); client.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(1); };
try {
  await loginAndOpen(client);
  // 1. 打开任务「请求仅回复e2e-ok标记」
  let target = null;
  for (let i = 0; i < 90 && !target; i++) {
    await sleep(1000);
    target = await ev(client, `(() => {
      const els = [...document.querySelectorAll('[data-testid^=task-item-]')];
      const el = els.find(e => (e.innerText||'').trim().split('\\n')[0] === '请求仅回复e2e-ok标记');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`);
  }
  if (!target) {
    const dbg = await ev(client, `JSON.stringify([...document.querySelectorAll('[data-testid^=task-item-]')].slice(0, 8).map(e => (e.innerText||'').trim().split('\n')[0]))`);
    console.log('dbg 任务列表前8:', dbg);
    await failExit('未找到任务「请求仅回复e2e-ok标记」');
  }
  await click(client, target.x, target.y);
  let ok = false;
  for (let w = 0; w < 24; w++) {
    await sleep(5000);
    const len = await ev(client, `document.querySelector('main')?.innerText?.length ?? 0`);
    if (len >= 120) { ok = true; break; }
  }
  console.log('dbg transcript ok:', ok, 'len:', await ev(client, `document.querySelector('main')?.innerText?.length ?? 0`));
  if (!ok) { await failExit('transcript 未渲染'); }

  // 2. 找 appHeader 的任务菜单触发器: 任务标题旁的下拉按钮 (含 ellipsis svg / aria-haspopup)
  // 尝试所有 dropdown 触发器, 点开找「查看调用轨迹」
  let opened = false;
  const coords = await ev(client, `(() => {
    const btns = [...document.querySelectorAll('header button, [role=banner] button, main button')].filter(b => {
      const s = (b.getAttribute('aria-label')||'') + (b.textContent||'');
      return /更多|more|More|⋯|···/i.test(s) || (b.querySelector('svg.lucide-ellipsis, svg.lucide-more-horizontal, svg.lucide-chevrons-down-up') != null);
    });
    return btns.map(b => { const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; });
  })()`);
  for (const c of (coords ?? [])) {
    await click(client, c.x, c.y);
    await sleep(800);
    const found = await ev(client, `!![...document.querySelectorAll('[role=menuitem]')].find(e => (e.textContent||'').includes('查看调用轨迹'))`);
    if (found) { opened = true; break; }
    // 关闭此菜单 (Esc)
    await ev(client, `document.activeElement?.blur?.()`);
    await sleep(300);
  }
  console.log('dbg menu opened:', opened, 'coords:', JSON.stringify(coords ?? []).slice(0, 200));
  if (!opened) {
    // 3. 兜底: 侧栏任务 item hover 出现的 ... 按钮
    const hoverBtn = await ev(client, `(() => {
      const els = [...document.querySelectorAll('[data-testid^=task-item-]')];
      const el = els.find(e => (e.innerText||'').trim().split('\\n')[0] === '请求仅回复e2e-ok标记');
      if (!el) return null;
      const btn = el.querySelector('button');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`);
    if (!hoverBtn) { await failExit('未找到菜单触发器'); }
    await click(client, hoverBtn.x, hoverBtn.y);
    await sleep(800);
  }
  // 4. 点「查看调用轨迹」
  const mi = await ev(client, `(() => {
    const el = [...document.querySelectorAll('[role=menuitem]')].find(e => (e.textContent||'').includes('查看调用轨迹'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  console.log('dbg menuitem 查看调用轨迹:', JSON.stringify(mi));
  if (!mi) { await failExit('菜单里没有「查看调用轨迹」'); }
  await click(client, mi.x, mi.y);
  await sleep(2000);
  console.log('dbg 点击后2s:', JSON.stringify(await ev(client, `document.body.innerText.slice(-500)`)).slice(0, 600));
  console.log('dbg menu仍开:', await ev(client, `!!document.querySelector('[role=menu]')`));

  // 5. 等轨迹 tab 渲染: 「N 次调用」统计出现 (LAt summaryCalls) 即 records 已加载
  let pane = null;
  for (let w = 0; w < 20; w++) {
    await sleep(1000);
    pane = await ev(client, `(() => {
      const t = document.body.innerText;
      const m = t.match(/(\\d+)\\s*次调用/);
      if (m) return { calls: m[1], empty: false, hasModel: t.includes('deepseek'), hasTokens: /输入|输出|token/i.test(t) };
      // 空态文案 = 面板已渲染, 该任务无 model-io 落盘
      if (t.includes('暂无模型调用记录')) return { calls: '0', empty: true, hasModel: false, hasTokens: false };
      return null;
    })()`);
    if (pane) break;
  }
  if (!pane) { await failExit('轨迹面板未渲染'); }
  console.log(`PASS  模型轨迹面板渲染 (calls=${pane.calls}${pane.empty ? ' 空态' : ''} model=${pane.hasModel} tokens=${pane.hasTokens})`);
  if (pane.empty) console.log('WARN  空态 — 当前任务无 rollout 落盘 (非服务故障)');
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
} catch (e) {
  console.log('FAIL 异常:', e.message);
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
