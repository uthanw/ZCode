/** MCP 服务器页 E2E: 命令中心「MCP 服务器」→ 页面渲染 (无 workspace MCP 时空态正常) */
import { launch, loginAndOpen, ev, click, openCommandPalette } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-mcp-');
const client = await launch({ port: 9393, profile });
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
  // 命令中心 → 「MCP 服务器」(19 项列表里有)
  const palOpen = await openCommandPalette(client);
  if (!palOpen) await failExit('命令面板未打开');
  await client.send('Input.insertText', { text: 'MCP' });
  await sleep(900);
  const item = await ev(client, `(() => {
    const el = [...document.querySelectorAll('[role=option]')].find(e => (e.textContent||'').includes('MCP 服务器'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  if (!item) await failExit('命令「MCP 服务器」未找到');
  await click(client, item.x, item.y);
  // MCP 页渲染: 「MCP 服务器」标题 + 新建服务器/配置指引类内容
  let ok = false; let val = null;
  for (let w = 0; w < 30 && !ok; w++) {
    await sleep(1000);
    val = await ev(client, `document.body.innerText`);
    ok = typeof val === 'string' && (val.includes('MCP 服务器') && (val.includes('添加') || val.includes('配置') || val.includes('暂无') || val.includes('新建')));
  }
  if (ok) {
    const i = String(val).indexOf('MCP 服务器');
    console.log('PASS  MCP 服务器页渲染:', JSON.stringify(String(val).slice(Math.max(0,i-20), i + 150)));
    client.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(0);
  } else {
    await failExit('30s 内未见 MCP 页内容');
  }
} catch (e) {
  console.log('FAIL 异常:', e.message);
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
