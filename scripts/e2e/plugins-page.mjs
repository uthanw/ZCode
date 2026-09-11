/** 插件市场 E2E: 命令中心「MCP 服务器/插件市场」→ 市场列表渲染 (2 个市场, 320 可用插件) */
import { launch, loginAndOpen, ev, click, openCommandPalette } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-pl-');
const client = await launch({ port: 9392, profile });
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
  // 侧栏「自动化」组展开后直接有「插件市场」菜单项 (命令中心没有该命令)
  let navItem = null;
  for (let w = 0; w < 10 && !navItem; w++) {
    await sleep(1000);
    navItem = await ev(client, `(() => {
      const els = [...document.querySelectorAll('button, a, [role=button], [role=treeitem], [role=menuitem]')];
      const el = els.find(e => /^\\s*插件市场\\s*$/.test(e.textContent||''));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return null;
      return { x: r.x + Math.min(r.width/2, 60), y: r.y + r.height/2 };
    })()`);
  }
  if (!navItem) await failExit('侧栏「插件市场」菜单未找到');
  await click(client, navItem.x, navItem.y);
  // 等插件页渲染: 市场插件条目 (每条带独立「安装」行) 出现
  let ok = false; let val = null;
  for (let w = 0; w < 45 && !ok; w++) {
    await sleep(1000);
    val = await ev(client, `document.body.innerText`);
    ok = typeof val === 'string' && val.split('\n').filter(l => l.trim() === '安装').length >= 3;
    if (w === 20) console.log('dbg 20s 页面片段:', JSON.stringify(String(val).slice(-300)));
  }
  if (ok) {
    const installs = String(val).split('\n').filter(l => l.trim() === '安装').length;
    console.log('PASS  插件市场页渲染, ' + installs + ' 个插件带「安装」按钮');
    client.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(0);
  } else {
    await failExit('45s 内未见市场插件列表 (安装按钮)');
  }
} catch (e) {
  console.log('FAIL 异常:', e.message);
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
