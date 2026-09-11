/** 文件预览 E2E: 文件树点击文件 → 右侧 code-viewer 渲染文本内容 (修复前 dTt 崩) */
import { launch, loginAndOpen, ev, click, openCommandPalette } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
const profile = mkdtempSync('/tmp/e2e-fp-');
// fixture: workspace 里放一个特征文件
const FIX = '/root/zcode-web-service/workspace/e2e-preview-fixture.md';
writeFileSync(FIX, '# e2e preview fixture line1\nline2 preview-me-42\n');
const client = await launch({ port: 9398, profile });
const failExit = async (msg) => {
  console.log('FAIL ', msg);
  try { const body = await ev(client, 'document.body.innerText.slice(0,400)'); console.log(JSON.stringify(String(body).slice(0,300))); } catch {}
  try { client.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); rmSync(FIX, { force: true }); } catch {}
  process.exit(1);
};
try {
  await loginAndOpen(client);
  for (let i = 0; i < 90; i++) { await sleep(1000); const ok = await ev(client, `!!document.querySelector('[data-testid^=task-item-]') || document.body.innerText.includes('暂无任务')`); if (ok) break; }
  // 展开 workspace 文件树 (同 file-tree-refresh.mjs 模式):
  let btn = null;
  for (let i = 0; i < 60 && !btn; i++) {
    await sleep(1000);
    btn = await ev(client, `(() => {
      const b = document.querySelector('[data-testid="workspace-file-tree-button-/root/zcode-web-service/workspace"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`);
  }
  if (!btn) await failExit('文件树按钮未出现');
  await click(client, btn.x, btn.y);
  let treeReady = false;
  for (let i = 0; i < 30 && !treeReady; i++) {
    await sleep(1000);
    treeReady = await ev(client, `document.querySelectorAll('[role=treeitem]').length > 0`);
  }
  if (!treeReady) await failExit('文件树未展开');
  let fileEl = null;
  for (let w = 0; w < 25 && !fileEl; w++) {
    await sleep(1000);
    fileEl = await ev(client, `(() => {
      const els = [...document.querySelectorAll('[role=treeitem]')];
      const el = els.find(e => /e2e-preview-fixture\\.md$/.test((e.textContent || '').trim()));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`);
  }
  if (!fileEl) await failExit('文件树中未找到 fixture 文件');
  await click(client, fileEl.x, fileEl.y);
  // 右侧面板渲染文件内容:
  let ok = false; let crashed = null;
  for (let w = 0; w < 20 && !ok; w++) {
    await sleep(1000);
    const txt = await ev(client, `document.body.innerText`);
    crashed = await ev(client, `!!(document.body.innerText.includes('这块界面出了点问题') || document.body.innerText.includes('Cannot read properties'))`);
    ok = typeof txt === 'string' && txt.includes('preview-me-42');
  }
  if (crashed) await failExit('预览面板崩溃 (错误边界出现)');
  if (!ok) await failExit('20s 内未见文件内容 preview-me-42');
  console.log('PASS  文件预览渲染 (fixture 内容可见, 无崩溃)');
  try { client.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); rmSync(FIX, { force: true }); } catch {}
  process.exit(0);
} catch (e) {
  console.log('FAIL 异常:', e.message);
  try { client.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); rmSync(FIX, { force: true }); } catch {}
  process.exit(1);
}
