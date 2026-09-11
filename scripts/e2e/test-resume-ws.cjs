// 直连 WS 验证：resumable 握手 + zcode-web-health 业务探针 + 断线恢复（无浏览器）
const { createRequire } = require('module');
const req2 = createRequire(require('node:path').join(__dirname, '..', '..', 'package.json'));
const WebSocket = req2('ws');
const { BufferWriter, BufferReader, serialize, deserialize } = require('../../server/lib/rpc.js');

const TOKEN = 'Ij88036082!!';
const BASE = 'ws://127.0.0.1:8080/rpc';
const PROBE_BASE = 0x40000000;
let fail = 0;
const ck = (n, ok, d) => { console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!ok) fail++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function frame(id, ch, m, args) {
  const w = new BufferWriter();
  serialize(w, [100, id, ch, m]); serialize(w, args);
  return Buffer.from(w.buffer.buffer);
}
function listenFrame(id, ch, m, arg) {
  const w = new BufferWriter();
  serialize(w, [102, id, ch, m]); serialize(w, arg);
  return Buffer.from(w.buffer.buffer);
}
function parse(buf) {
  const r = new BufferReader({ buffer: new Uint8Array(buf), slice(a,b){ return { buffer: new Uint8Array(buf).slice(a,b), byteLength: b-a, toString(){ return Buffer.from(new Uint8Array(buf).slice(a,b)).toString('utf8'); }, readUInt8(i){ return new Uint8Array(buf).slice(a,b)[i]; } }; } });
  return null;
}

/** 一个最小客户端：统计序号、处理 hello/ack、可发 RPC。 */
function makeClient(cid, opts = {}) {
  const url = `${BASE}?token=${encodeURIComponent(TOKEN)}&cid=${cid}&recv=${opts.recv || 0}&new=${opts.isNew ? 1 : 0}`;
  const ws = new WebSocket(url, { perMessageDeflate: false });
  const c = { ws, cid, hello: null, recv: 0, sent: 0, frames: [], pending: new Map(), events: [], closed: false };
  c.ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  c.helloP = new Promise((res) => { c._helloRes = res; });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const o = JSON.parse(data.toString());
      if (o.__zcodeRpcHello) { c.hello = o; c._helloRes(o); }
      if (o.__zcodeRpcPong !== undefined) c.lastPong = o.__zcodeRpcPong;
      return;
    }
    c.recv++;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const { VSBuffer } = require('/root/zcode-web-service/server/lib/rpc.js');
    const rd = new BufferReader(VSBuffer.wrap(new Uint8Array(buf)));
    let head, body;
    try { head = deserialize(rd); body = deserialize(rd); } catch { return; }
    c.frames.push({ head, body });
    if (Array.isArray(head)) {
      if (head[0] === 204) { c.events.push({ id: head[1], body }); return; }
      const cb = c.pending.get(head[1]);
      if (cb) { c.pending.delete(head[1]); cb(head[0], body); }
    }
  });
  ws.on('close', () => { c.closed = true; });
  c.call = (id, ch, m, args) => new Promise((res) => {
    c.pending.set(id, (t, b) => res({ type: t, body: b }));
    c.sent++; ws.send(frame(id, ch, m, args));
  });
  c.listen = (id, ch, m, arg) => { c.sent++; ws.send(listenFrame(id, ch, m, arg)); };
  c.ack = () => ws.send(JSON.stringify({ __zcodeRpcAck: c.recv }));
  c.ping = () => ws.send(JSON.stringify({ __zcodeRpcPing: Date.now() }));
  return c;
}

(async () => {
  console.log('=== A. 首连握手 ===');
  const cid = 'test-' + Math.random().toString(36).slice(2, 8);
  const c1 = makeClient(cid, { isNew: true });
  await c1.ready;
  const h1 = await c1.helloP;
  ck('收到 hello', !!h1, JSON.stringify(h1));
  ck('首连 resumed=false', h1.resumed === false);
  ck('hello.cid 回显正确', h1.cid === cid);
  await sleep(300);
  ck('收到 ChannelServer 初始化帧(type 200)', c1.frames.some(f => f.head && f.head[0] === 200), `共 ${c1.recv} 帧`);

  console.log('\n=== B. 业务健康探针 ===');
  const r1 = await c1.call(PROBE_BASE + 1, 'zcode-web-health', 'ping', [{ t: Date.now() }]);
  ck('health.ping 返回成功', r1.type === 201, JSON.stringify(r1.body).slice(0, 220));
  ck('app-server 状态为 ok', r1.body && r1.body.appServer === 'ok', r1.body && r1.body.appServerError);
  ck('返回订阅计数字段', r1.body && typeof r1.body.subscriptions === 'number', 'subs=' + r1.body?.subscriptions);
  ck('返回 transport 统计', !!(r1.body && r1.body.transport && r1.body.transport.cid === cid));

  console.log('\n=== C. 事件订阅计数（业务状态指标）===');
  const subsBefore = r1.body.subscriptions;
  c1.listen(7001, 'zcode-task', 'onTaskListChanged', undefined);
  c1.listen(7002, 'v4-protocol', 'onDynamicConversationFrame', { workspacePath: '/root/.zcode/workspace/default' });
  await sleep(600);
  const r2 = await c1.call(PROBE_BASE + 2, 'zcode-web-health', 'ping', [{}]);
  ck('订阅后计数增加', r2.body.subscriptions >= subsBefore + 1, `${subsBefore} → ${r2.body.subscriptions}`);

  console.log('\n=== D. 断线重连：同一会话、订阅存活、无损重放 ===');
  // 真实客户端的 recv 是**会话级累计**计数，不随 socket 重建归零
  let cumRecv = c1.recv, cumSent = c1.sent;
  c1.ack();
  await sleep(200);
  c1.ws.terminate();                       // 粗暴断开，等同拔网线
  await sleep(400);
  const c2 = makeClient(cid, { recv: cumRecv, isNew: false });
  await c2.ready;
  const h2 = await c2.helloP;
  ck('重连 hello.resumed=true', h2.resumed === true, JSON.stringify(h2));
  ck('服务端 recv 计数连续', h2.recv === cumSent, `server.recv=${h2.recv} client.sent=${cumSent}`);
  const r3 = await c2.call(PROBE_BASE + 3, 'zcode-web-health', 'ping', [{}]);
  cumSent += 1;
  ck('重连后 RPC 仍可用', r3.type === 201);
  ck('重连后事件订阅仍存活（业务状态一致）', r3.body.subscriptions >= subsBefore + 1, `subs=${r3.body.subscriptions}`);
  ck('重连后 transport.attachCount=2', r3.body.transport.attachCount === 2, JSON.stringify(r3.body.transport));
  cumRecv += c2.recv;

  console.log('\n=== E. 未确认帧会被重放（无损） ===');
  // c2 从未 ack 过 → 服务端 outbox 里仍留着它收到的帧。
  // 用「少报 2 帧」重连，服务端必须把这 2 帧补发回来。
  const gap = Math.min(2, c2.recv);
  c2.ws.terminate();
  await sleep(300);
  const c3 = makeClient(cid, { recv: cumRecv - gap, isNew: false });
  await c3.ready;
  const h3 = await c3.helloP;
  await sleep(500);
  ck(`声明少收 ${gap} 帧 → 仍可恢复`, h3.resumed === true, JSON.stringify(h3));
  ck('服务端重放了缺口帧', c3.recv >= gap, `重连后立刻收到 ${c3.recv} 帧（期望 ≥${gap}）`);
  cumRecv = cumRecv - gap + c3.recv;

  console.log('\n=== F. 不可恢复场景 ===');
  // F1: 未知 cid 且 new=0 → resumed:false 且不建会话
  const c4 = makeClient('ghost-' + Math.random().toString(36).slice(2, 8), { recv: 5, isNew: false });
  await c4.ready;
  const h4 = await c4.helloP;
  ck('未知会话 → resumed=false', h4.resumed === false && h4.reason === 'session-not-found', JSON.stringify(h4));
  await sleep(600);
  ck('未知会话的 socket 被关闭', c4.closed);
  // F2: 声明的 recv 超前于服务端已发送数 → 不可恢复
  c3.ws.terminate();
  await sleep(300);
  const c5 = makeClient(cid, { recv: 99999, isNew: false });
  await c5.ready;
  const h5 = await c5.helloP;
  ck('recv 超前 → resumed=false', h5.resumed === false && /超前/.test(h5.reason || ''), JSON.stringify(h5));
  await sleep(400);
  try { c5.ws.terminate(); } catch {}

  console.log('\n=== G. 心跳 ping/pong ===');
  const c6 = makeClient('hb-' + Math.random().toString(36).slice(2, 8), { isNew: true });
  await c6.ready; await c6.helloP;
  c6.ping();
  await sleep(400);
  ck('服务端应答 pong', typeof c6.lastPong === 'number');
  c6.ws.terminate();

  await sleep(300);
  console.log(fail ? `\n失败 ${fail} 项` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
