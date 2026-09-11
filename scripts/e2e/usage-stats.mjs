/** 使用统计 E2E: 命令中心「设置」→ 使用统计节 → 真实 token 数渲染 (非 --) */
import { launch, loginAndOpen, ev, click, openCommandPalette } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-us-');
const client = await launch({ port: 9390, profile });
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
  // Ctrl+K → 「设置」
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
  await sleep(2000);
  // 设置页找「使用统计」导航
  let found = false;
  for (let w = 0; w < 15 && !found; w++) {
    await sleep(1000);
    found = await ev(client, `document.body.innerText.includes('使用统计')`);
  }
  if (!found) await failExit('设置页未见「使用统计」入口');
  const nav = await ev(client, `(() => {
    const els = [...document.querySelectorAll('button, a, [role=treeitem], [role=option], div[class*=nav] *')];
    const el = els.find(e => /^使用统计$/.test((e.textContent||'').trim()));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + Math.min(r.width/2, 60), y: r.y + r.height/2, w: r.width };
  })()`);
  if (!nav) await failExit('「使用统计」导航项未找到');
  await click(client, nav.x, nav.y);
  // 等统计渲染: 「累计 Tokens」值非 '--'
  let ok = false; let val = null;
  for (let w = 0; w < 25 && !ok; w++) {
    await sleep(1000);
    const t = await ev(client, `document.body.innerText`);
    ok = /累计\s*tokens|lifetime/i.test(t) && !/^(--)$/.test(t);
    // 更直接: 找「--」以外的数值。使用统计卡片值区域:
    const probe = await ev(client, `(() => {
      const t = document.body.innerText;
      const i = t.indexOf('累计');
      if (i < 0) return null;
      return t.slice(i, i + 80);
    })()`);
    if (probe) { val = probe; ok = /\d/.test(probe); }
  }
  if (ok) {
    console.log('PASS  使用统计渲染真数据:', JSON.stringify(val));
    client.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(0);
  } else {
    await failExit('使用统计值未出现数字: ' + JSON.stringify(val));
  }
} catch (e) {
  console.log('FAIL 异常:', e.message);
  client.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
