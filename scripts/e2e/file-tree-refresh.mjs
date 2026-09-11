// E2E: 文件树实时刷新 — 服务端写文件 → 树自动出现 (file-watcher.watch 链路)
import { launch, loginAndOpen, ev, click } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, rmSync } from 'node:fs';
import { rmSync as rmDir } from 'node:fs';
import { mkdtempSync } from 'node:fs';

const WS = '/root/zcode-web-service/workspace';
const MARK = 'e2e-watch-' + Date.now();
const FILE = `${WS}/${MARK}.txt`;

const client = await launch({ port: 9363, profile: mkdtempSync('/tmp/e2e-ftr-') });
try {
  await loginAndOpen(client);
  // 等 sidebar 就绪 (出现工作区名或文件树)
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(1000);
    ok = await ev(client, `!!document.querySelector('aside, nav, [class*=sidebar]')`);
  }
  if (!ok) { console.log('FAIL  sidebar 未出现'); process.exit(1); }
  console.log('PASS  sidebar 就绪');

  // 点击 workspace-file-tree-button 展开 /root/zcode-web-service/workspace 的文件树
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
  if (!btn) { console.log('FAIL  文件树按钮未出现'); process.exit(1); }
  await click(client, btn.x, btn.y);
  // 树节点 (treeitem) 出现
  let treeReady = false;
  for (let i = 0; i < 30 && !treeReady; i++) {
    await sleep(1000);
    treeReady = await ev(client, `document.querySelectorAll('[role=treeitem]').length > 0`);
  }
  console.log((treeReady ? 'PASS' : 'FAIL ') + ' 文件树已展开' + (treeReady ? '' : ' (treeitem 未出现)'));
  if (!treeReady) process.exit(1);

  // 记录树文本基线
  const baseText = await ev(client, `(document.querySelector('aside')?.innerText || document.body.innerText).includes('${MARK}')`);
  console.log('基线不含标记文件:', baseText === false ? 'PASS' : 'WARN');

  // 服务端写文件 → 树应自动出现 (watch → onDynamicChange → WorkspaceFileTree 重扫)
  writeFileSync(FILE, 'hello');
  let appeared = false;
  for (let w = 0; w < 24 && !appeared; w++) {
    await sleep(2500);
    appeared = await ev(client, `(document.querySelector('aside')?.innerText || document.body.innerText).includes('${MARK}')`);
  }
  if (appeared) console.log(`PASS  树自动出现新文件 ${MARK}.txt (file-watcher 链路通)`);
  else console.log(`FAIL  树未自动出现 ${MARK}.txt`);

  // 清理 & 确认消失
  rmSync(FILE);
  let gone = false;
  for (let w = 0; w < 16 && !gone; w++) {
    await sleep(2500);
    const still = await ev(client, `(document.querySelector('aside')?.innerText || document.body.innerText).includes('${MARK}')`);
    if (!still) gone = true;
  }
  console.log((gone ? 'PASS' : 'WARN ') + ' 删除后树自动移除');

  console.log(appeared ? '全部通过 ✓' : '有失败');
  process.exit(appeared ? 0 : 1);
} finally {
  try { rmSync(FILE); } catch {}
  client.kill();
}
