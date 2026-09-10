// zcode-web-service/server/lib/rpc.js
// ZCode 二进制 channel 协议 —— 从 out/host/chunk-KGXW6KHC.js (ChannelServer/ChannelClient)
// 与 renderer assets/styles-DyAcaLKy.js 逆向移植，语义 1:1。
'use strict';

// ---------- Disposable / Emitter ----------
function toDisposable(fn) {
  let done = false;
  const d = () => { if (!done) { done = true; fn(); } };
  d.dispose = d;
  return d;
}

class DisposableStore {
  constructor() { this.items = new Set(); this.isDisposed = false; }
  add(d) {
    if (this.isDisposed) { d.dispose?.(); return d; }
    this.items.add(d); return d;
  }
  dispose() {
    if (!this.isDisposed) {
      this.isDisposed = true;
      for (const d of this.items) d.dispose();
      this.items.clear();
    }
  }
}

class Emitter {
  constructor(options) { this.listeners = new Set(); this.disposed = false; this.options = options; }
  get event() {
    return (cb) => {
      if (this.disposed) return { dispose() {} };
      const first = this.listeners.size === 0;
      this.listeners.add(cb);
      if (first) this.options?.onWillAddFirstListener?.();
      return toDisposable(() => {
        this.listeners.delete(cb);
        if (this.listeners.size === 0) this.options?.onDidRemoveLastListener?.();
      });
    };
  }
  fire(e) { if (!this.disposed) for (const cb of [...this.listeners]) cb(e); }
  dispose() { this.disposed = true; this.listeners.clear(); }
}

const Event = {
  None: () => ({ dispose() {} }),
  once(e) { return (cb) => { let sub = { dispose() {} }; const s2 = e((v) => { sub.dispose(); cb(v); }); sub = s2; return s2; }; },
  toPromise(e) { return new Promise((cb) => Event.once(e)(cb)); },
};

class CancellationTokenSource {
  constructor() { this.emitter = new Emitter(); this._isCancelled = false; this._token = null; }
  get token() {
    if (!this._token) this._token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
    return this._token;
  }
  cancel() { if (!this._isCancelled) { this._isCancelled = true; this._token && (this._token.isCancellationRequested = true); this.emitter.fire(); } }
  dispose() { this.emitter.dispose(); }
}

const CancellationTokenNone = { isCancellationRequested: false, onCancellationRequested: Event.None };

// ---------- VSBuffer ----------
class VSBuffer {
  constructor(buffer) { this.buffer = buffer; this.byteLength = buffer.byteLength; }
  static alloc(n) { return new VSBuffer(new Uint8Array(n)); }
  static wrap(b) { return new VSBuffer(b); }
  static fromString(s) { return new VSBuffer(new TextEncoder().encode(s)); }
  static concat(list, total) {
    const len = total ?? list.reduce((a, b) => a + b.byteLength, 0);
    const out = VSBuffer.alloc(len); let off = 0;
    for (const b of list) { out.set(b, off); off += b.byteLength; }
    return out;
  }
  toString() { return new TextDecoder().decode(this.buffer); }
  slice(a, b) { return new VSBuffer(this.buffer.slice(a, b)); }
  set(b, off = 0) { this.buffer.set(b instanceof VSBuffer ? b.buffer : b, off); }
  readUInt8(i) { return this.buffer[i]; }
  writeUInt8(v, i) { this.buffer[i] = v; }
  readUInt32BE(i) { return ((this.buffer[i] << 24) | (this.buffer[i+1] << 16) | (this.buffer[i+2] << 8) | this.buffer[i+3]) >>> 0; }
  writeUInt32BE(v, i) { this.buffer[i] = (v >>> 24) & 255; this.buffer[i+1] = (v >>> 16) & 255; this.buffer[i+2] = (v >>> 8) & 255; this.buffer[i+3] = v & 255; }
}

function isMessagePortFlowControl(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  return Object.keys(data).length === 2 && data.__zcodeRpcControl === 'connection-flow-v1' &&
    (data.state === 'saturated' || data.state === 'drained');
}

// ---------- WebSocket 上的 MessagePort 适配 ----------
// 服务端视角：把 Node ws 的 socket 包装成 MessagePort 语义。
class WebSocketMessagePort {
  constructor(ws) {
    this.ws = ws;
    this._onMessage = new Emitter();
    this.onMessage = this._onMessage.event;
    this._flowListeners = new Set();
    this._buf = [];
    this._started = false;
    ws.on('message', (data, isBinary) => {
      const asBuf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data.map(Buffer.from)) : Buffer.from(data);
      // flow-control 是文本 JSON 帧
      if (!isBinary && asBuf.length < 512) {
        const txt = asBuf.toString('utf8');
        if (txt.startsWith('{')) {
          try {
            const obj = JSON.parse(txt);
            if (obj.__zcodeRpcControl === 'connection-flow-v1') {
              for (const l of [...this._flowListeners]) l(obj.state);
              return;
            }
          } catch { /* 当作二进制 */ }
        }
      }
      const ev = { data: new Uint8Array(asBuf.buffer, asBuf.byteOffset, asBuf.byteLength) };
      if (this._started) this._onMessage.fire(ev);
      else this._buf.push(ev);
    });
    ws.on('close', () => this._onMessage.dispose());
  }
  addEventListener(type, handler) {
    if (type === 'message') this._onMessage.event(handler);
    else if (type === 'flowstate') this._flowListeners.add(handler);
  }
  removeEventListener(type, handler) {
    // Emitter 的订阅由调用方 dispose；此处仅移除 flow 监听
    if (type === 'flowstate') this._flowListeners.delete(handler);
  }
  postMessage(data) {
    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      this.ws.send(data instanceof Uint8Array ? data : new Uint8Array(data), { binary: true });
    } else {
      this.ws.send(JSON.stringify(data));
    }
  }
  start() {
    this._started = true;
    for (const ev of this._buf.splice(0)) this._onMessage.fire(ev);
  }
  close() { try { this.ws.close(); } catch {} this._onMessage.dispose(); }
}

// MessagePortProtocol —— 与原实现一致
class MessagePortProtocol {
  constructor(port) {
    this.port = port;
    this._onMessage = new Emitter();
    this.onMessage = this._onMessage.event;
    this._onFlowState = new Emitter();
    this.onFlowState = this._onFlowState.event;
    this.handler = (e) => {
      if (isMessagePortFlowControl(e.data)) { this._onFlowState.fire(e.data.state); return; }
      if (e.data instanceof Uint8Array) this._onMessage.fire(VSBuffer.wrap(e.data));
    };
    this.port.addEventListener('message', this.handler);
    this.port.start();
  }
  send(buf) { this.port.postMessage(buf.buffer); }
  sendFlowState(state) { this.port.postMessage({ __zcodeRpcControl: 'connection-flow-v1', state }); }
  disconnect() {
    this.port.removeEventListener('message', this.handler);
    this.port.close();
    this._onMessage.dispose();
    this._onFlowState.dispose();
  }
}

// ---------- 序列化 ----------
class BufferReader {
  constructor(b) { this.buffer = b; this.pos = 0; }
  read(n) {
    const t = this.buffer.slice(this.pos, this.pos + n);
    this.pos += t.byteLength;
    return t;
  }
}
class BufferWriter {
  constructor() { this.buffers = []; }
  get buffer() { return VSBuffer.concat(this.buffers); }
  write(b) { this.buffers.push(b); }
}

function readIntVQL(reader) {
  let value = 0;
  for (let shift = 0; ; shift += 7) {
    const b = reader.read(1);
    value |= (b.buffer[0] & 127) << shift;
    if (!(b.buffer[0] & 128)) return value;
  }
}
function oneInt(v) { const b = VSBuffer.alloc(1); b.writeUInt8(v, 0); return b; }
function writeInt32VQL(writer, value) {
  if (value === 0) { writer.write(oneInt(0)); return; }
  let len = 0;
  for (let v = value; v !== 0; v = v >>> 7) len++;
  const b = VSBuffer.alloc(len);
  let off = 0;
  for (; value !== 0; off++) {
    b.buffer[off] = value & 127;
    value = value >>> 7;
    if (value > 0) b.buffer[off] |= 128;
  }
  writer.write(b);
}

const TypeTag = { Undefined: 0, String: 1, Buffer: 2, VSBuffer: 3, Array: 4, Object: 5, Int: 6 };
const TypeTagBuf = {
  Undefined: oneInt(TypeTag.Undefined), String: oneInt(TypeTag.String), Buffer: oneInt(TypeTag.Buffer),
  VSBuffer: oneInt(TypeTag.VSBuffer), Array: oneInt(TypeTag.Array), Object: oneInt(TypeTag.Object), Int: oneInt(TypeTag.Int),
};
const NESTED_U8 = '__zcode_rpc_nested_uint8array_v1';
const B64 = 'base64';

function serialize(writer, value) {
  if (typeof value === 'undefined') { writer.write(TypeTagBuf.Undefined); return; }
  if (typeof value === 'string') { const b = VSBuffer.fromString(value); writer.write(TypeTagBuf.String); writeInt32VQL(writer, b.byteLength); writer.write(b); return; }
  if (value instanceof VSBuffer) { writer.write(TypeTagBuf.VSBuffer); writeInt32VQL(writer, value.byteLength); writer.write(value); return; }
  if (value instanceof Uint8Array) { const b = VSBuffer.wrap(value); writer.write(TypeTagBuf.Buffer); writeInt32VQL(writer, b.byteLength); writer.write(b); return; }
  if (Array.isArray(value)) { writer.write(TypeTagBuf.Array); writeInt32VQL(writer, value.length); for (const v of value) serialize(writer, v); return; }
  if (typeof value === 'number' && (value | 0) === value) { writer.write(TypeTagBuf.Int); writeInt32VQL(writer, value); return; }
  const b = VSBuffer.fromString(JSON.stringify(value, encodeRpcJsonValue));
  writer.write(TypeTagBuf.Object); writeInt32VQL(writer, b.byteLength); writer.write(b);
}

function deserialize(reader) {
  const tag = reader.read(1).readUInt8(0);
  switch (tag) {
    case TypeTag.Undefined: return;
    case TypeTag.String: return reader.read(readIntVQL(reader)).toString();
    case TypeTag.Buffer: return reader.read(readIntVQL(reader)).buffer;
    case TypeTag.VSBuffer: return reader.read(readIntVQL(reader));
    case TypeTag.Array: { const n = readIntVQL(reader); const out = []; for (let i = 0; i < n; i++) out.push(deserialize(reader)); return out; }
    case TypeTag.Object: return JSON.parse(reader.read(readIntVQL(reader)).toString(), decodeRpcJsonValue);
    case TypeTag.Int: return readIntVQL(reader);
  }
}

function encodeRpcJsonValue(_k, v) { return v instanceof Uint8Array ? { [NESTED_U8]: true, [B64]: bytesToBase64(v) } : v; }
function decodeRpcJsonValue(_k, v) { return isRpcEncodedUint8Array(v) ? base64ToBytes(v[B64]) : v; }
function isRpcEncodedUint8Array(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return v[NESTED_U8] === true && typeof v[B64] === 'string' && Object.keys(v).length === 2;
}
function bytesToBase64(b) { return Buffer.from(b).toString('base64'); }
function base64ToBytes(s) { return new Uint8Array(Buffer.from(s, 'base64')); }

// ---------- ChannelServer（服务端，接收 renderer 的请求） ----------
class ChannelServer {
  constructor(protocol, ctx, timeoutDelay = 1000, deferInit = false) {
    this.protocol = protocol; this.ctx = ctx; this.timeoutDelay = timeoutDelay; this.deferInit = deferInit;
    this.channels = new Map();
    this.activeRequests = new Map();
    this.pendingRequests = new Map();
    this.protocolListener = this.protocol.onMessage((buf) => this.onRawMessage(buf));
    if (!deferInit) this.sendResponse({ type: 200 });
  }
  ready() { this.sendResponse({ type: 200 }); }
  registerChannel(name, channel) {
    this.channels.set(name, channel);
    setTimeout(() => this.flushPendingRequests(name), 0);
  }
  sendResponse(msg) {
    switch (msg.type) {
      case 200: this.send([msg.type]); return;
      case 201: case 202: case 204: case 203: this.send([msg.type, msg.id], msg.data); return;
    }
  }
  send(head, data = undefined) {
    const w = new BufferWriter();
    serialize(w, head); serialize(w, data);
    try { this.protocol.send(w.buffer); } catch {}
  }
  onRawMessage(buf) {
    // 整条消息处理都必须防崩：单个渲染器请求（未知 channel/事件/畸形帧）绝不能杀掉公网服务进程。
    try {
      const r = new BufferReader(buf);
      const head = deserialize(r);
      const data = deserialize(r);
      const type = head[0];
      switch (type) {
        case 100: this.onPromise({ type, id: head[1], channelName: head[2], name: head[3], arg: data }); return;
        case 102: this.onEventListen({ type, id: head[1], channelName: head[2], name: head[3], arg: data }); return;
        case 101: case 103: this.disposeActiveRequest(head[1]); return;
      }
    } catch (e) {
      console.error('[rpc] 消息处理失败（已隔离，服务继续运行）:', e?.message ?? e);
    }
  }
  onPromise(req) {
    const channel = this.channels.get(req.channelName);
    if (!channel) { this.collectPendingRequest(req); return; }
    if (typeof channel.call !== 'function' || !channel.callTargetHas?.(req.name)) {
      // 诊断：未实现的方法记录 channel.method（一次性，防刷屏）
      const key = `${req.channelName}.${req.name}`;
      if (!missingMethodLogged.has(key)) {
        missingMethodLogged.add(key);
        console.warn(`[rpc] 未实现的方法: ${key}`);
      }
    }
    const cts = new CancellationTokenSource();
    let result;
    try { result = channel.call(this.ctx, req.name, req.arg, cts.token); }
    catch (e) { result = Promise.reject(e); }
    const cancelDisposable = toDisposable(() => cts.cancel());
    this.activeRequests.set(req.id, cancelDisposable);
    Promise.resolve(result).then(
      (data) => this.sendResponse({ id: req.id, data, type: 201 }),
      (err) => {
        if (err instanceof Error) {
          const payload = { message: err.message, name: err.name, stack: err.stack ? err.stack.split('\n') : undefined };
          for (const k of ['code', 'data', 'detail', 'details', 'taskId', 'traceId']) {
            const v = err[k]; if (v !== undefined) payload[k] = v;
          }
          this.sendResponse({ id: req.id, data: payload, type: 202 }); return;
        }
        this.sendResponse({ id: req.id, data: err, type: 203 });
      }
    ).finally(() => { cancelDisposable.dispose(); this.activeRequests.delete(req.id); });
  }
  onEventListen(req) {
    const channel = this.channels.get(req.channelName);
    if (!channel) { this.collectPendingRequest(req); return; }
    try {
      const sub = channel.listen(this.ctx, req.name, req.arg)((data) => {
        this.sendResponse({ id: req.id, data, type: 204 });
      });
      this.activeRequests.set(req.id, sub);
    } catch (e) {
      // 订阅失败不得抛出到消息循环（会终止进程）
      console.error(`[rpc] 事件订阅失败 ${req.channelName}.${req.name}:`, e?.message ?? e);
    }
  }
  disposeActiveRequest(id) {
    const d = this.activeRequests.get(id);
    if (d) { d.dispose(); this.activeRequests.delete(id); }
  }
  collectPendingRequest(req) {
    const list = this.pendingRequests.get(req.channelName) ?? [];
    if (list.length === 0) this.pendingRequests.set(req.channelName, list);
    const timer = setTimeout(() => {
      console.error(`Unknown channel: ${req.channelName}`);
      if (req.type === 100) this.sendResponse({
        id: req.id, type: 202,
        data: { name: 'Unknown channel', message: `Channel name '${req.channelName}' timed out after ${this.timeoutDelay}ms`, stack: undefined },
      });
    }, this.timeoutDelay);
    list.push({ request: req, timer });
  }
  flushPendingRequests(name) {
    const list = this.pendingRequests.get(name);
    if (list) {
      for (const { request, timer } of list) {
        clearTimeout(timer);
        if (request.type === 100) this.onPromise(request);
        else if (request.type === 102) this.onEventListen(request);
      }
      this.pendingRequests.delete(name);
    }
  }
  dispose() {
    this.protocolListener?.dispose(); this.protocolListener = null;
    for (const d of this.activeRequests.values()) d.dispose();
    this.activeRequests.clear();
  }
}

// ---------- ChannelClient（host 用它连 app-server？不需要——app-server 用 JSON。保留以备复用 main↔host 调试） ----------
class ChannelClient {
  constructor(protocol) {
    this.protocol = protocol;
    this.protocolListener = this.protocol.onMessage((b) => this.onBuffer(b));
    this.state = 0; this.isDisposed = false;
    this.activeRequests = new Set(); this.handlers = new Map(); this.pendingRejections = new Map();
    this.lastRequestId = 0;
    this._onDidInitialize = new Emitter();
    this.onDidInitialize = this._onDidInitialize.event;
  }
  getChannel(channelName) {
    return {
      call: (name, arg, token) => this.isDisposed ? Promise.reject(new Error('ChannelClient is disposed')) : this.requestPromise(channelName, name, arg, token),
      listen: (name, arg) => this.isDisposed ? Event.None : this.requestEvent(channelName, name, arg),
    };
  }
  requestPromise(channelName, name, arg, token = CancellationTokenNone) {
    const id = this.lastRequestId++;
    if (token.isCancellationRequested) return Promise.reject(new Error('Cancelled'));
    let cancelSub;
    return new Promise((resolve, reject) => {
      this.pendingRejections.set(id, reject);
      const doRequest = () => {
        if (this.isDisposed || !this.pendingRejections.has(id)) return;
        this.handlers.set(id, (msg) => {
          switch (msg.type) {
            case 201: this.handlers.delete(id); this.pendingRejections.delete(id); resolve(msg.data); return;
            case 202: {
              this.handlers.delete(id); this.pendingRejections.delete(id);
              const err = new Error(msg.data.message); err.name = msg.data.name;
              if (msg.data.stack) err.stack = msg.data.stack.join('\n');
              for (const k of ['code', 'data', 'detail', 'details', 'taskId', 'traceId']) {
                const v = msg.data[k]; if (v !== undefined) err[k] = v;
              }
              reject(err); return;
            }
            case 203: this.handlers.delete(id); this.pendingRejections.delete(id); reject(msg.data); return;
          }
        });
        this.sendRequest(100, id, channelName, name, arg);
      };
      if (this.state === 1) doRequest(); else this.whenInitialized().then(doRequest);
      cancelSub = token.onCancellationRequested(() => {
        if (this.pendingRejections.has(id)) {
          this.sendCancelOrDispose(101, id);
          this.handlers.delete(id); this.pendingRejections.delete(id);
          reject(new Error('Cancelled'));
        }
      });
      if (cancelSub) this.activeRequests.add(cancelSub);
    }).finally(() => { cancelSub?.dispose?.(); this.activeRequests.delete(cancelSub); });
  }
  requestEvent(channelName, name, arg) {
    const id = this.lastRequestId++;
    const emitter = new Emitter({
      onWillAddFirstListener: () => {
        const doRequest = () => { this.activeRequests.add(emitter); this.sendRequest(102, id, channelName, name, arg); };
        if (this.state === 1) doRequest(); else this.whenInitialized().then(doRequest);
      },
      onDidRemoveLastListener: () => {
        this.activeRequests.delete(emitter);
        this.sendCancelOrDispose(103, id);
        this.handlers.delete(id);
      },
    });
    this.handlers.set(id, (msg) => emitter.fire(msg.data));
    return emitter.event;
  }
  sendRequest(type, id, channelName, name, arg) {
    const w = new BufferWriter();
    serialize(w, [type, id, channelName, name]);
    serialize(w, arg);
    try { this.protocol.send(w.buffer); } catch {}
  }
  sendCancelOrDispose(type, id) {
    const w = new BufferWriter();
    serialize(w, [type, id]);
    serialize(w, undefined);
    try { this.protocol.send(w.buffer); } catch {}
  }
  onBuffer(buf) {
    const r = new BufferReader(buf);
    const head = deserialize(r);
    const data = deserialize(r);
    const type = head[0];
    if (type === 200) { this.onResponse({ type: 200 }); return; }
    this.onResponse({ type, id: head[1], data });
  }
  onResponse(msg) {
    if (msg.type === 200) { this.state = 1; this._onDidInitialize.fire(); return; }
    this.handlers.get(msg.id)?.(msg);
  }
  whenInitialized() { return this.state === 1 ? Promise.resolve() : Event.toPromise(this.onDidInitialize); }
  dispose(err) {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.protocolListener?.dispose(); this.protocolListener = null;
    const e = err ?? new Error('ChannelClient disposed');
    if (!err) e.name = 'ConnectionClosed';
    for (const [id, reject] of this.pendingRejections) {
      this.pendingRejections.delete(id); this.handlers.delete(id); reject(e);
    }
    for (const s of this.activeRequests) s.dispose?.();
    this.activeRequests.clear(); this.pendingRejections.clear();
    this._onDidInitialize.dispose();
  }
}

// ---------- fromService / toService（与原实现一致的代理语义） ----------
function isEventName(n) { return n.length >= 3 && n[0] === 'o' && n[1] === 'n' && n.charCodeAt(2) >= 65 && n.charCodeAt(2) <= 90; }
function isDynamicEventName(n) { return n.length >= 10 && n.startsWith('onDynamic') && n.charCodeAt(9) >= 65 && n.charCodeAt(9) <= 90; }

const missingEventsLogged = new Set();
const missingMethodLogged = new Set();

function fromService(service) {
  const target = service;
  const dynamicEventListeners = new Map();
  const eventListeners = new Map();
  for (const key in target) {
    if (isEventName(key) && !isDynamicEventName(key) && typeof target[key] === 'function') {
      eventListeners.set(key, bufferEvent(target[key]));
    }
  }
  return {
    callTargetHas(name) { return typeof target[name] === 'function'; },
    listen(ctx, name, arg) {
      const buffered = eventListeners.get(name);
      if (buffered) return buffered;
      const fn = target[name];
      if (typeof fn === 'function') {
        if (isDynamicEventName(name)) return fn.call(target, arg);
        if (isEventName(name)) { const b = bufferEvent(target[name]); eventListeners.set(name, b); return eventListeners.get(name); }
      }
      // 未实现的事件：返回永不触发的空事件，而不是抛错。
      // 桌面版渲染器与主进程同版本编译，事件表天然一致；Web 版服务是重新实现的，
      // 任何遗漏的 on* 事件都不能拖垮整个进程（此处曾导致 onDidChangeProviderRegistry
      // 订阅直接杀死 web 服务）。缺失事件记一次日志，便于按需补实现。
      if (isEventName(name) || isDynamicEventName(name)) {
        if (!missingEventsLogged.has(name)) {
          missingEventsLogged.add(name);
          console.warn(`[rpc] 未实现的事件（已降级为空事件流）: ${name}`);
        }
        return new Emitter().event;
      }
      throw new Error(`Event not found: ${name}`);
    },
    call(ctx, name, args) {
      const fn = target[name];
      if (typeof fn === 'function') {
        let r = fn.apply(target, args || []);
        if (!(r instanceof Promise)) r = Promise.resolve(r);
        return r;
      }
      throw new Error(`Method not found: ${name}`);
    },
  };
}

function bufferEvent(eventFn) {
  const result = [];
  let flushed = false;
  let sub;
  const emitter = new Emitter({
    onWillAddFirstListener: () => { sub = eventFn((e) => { if (flushed) emitter.fire(e); else result.push(e); }); },
    onDidRemoveLastListener: () => { sub?.dispose?.(); sub = undefined; result.length = 0; },
  });
  const evt = emitter.event;
  return (listener) => {
    const disp = evt(listener);
    if (!flushed) {
      flushed = true;
      for (const e of result.splice(0)) emitter.fire(e);
    }
    return disp;
  };
}

function toService(channel, options) {
  return new Proxy({}, {
    get(_t, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(_t, prop, receiver);
      if (typeof prop !== 'string') return Reflect.get(_t, prop, receiver);
      if (prop === 'then') return undefined;
      if (isDynamicEventName(prop)) return (arg) => channel.listen(prop, arg);
      if (isEventName(prop)) return channel.listen(prop);
      return async (...args) => {
        const finalArgs = options?.context !== undefined ? [options.context, ...args] : args;
        return channel.call(prop, finalArgs);
      };
    },
  });
}

module.exports = {
  Emitter, Event, DisposableStore, toDisposable,
  CancellationTokenSource, CancellationTokenNone,
  VSBuffer, BufferReader, BufferWriter, serialize, deserialize,
  ChannelServer, ChannelClient, MessagePortProtocol, WebSocketMessagePort,
  fromService, toService, isEventName, isDynamicEventName,
};
