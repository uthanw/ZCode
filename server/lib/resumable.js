// server/lib/resumable.js —— 可恢复的 RPC 传输会话
//
// 背景 / 为什么需要它
// ──────────────────────────────────────────────────────────────────────────
// 渲染器只在启动时通过 window.postMessage 收一次 ServicePort（index 入口里有 `if (…||Z) return; Z=!0`
// 的一次性闸门），之后 ChannelClient 永久绑定在那个 MessagePort 上。所以 Web 版**不可能**用
// 「重新派发一个新端口」来做重连——端口必须是同一个，只能把它底下的 WebSocket 换掉。
//
// 但仅仅换 socket 是不够的：ChannelServer 的 activeRequests（进行中的 promise）与事件订阅
// （type=102 listen）全部存活在服务端对象里。若每次 WS 连接都新建 ChannelServer，重连后
// 渲染器的订阅会全部失效——UI 不报错，但对话流、任务列表从此静止，比断线更糟。
//
// 因此本模块把「WS 连接」与「RPC 会话」解耦：
//   * 会话按 cid（每次页面加载生成一次）在服务端常驻，ChannelServer / 订阅 / 进行中请求原样保留；
//   * WS 断开 → detach，会话进入宽限期继续缓冲出站帧；WS 重连 → attach，重放缺口。
//
// 可靠性（为什么要序号而不是「重连就完事」）
//   笔记本合盖 / 移动端切后台时 TCP 常处于「半开」：readyState 仍是 OPEN，send() 不报错，
//   字节却永远到不了对端。此时若不做序号核对，双方都会**静默丢帧**——渲染器少一个响应就永久
//   挂起一个 Promise。所以两个方向各自编号，握手时交换「我已收到 N 帧」，各自从 N+1 重放。
//   已被对端确认的帧才可从重放缓冲中丢弃（靠周期性 ack 控制内存）。
//
// 无法恢复时（缓冲溢出 / 序号出现缺口 / 宽限期已过）明确回 resumed:false，
// 由客户端整页重载——宁可重载，也不要一个看起来正常、实际半死的界面。
'use strict';

const CTRL_FLOW = 'connection-flow-v1';

/** 控制帧类型（全部走 WS 文本帧，二进制帧一律是 RPC 负载）。 */
const CTRL = {
  HELLO: '__zcodeRpcHello',   // 服务端 → 客户端：握手结果 {resumed, recv, cid, reason?}
  ACK: '__zcodeRpcAck',       // 双向：我已收到 n 个二进制帧
  PING: '__zcodeRpcPing',
  PONG: '__zcodeRpcPong',
};

const ACK_EVERY = 32;         // 每收满 32 帧回一次 ack（配合定时 ack 控制重放缓冲占用）
const ACK_INTERVAL_MS = 3000;

class ResumableSession {
  constructor(opts = {}) {
    this.cid = opts.cid;
    this.logger = opts.logger || console;
    this.graceMs = opts.graceMs ?? 10 * 60 * 1000;          // 断开后保活时长（覆盖休眠/切后台）
    this.maxOutboxBytes = opts.maxOutboxBytes ?? 24 * 1024 * 1024;
    this.maxOutboxCount = opts.maxOutboxCount ?? 8000;
    this.onExpire = opts.onExpire || (() => {});

    this.ws = null;
    this.dead = false;         // 已判定不可恢复
    this.deadReason = '';
    this.disposed = false;
    this.sentSeq = 0;          // 本端已发出的二进制帧总数
    this.recvSeq = 0;          // 本端已收到的二进制帧总数
    this.outbox = [];          // [{ seq, data:Uint8Array }] 尚未被对端确认的出站帧
    this.outBytes = 0;
    this.attachCount = 0;
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();

    this._msgHandlers = new Set();   // MessagePort 风格的 'message' 监听
    this._flowHandlers = new Set();  // 'flowstate' 监听
    this._started = false;
    this._preStart = [];
    this._graceTimer = null;
    this._ackTimer = null;
    this._ackedAt = 0;
  }

  // ── MessagePort 兼容面（MessagePortProtocol 只用到这五个成员） ───────────────
  addEventListener(type, handler) {
    if (type === 'message') this._msgHandlers.add(handler);
    else if (type === 'flowstate') this._flowHandlers.add(handler);
  }

  removeEventListener(type, handler) {
    if (type === 'message') this._msgHandlers.delete(handler);
    else if (type === 'flowstate') this._flowHandlers.delete(handler);
  }

  start() {
    if (this._started) return;
    this._started = true;
    for (const ev of this._preStart.splice(0)) this._fireMessage(ev);
  }

  /** ChannelServer/MessagePortProtocol 出站。对象 = flow-control 控制帧（尽力而为，不编号）。 */
  postMessage(data) {
    if (this.disposed) return;
    if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) {
      this._sendText(data);
      return;
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.sentSeq += 1;
    if (!this.dead) {
      this.outbox.push({ seq: this.sentSeq, data: bytes });
      this.outBytes += bytes.byteLength;
      if (this.outBytes > this.maxOutboxBytes || this.outbox.length > this.maxOutboxCount) {
        // 重放缓冲撑爆：本会话不再可能无损恢复。丢缓冲省内存，标记为 dead，
        // 下次 attach 直接回 resumed:false 让客户端重载。
        this._markDead(`重放缓冲溢出 (${(this.outBytes / 1048576).toFixed(1)}MB / ${this.outbox.length} 帧)`);
      }
    }
    this._rawSend(bytes);
  }

  /** MessagePortProtocol.disconnect() 会调用；等同于销毁整个会话。 */
  close() { this.dispose('protocol-close'); }

  // ── 连接接管 ───────────────────────────────────────────────────────────────
  /**
   * 接管一条新 socket。
   * @param {number} clientRecv 客户端声明「我已收到 N 个二进制帧」
   * @param {boolean} isNew     本会话刚创建（首连）：hello.resumed=false，但会话本身完全可用
   * @returns {{ok:boolean, resumed:boolean, reason?:string}}
   *          ok=false 表示会话已无法继续，调用方应销毁它（客户端会整页重载）。
   */
  attach(ws, clientRecv, isNew = false) {
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
    if (this.disposed) { this._closeSocket(ws); return { ok: false, resumed: false, reason: 'disposed' }; }

    // 旧 socket 可能还是「半开」的僵尸，先踢掉，避免两个 socket 同时写同一会话。
    if (this.ws && this.ws !== ws) { const old = this.ws; this.ws = null; this._closeSocket(old); }

    let ok = !this.dead;
    let reason = this.dead ? this.deadReason : '';

    if (ok && !isNew) {
      // 对端已确认收到 clientRecv 帧 → 这些可以丢；剩下的必须能连续重放。
      this._dropAcked(clientRecv);
      const firstNeeded = clientRecv + 1;
      if (clientRecv > this.sentSeq) { ok = false; reason = '客户端声明的接收序号超前于服务端发送序号'; }
      else if (clientRecv < this.sentSeq && (this.outbox.length === 0 || this.outbox[0].seq !== firstNeeded)) {
        ok = false; reason = '重放缓冲已不含客户端缺失的帧';
      }
    }

    const resumed = ok && !isNew;

    this.ws = ws;
    this.attachCount += 1;
    this.lastActiveAt = Date.now();

    ws.on('message', (data, isBinary) => this._onWsMessage(data, isBinary));
    ws.on('close', () => { if (this.ws === ws) this.detach('socket-close'); });
    ws.on('error', () => { if (this.ws === ws) this.detach('socket-error'); });

    // 握手必须先于重放：客户端要先知道 server.recv 才能决定自己重放哪些帧。
    this._sendText({ [CTRL.HELLO]: 'v1', cid: this.cid, resumed, recv: this.recvSeq, reason: reason || undefined });

    if (!ok) { this._markDead(reason || 'not-resumable'); return { ok: false, resumed: false, reason }; }

    // 重放尚未确认的出站帧。首连时这里通常恰好是 ChannelServer.ready() 的初始化帧。
    if (this.outbox.length) {
      let bytes = 0;
      for (const it of this.outbox) { this._rawSend(it.data); bytes += it.data.byteLength; }
      if (resumed) {
        this.logger.info?.(`[rpc] 会话 ${this.cid} 已恢复，重放 ${this.outbox.length} 帧 / ${(bytes / 1024).toFixed(0)}KB（客户端 recv=${clientRecv}，服务端 sent=${this.sentSeq}）`);
      }
    }
    this._startAckTimer();
    return { ok: true, resumed };
  }

  detach(reason) {
    if (this.disposed) return;
    const ws = this.ws;
    this.ws = null;
    this._closeSocket(ws);
    this._stopAckTimer();
    if (this._graceTimer) clearTimeout(this._graceTimer);
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      this.logger.info?.(`[rpc] 会话 ${this.cid} 宽限期(${Math.round(this.graceMs / 1000)}s)内未重连，销毁`);
      this.onExpire(this);
    }, this.graceMs);
    if (this._graceTimer.unref) this._graceTimer.unref();
    this.logger.info?.(`[rpc] 会话 ${this.cid} 已断开(${reason})，保活 ${Math.round(this.graceMs / 1000)}s 等待重连`);
  }

  dispose(reason = 'dispose') {
    if (this.disposed) return;
    this.disposed = true;
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
    this._stopAckTimer();
    const ws = this.ws; this.ws = null;
    this._closeSocket(ws);
    this.outbox.length = 0; this.outBytes = 0;
    this._msgHandlers.clear(); this._flowHandlers.clear(); this._preStart.length = 0;
    this.logger.debug?.(`[rpc] 会话 ${this.cid} 已销毁(${reason})`);
  }

  get isAttached() { return !!this.ws && this.ws.readyState === 1; }

  stats() {
    return {
      cid: this.cid, attached: this.isAttached, attachCount: this.attachCount,
      sent: this.sentSeq, recv: this.recvSeq,
      outbox: this.outbox.length, outboxKB: Math.round(this.outBytes / 1024),
      dead: this.dead, ageSec: Math.round((Date.now() - this.createdAt) / 1000),
    };
  }

  // ── 内部 ───────────────────────────────────────────────────────────────────
  _onWsMessage(data, isBinary) {
    this.lastActiveAt = Date.now();
    const buf = Buffer.isBuffer(data) ? data
      : Array.isArray(data) ? Buffer.concat(data.map(Buffer.from))
        : Buffer.from(data);

    if (!isBinary) { this._onTextFrame(buf.toString('utf8')); return; }

    this.recvSeq += 1;
    // 入站帧不做副本：ChannelServer 会同步反序列化（BufferReader.read → Uint8Array.slice 已复制），
    // 不会跨事件循环持有这个视图。
    const view = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    this._fireMessage({ data: view });
    if (this.recvSeq - this._ackedAt >= ACK_EVERY) this._sendAck();
  }

  _onTextFrame(txt) {
    if (!txt || txt[0] !== '{') return;
    let obj;
    try { obj = JSON.parse(txt); } catch { return; }
    if (obj.__zcodeRpcControl === CTRL_FLOW) {
      for (const h of [...this._flowHandlers]) { try { h(obj.state); } catch {} }
      return;
    }
    if (typeof obj[CTRL.ACK] === 'number') { this._dropAcked(obj[CTRL.ACK]); return; }
    if (obj[CTRL.PING] !== undefined) { this._sendText({ [CTRL.PONG]: obj[CTRL.PING] }); return; }
  }

  _fireMessage(ev) {
    if (!this._started) { this._preStart.push(ev); return; }
    for (const h of [...this._msgHandlers]) {
      try { h(ev); } catch (e) { this.logger.error?.('[rpc] 消息监听器异常（已隔离）:', e?.message ?? e); }
    }
  }

  _dropAcked(upto) {
    if (!(upto > 0)) return;
    let i = 0;
    while (i < this.outbox.length && this.outbox[i].seq <= upto) { this.outBytes -= this.outbox[i].data.byteLength; i++; }
    if (i > 0) this.outbox.splice(0, i);
    if (this.outBytes < 0) this.outBytes = 0;
  }

  _rawSend(bytes) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return; // 未连接 → 已在 outbox 里，重连时重放
    try { ws.send(bytes, { binary: true }); } catch { /* 下次 attach 重放 */ }
  }

  _sendText(obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  _sendAck() {
    if (this.recvSeq === this._ackedAt) return;
    this._ackedAt = this.recvSeq;
    this._sendText({ [CTRL.ACK]: this.recvSeq });
  }

  _startAckTimer() {
    if (this._ackTimer) return;
    this._ackTimer = setInterval(() => this._sendAck(), ACK_INTERVAL_MS);
    if (this._ackTimer.unref) this._ackTimer.unref();
  }

  _stopAckTimer() { if (this._ackTimer) { clearInterval(this._ackTimer); this._ackTimer = null; } }

  _markDead(reason) {
    if (this.dead) return;
    this.dead = true;
    this.deadReason = reason;
    this.outbox.length = 0; this.outBytes = 0;
    this.logger.warn?.(`[rpc] 会话 ${this.cid} 不可恢复: ${reason}`);
  }

  _closeSocket(ws) {
    if (!ws) return;
    try { ws.removeAllListeners('message'); } catch {}
    try { ws.removeAllListeners('close'); } catch {}
    try { ws.removeAllListeners('error'); } catch {}
    try { if (ws.readyState === 0 || ws.readyState === 1) ws.close(); } catch {}
  }
}

module.exports = { ResumableSession, CTRL, CTRL_FLOW };
