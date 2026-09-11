/** 技能页 E2E: 命令中心「技能」→ 技能列表渲染 (真实 21 个 skills from app-server) */
import { launch, loginAndOpen, ev, click, openCommandPalette } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-sk-');
const client = await launch({ port: 9394, profile });
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
  await client.send('Input.insertText', { text: '技能' });
  await sleep(900);
  const item = await ev(client, `(() => {
    const el = [...document.querySelectorAll('[role=option]')].find(e => (e.textContent||'').includes('技能'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  if (!item) await failExit('命令「技能」未找到');
  await click(client, item.x, item.y);
  // 技能页渲染: 真实 skill 名 (bmad-init / control-browser / docx 等) 出现
  let ok = false; let val = null;
  for (let w = 0; w < 30 && !ok; w++) {
    await sleep(1000);
    val = await ev(client, `document.body.innerText`);
    ok = typeof val === 'string' && (val.includes('bmad-init') || val.includes('control-browser') || val.includes('docx') || val.includes('pdf') || val.includes('xlsx'));
  }
  if (ok) {
    const found = ['bmad-init','control-browser','web-gui-tester','docx','pdf','pptx','xlsx'].filter(n => String(val).includes(n));
    console.log('PASS  技能页渲染, 可见技能: ' + found.join(', '));
    client.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(0);
  } else {
    await failExit('30s 内未见真实技能名');
  }
} catch (e) {
  console.log('FAIL 异常:', e.message);
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
