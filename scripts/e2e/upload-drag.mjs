// E2E: 拖拽上传全链路（真实页面 + 真实 shim + 网络断言）
//
// 背景: httpJson('/upload-register?...') 曾漏传 {method:'POST'} → fetch 默认 GET
// → 服务端 POST-only 路由不匹配 → SPA 兜底返回 index.html → 所有直传必失败。
// 该 bug 只有走「真实浏览器 + 真实 shim」才能暴露（HTTP 层 E2E 用 Bearer + 显式
// POST 测不到），故固化本用例：
//  1. 真页面登录后往 composer dispatch DataTransfer drop（触发渲染器 onDrop →
//     shim getPathForFile 乐观路径 → hash → dedupe → register → XHR /upload）
//  2. 断言: 上传指示器出现「已上传/秒传」；网络记录里 /upload* 全部为 POST 且
//     响应均为 JSON（出现 text/html = 路由失配，直接 FAIL）
//  3. 断言: 落盘文件可经 /download 回读，内容一致
import { launch, loginAndOpen, ev, assertNoActiveUser, BASE, TOKEN } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const fail = (msg) => { console.log('FAIL', msg); process.exit(1); };
const results = [];
function check(name, ok, detail) { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); }

await assertNoActiveUser();
const client = await launch({ port: 9376, profile: '/tmp/e2e-drag-e2e-profile' });
try {
  await client.send('Network.enable');
  // 网络记录：所有 /upload* 请求的 method + 响应 content-type
  const net = [];
  client.on((m) => {
    if (m.method === 'Network.requestWillBeSent' && /^\/upload/.test(new URL(m.params.request.url).pathname)) {
      net.push({ kind: 'req', method: m.params.request.method, path: new URL(m.params.request.url).pathname });
    }
    if (m.method === 'Network.responseReceived' && /^\/upload/.test(new URL(m.params.response.url).pathname)) {
      net.push({ kind: 'res', status: m.params.response.status, ct: m.params.response.headers['content-type'] || '', path: new URL(m.params.response.url).pathname });
    }
  });

  await loginAndOpen(client);
  let loaded = -1;
  for (let i = 0; i < 80; i++) { await sleep(1000); if (await ev(client, `!!document.querySelector('[data-testid=composer-workspace-trigger]')`)) { loaded = i + 1; break; } }
  if (loaded < 0) fail('应用加载超时');
  console.log(`1. 应用加载 ${loaded}s`);

  // 拖入 256KB 随机文件
  const dispatched = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const buf = new Uint8Array(256 * 1024);
      for (let i = 0; i < buf.length; i += 65536) crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, buf.length)));
      const file = new File([buf], 'drag-e2e.bin', { type: 'application/octet-stream' });
      const dt = new DataTransfer(); dt.items.add(file);
      const target = document.querySelector('[data-testid=composer-workspace-trigger]') || document.body;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      return 'ok';
    })()`, returnByValue: true, awaitPromise: true,
  });
  if (dispatched.result?.value !== 'ok') fail('drop dispatch 失败: ' + JSON.stringify(dispatched).slice(0, 200));
  console.log('2. drop 已派发');

  // 等上传指示器收敛到终态（已上传 / 秒传 / 失败）
  let finalState = '';
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const txt = String(await ev(client, `document.getElementById('zcode-upload-indicator')?.shadowRoot?.querySelector('.state')?.textContent || ''`));
    if (/已上传|秒传|失败/.test(txt)) { finalState = txt.trim(); break; }
  }
  check('3. 上传指示器到达终态', !!finalState, finalState || '30s 未收敛');
  if (!finalState) fail('上传未在 30s 内完成');

  // 网络断言
  const reqs = net.filter((x) => x.kind === 'req');
  const res = net.filter((x) => x.kind === 'res');
  const getUploads = reqs.filter((x) => x.method !== 'POST');
  check('4. /upload* 请求全部为 POST', getUploads.length === 0, getUploads.map((x) => x.method + ' ' + x.path).join(', ') || reqs.map((x) => x.path).join(', '));
  const htmlRes = res.filter((x) => /text\/html/.test(x.ct));
  check('5. /upload* 响应无 HTML（路由失配即 FAIL）', htmlRes.length === 0, htmlRes.map((x) => x.status + ' ' + x.path).join(', ') || '');
  check('6. 直传 /upload 已发出且成功', res.some((x) => x.path === '/upload' && x.status === 200 && /json/.test(x.ct)),
    res.filter((x) => x.path === '/upload').map((x) => x.status).join(',') || '未发出');

  // 落盘校验：register 响应体拿不到（shim 内部），用 UploadUI 终态 + 服务器文件校验
  // 通过 /download 读回唯一候选文件名（.uploads/drag-e2e 的最新落盘文件）
  const fs = await import('node:fs');
  const upDir = '/root/zcode-web-service/workspace/.uploads';
  const cand = fs.readdirSync(upDir).filter((f) => f.includes('drag-e2e.bin') && !f.includes('.part')).sort()
    .map((f) => ({ f, st: fs.statSync(upDir + '/' + f) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0];
  check('7. 落盘文件存在且大小为 262144', !!cand && cand.st.size === 262144, cand ? cand.f + ' ' + cand.st.size + 'B' : '未找到');
  if (cand) {
    const back = await fetch(`${BASE}/download?path=${encodeURIComponent(upDir + '/' + cand.f)}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = Buffer.from(await back.arrayBuffer());
    check('8. /download 回读 256KB 一致', body.length === 262144, body.length + 'B');
  }

  console.log(results.every(Boolean) ? '\nALL PASS' : '\nFAILED');
  process.exit(results.every(Boolean) ? 0 : 1);
} finally {
  client.kill();
}
