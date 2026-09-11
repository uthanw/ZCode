// 校验 port-shim 手写编解码器与 lib/rpc.js 的 serialize/deserialize 字节级一致
const { BufferWriter, BufferReader, serialize, deserialize } = require('../../server/lib/rpc.js');

// ——— 复制 port-shim 里的实现（保持同步） ———
const TE = new TextEncoder(), TD = new TextDecoder();
function vqlPush(out, v) { if (v === 0) { out.push(0); return; } while (v !== 0) { let b = v & 127; v = v >>> 7; if (v > 0) b |= 128; out.push(b); } }
function pushStr(out, s) { const b = TE.encode(s); out.push(1); vqlPush(out, b.length); for (let i = 0; i < b.length; i++) out.push(b[i]); }
function pushObj(out, v) { const b = TE.encode(JSON.stringify(v)); out.push(5); vqlPush(out, b.length); for (let i = 0; i < b.length; i++) out.push(b[i]); }
function pushInt(out, v) { out.push(6); vqlPush(out, v); }
function encodeRequest(id, channelName, method, args) {
  const out = [];
  out.push(4); vqlPush(out, 4);
  pushInt(out, 100); pushInt(out, id);
  pushStr(out, channelName); pushStr(out, method);
  out.push(4); vqlPush(out, args.length);
  for (const a of args) pushObj(out, a);
  return Uint8Array.from(out);
}
function makeReader(u8) {
  let p = 0;
  return { get left() { return u8.length - p; }, byte() { return u8[p++]; },
    vql() { let v = 0, s = 0, b; do { b = u8[p++]; v |= (b & 127) << s; s += 7; } while (b & 128 && p < u8.length); return v; },
    take(n) { const r = u8.subarray(p, p + n); p += n; return r; } };
}
function decodeValue(r) {
  if (r.left <= 0) return undefined;
  const t = r.byte();
  switch (t) {
    case 0: return undefined;
    case 1: return TD.decode(r.take(r.vql()));
    case 2: case 3: return r.take(r.vql());
    case 4: { const n = r.vql(); const a = []; for (let i = 0; i < n; i++) a.push(decodeValue(r)); return a; }
    case 5: { const s = TD.decode(r.take(r.vql())); try { return JSON.parse(s); } catch { return null; } }
    case 6: return r.vql();
    default: return undefined;
  }
}

let fail = 0;
function eq(name, a, b) { const ok = a === b; console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` (${a} !== ${b})`}`); if (!ok) fail++; }

// 1) encodeRequest 与 rpc.js 字节级一致
for (const id of [0, 1, 127, 128, 16383, 0x40000000, 0x40000001, 0x4000FFFF]) {
  const w = new BufferWriter();
  serialize(w, [100, id, 'zcode-web-health', 'ping']);
  serialize(w, [{ t: 1757000000000 }]);
  const expect = Buffer.from(w.buffer.buffer);
  const got = Buffer.from(encodeRequest(id, 'zcode-web-health', 'ping', [{ t: 1757000000000 }]));
  eq(`encodeRequest id=${id} 字节一致 (${expect.length}B)`, expect.equals(got), true);
}

// 2) decodeValue 能解 rpc.js 生成的响应帧
for (const [type, id, data] of [
  [201, 0x40000001, { ok: true, appServer: 'ok', subscriptions: 7, transport: { cid: 'x', sent: 12 } }],
  [202, 0x40000002, { message: 'boom', name: 'Error' }],
  [204, 5, { topic: 'conversation/x' }],
  [201, 3, undefined],
]) {
  const w = new BufferWriter();
  serialize(w, [type, id]);
  serialize(w, data);
  const u8 = w.buffer.buffer;
  const r = makeReader(u8);
  const head = decodeValue(r);
  eq(`decode head type=${type} id=${id}`, JSON.stringify(head), JSON.stringify([type, id]));
  const body = decodeValue(r);
  eq(`decode body type=${type}`, JSON.stringify(body), JSON.stringify(data));
}

// 3) 保留 id 段不会与渲染器冲突：Int VQL 往返
for (const v of [0x3FFFFFFF, 0x40000000, 0x7FFFFFFF]) {
  const w = new BufferWriter(); serialize(w, v);
  const got = decodeValue(makeReader(w.buffer.buffer));
  eq(`Int VQL 往返 ${v}`, got, v);
}

// 4) 大 payload（Object > 16KB）长度前缀正确
const big = { blob: 'x'.repeat(40000) };
{
  const w = new BufferWriter(); serialize(w, [201, 1]); serialize(w, big);
  const r = makeReader(w.buffer.buffer);
  decodeValue(r);
  eq('大对象解码', decodeValue(r).blob.length, 40000);
}

console.log(fail ? `\n失败 ${fail} 项` : '\n全部通过');
process.exit(fail ? 1 : 0);
