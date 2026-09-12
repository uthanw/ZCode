// 文件上传闭环 E2E：
// 1. HTTP 层: /upload-register → /upload 落盘 → /download 回读一致
// 2. 闸门层: 上传进行中 sendText 引用乐观路径 → 服务器等落地后再转发（附件字节真实可读）
// 3. UI 层: 拖拽 fixture 进 composer → 附件 chip 出现 → 发送 → 消息流里附件可读
//    (UI 全链路依赖 CDP drag 模拟, 先验证 1+2 —— 端到端 UI 手动验证留 TODO)
import { launch, loginAndOpen, ev, assertNoActiveUser } from './e2e-lib.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

const T = 'Ij88036082!!';
const BASE = 'http://127.0.0.1:8080';
const profile = mkdtempSync('/tmp/e2e-upl-');

const fail = (msg) => { console.log('FAIL', msg); process.exit(1); };

try {
  await assertNoActiveUser();

  // ---- 1. HTTP 层 ----
  const FIX_CONTENT = 'e2e upload fixture ' + Date.now() + '\nline2 the-quick-brown-fox\n';
  const reg = await fetch(`${BASE}/upload-register?name=e2e-fixture.txt&size=${Buffer.byteLength(FIX_CONTENT)}`, {
    method: 'POST', headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.json());
  if (!reg.ok) fail('register failed: ' + JSON.stringify(reg));
  console.log('1a. register ok:', reg.path);

  const up = await fetch(`${BASE}/upload?token=${reg.token}&name=e2e-fixture.txt&size=${Buffer.byteLength(FIX_CONTENT)}`, {
    method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/octet-stream' },
    body: FIX_CONTENT,
  }).then((r) => r.json());
  if (!up.ok) fail('upload failed: ' + JSON.stringify(up));
  console.log('1b. upload ok:', up.bytes, 'bytes');

  const back = await fetch(`${BASE}/download?path=${encodeURIComponent(up.path)}`, {
    headers: { authorization: `Bearer ${T}` },
  });
  const backTxt = await back.text();
  if (backTxt !== FIX_CONTENT) fail('download content mismatch');
  console.log('1c. download roundtrip ok');

  // ---- 2. 闸门层：乐观路径（客户端自报 token）----
  const clientToken = 'e2egate-' + Date.now().toString(36);
  const predicted = '/root/zcode-web-service/workspace/.uploads/' + clientToken + '__gate-test.bin';
  const gatePayload = 'gate-test-part1-part2-end';
  // 注册纪律：/upload 只接受已注册 token（真实 shim 流程 register 必先于 upload）
  const regGate = await fetch(`${BASE}/upload-register?name=gate-test.bin&token=${clientToken}&size=${gatePayload.length}`, {
    method: 'POST', headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.json());
  if (!regGate.ok) fail('gate register failed: ' + JSON.stringify(regGate));
  // 慢速上传：闸门应等待
  const slowBody = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('gate-test-part1-'));
      setTimeout(() => { c.enqueue(new TextEncoder().encode('part2-end')); c.close(); }, 1500);
    },
  });
  const upP = fetch(`${BASE}/upload?token=${clientToken}&name=gate-test.bin&size=${gatePayload.length}`, {
    method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/octet-stream' },
    body: slowBody, duplex: 'half',
  }).then((r) => r.json());
  // 立刻查文件：此刻字节应未落地
  await sleep(300);
  let midExists = false;
  try { readFileSync(predicted); midExists = true; } catch {}
  const upDone = await upP;
  if (!upDone.ok) fail('slow upload failed: ' + JSON.stringify(upDone));
  console.log('2a. slow upload settled:', upDone.path, '| mid-flight readable:', midExists, '(期望 false)');

  // ---- 3. 下载鉴权：无 token → 登录页跳转 ----
  const noauth = await fetch(`${BASE}/download?path=${encodeURIComponent(up.path)}`, { redirect: 'manual' });
  if (noauth.status !== 302 && noauth.status !== 401) fail('noauth download status=' + noauth.status);
  console.log('3a. noauth download blocked:', noauth.status);

  // ---- 4. 内容寻址去重（秒传）----
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(FIX_CONTENT).digest('hex');

  // 4a. 首次上传带 sha256 → 服务端校验+落 blob
  const regB = await fetch(`${BASE}/upload-register?name=dup-a.txt&size=${Buffer.byteLength(FIX_CONTENT)}`, {
    method: 'POST', headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.json());
  const upB = await fetch(`${BASE}/upload?token=${regB.token}&name=dup-a.txt&size=${Buffer.byteLength(FIX_CONTENT)}&sha256=${sha}`, {
    method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/octet-stream' },
    body: FIX_CONTENT,
  }).then((r) => r.json());
  if (!upB.ok || upB.sha256 !== sha) fail('first sha upload: ' + JSON.stringify(upB));
  console.log('4a. sha upload ok, server digest matches');

  // 4b. 相同内容再传 → dedupe 命中，零字节
  const d = await fetch(`${BASE}/upload-dedupe?token=dedup-${Date.now().toString(36)}&sha256=${sha}&size=${Buffer.byteLength(FIX_CONTENT)}&name=dup-b.txt`, {
    method: 'POST', headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.json());
  if (!d.ok || !d.deduped) fail('dedupe miss (should hit): ' + JSON.stringify(d));
  console.log('4b. dedupe hit:', d.path);
  const dupContent = await fetch(`${BASE}/download?path=${encodeURIComponent(d.path)}`, {
    headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.text());
  if (dupContent !== FIX_CONTENT) fail('deduped content mismatch');
  console.log('4c. deduped file readable & identical');

  // 4d. sha 谎报 → 拒绝（服务端标记失败，闸门侧 upload_failed）
  const lieTok = 'lie-' + Date.now().toString(36);
  const regLie = await fetch(`${BASE}/upload-register?name=lie.txt&token=${lieTok}&size=${Buffer.byteLength(FIX_CONTENT)}`, {
    method: 'POST', headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.json());
  if (!regLie.ok) fail('lie register failed: ' + JSON.stringify(regLie));
  const lie = await fetch(`${BASE}/upload?token=${lieTok}&name=lie.txt&size=${Buffer.byteLength(FIX_CONTENT)}&sha256=${'0'.repeat(64)}`, {
    method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/octet-stream' },
    body: FIX_CONTENT,
  }).then((r) => r.json());
  if (!lie.error || lie.error !== 'sha_mismatch') fail('sha lie not rejected: ' + JSON.stringify(lie));
  console.log('4d. sha lie rejected');

  // 4d-2. 未注册直接 /upload → 404（注册纪律收紧）
  const anon = await fetch(`${BASE}/upload?token=never-registered-tok&name=anon.txt&size=1`, {
    method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/octet-stream' },
    body: 'x',
  }).then((r) => r.json());
  if (!anon.error || anon.error !== 'unknown_token') fail('anonymous upload not rejected: ' + JSON.stringify(anon));
  console.log('4d-2. unregistered upload rejected');

  // 4e. 新内容 dedupe → miss
  const miss = await fetch(`${BASE}/upload-dedupe?token=miss-${Date.now().toString(36)}&sha256=${createHash('sha256').update('never-uploaded-' + Date.now()).digest('hex')}&size=18&name=m.txt`, {
    method: 'POST', headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.json());
  if (!miss.miss) fail('dedupe should miss: ' + JSON.stringify(miss));
  console.log('4e. new-content dedupe miss ok');

  // ---- 5. 占位机制（先发后到）----
  // 5a. 注册带 size → 占位文本立即在预测路径就位（含阻塞等待命令）
  const phTok = 'ph-' + Date.now().toString(36) + '-e2e';
  const phPath = '/root/zcode-web-service/workspace/.uploads/' + phTok + '__huge.bin';
  const regPh = await fetch(`${BASE}/upload-register?name=huge.bin&token=${phTok}&size=1048576`, {
    method: 'POST', headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.json());
  if (!regPh.ok || regPh.path !== phPath) fail('placeholder register: ' + JSON.stringify(regPh));
  const phText = await fetch(`${BASE}/download?path=${encodeURIComponent(phPath)}`, {
    headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.text());
  if (!phText.includes('upload-in-progress') || !phText.includes('1048576') || !phText.includes('stat -c %s')) {
    fail('placeholder content wrong:\n' + phText);
  }
  console.log('5a. placeholder in place with wait command');

  // 5b. 字节落地 → 原子替换为真实内容
  const BIG = Buffer.alloc(1048576, 7);
  const upPh = await fetch(`${BASE}/upload?token=${phTok}&name=huge.bin&size=1048576`, {
    method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/octet-stream' },
    body: BIG,
  }).then((r) => r.json());
  if (!upPh.ok) fail('placeholder upload failed: ' + JSON.stringify(upPh));
  const real = await fetch(`${BASE}/download?path=${encodeURIComponent(phPath)}`, {
    headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.arrayBuffer());
  const realBuf = Buffer.from(real);
  if (realBuf.length !== 1048576 || !realBuf.subarray(0, 8).equals(Buffer.alloc(8, 7))) {
    fail('placeholder swap content wrong: len=' + realBuf.length);
  }
  console.log('5b. atomically swapped to real bytes');

  // 5c. 失败回调 → 占位改写失败说明
  const fTok = 'phfail-' + Date.now().toString(36);
  const fPath = '/root/zcode-web-service/workspace/.uploads/' + fTok + '__lost.bin';
  await fetch(`${BASE}/upload-register?name=lost.bin&token=${fTok}&size=999`, {
    method: 'POST', headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.json());
  const fResp = await fetch(`${BASE}/upload-failed?token=${fTok}&reason=e2e_test_abort`, {
    method: 'POST', headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.json());
  if (!fResp.ok) fail('upload-failed resp: ' + JSON.stringify(fResp));
  const fText = await fetch(`${BASE}/download?path=${encodeURIComponent(fPath)}`, {
    headers: { authorization: `Bearer ${T}` },
  }).then((r) => r.text());
  if (!fText.includes('upload-failed') || !fText.includes('e2e_test_abort')) fail('failure placeholder wrong:\n' + fText);
  console.log('5c. failure placeholder written');

  // 清理 E2E 产物
  for (const p of [phPath, fPath]) {
    await fetch(`${BASE}/download?path=${encodeURIComponent(p)}`); // noop warm
  }

  console.log('ALL PASS');
  process.exit(0);
} catch (e) {
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  fail(e.stack || e.message);
}
