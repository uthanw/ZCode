/**
 * 可恢复的 RPC 传输会话（从 zcode-web-next 垫片移植，TypeScript 重写）。
 *
 * 背景 / 为什么需要它
 * ──────────────────────────────────────────────────────────────────────────
 * 渲染器只在启动时通过 window.postMessage 收一次 ServicePort（入口里有一次性闸门），
 * 之后 ChannelClient 永久绑定在那个 MessagePort 上。所以 Web 端**不可能**用
 * 「重新派发一个新端口」来做重连——端口必须是同一个，只能把它底下的 WebSocket 换掉。
 *
 * 但仅仅换 socket 是不够的：ChannelServer 的 activeRequests（进行中的 promise）与事件订阅
 * （type=102 listen）全部存活在服务端对象里。若每次 WS 连接都新建 ChannelServer，重连后
 * 渲染器的订阅会全部失效——UI 不报错，但对话流、任务列表从此静止，比断线更糟。
 *
 * 因此本模块把「WS 连接」与「RPC 会话」解耦：
 *   * 会话按 cid（每次页面加载生成一次）在服务端常驻，ChannelServer / 订阅 / 进行中请求原样保留；
 *   * WS 断开 → detach，会话进入宽限期继续缓冲出站帧；WS 重连 → attach，重放缺口。
 *
 * 可靠性（为什么要序号而不是「重连就完事」）
 *   笔记本合盖 / 移动端切后台时 TCP 常处于「半开」：readyState 仍是 OPEN，send() 不报错，
 *   字节却永远到不了对端。此时若不做序号核对，双方都会**静默丢帧**——渲染器少一个响应就永久
 *   挂起一个 Promise。所以两个方向各自编号，握手时交换「我已收到 N 帧」，各自从 N+1 重放。
 *   已被对端确认的帧才可从重放缓冲中丢弃（靠周期性 ack 控制内存）。
 *
 * 无法恢复时（缓冲溢出 / 序号出现缺口 / 宽限期已过）明确回 resumed:false，
 * 由客户端整页重载——宁可重载，也不要一个看起来正常、实际半死的界面。
 */
import type { WebSocket } from "ws";
import type { ISocket } from "@zcode/rpc";
import { Emitter, VSBuffer } from "@zcode/rpc";

const CTRL_FLOW = "connection-flow-v1";

/** 控制帧类型（全部走 WS 文本帧，二进制帧一律是 RPC 负载）。 */
export const CTRL = {
  HELLO: "__zcodeRpcHello", // 服务端 → 客户端：握手结果 {resumed, recv, cid, reason?}
  ACK: "__zcodeRpcAck", // 双向：我已收到 n 个二进制帧
  PING: "__zcodeRpcPing",
  PONG: "__zcodeRpcPong",
} as const;

const ACK_EVERY = 32; // 每收满 32 帧回一次 ack（配合定时 ack 控制重放缓冲占用）
const ACK_INTERVAL_MS = 3000;

/** MessagePort 风格的消息事件（MessagePortProtocol 只用到 data 字段）。 */
/** 入站二进制帧（SocketProtocol 期待的 VSBuffer 载荷）。 */
export type ResumableMessageEvent = VSBuffer;

/** 拥塞状态变化回调：true = 上游应暂停生产，false = 可恢复。 */
export type CongestionChangeListener = (congested: boolean) => void;

export interface ResumableSessionOptions {
  readonly cid: string;
  readonly logger?: Pick<Console, "info" | "warn" | "error" | "debug">;
  /** 断开后保活时长（覆盖休眠/切后台）。 */
  readonly graceMs?: number;
  /** 同一时刻最多允许未确认字节压在网络上，其余滞留 outbox。 */
  readonly sendWindowBytes?: number;
  /** outbox 上限：只用于兜底「客户端彻底不发 ack」的死会话。 */
  readonly maxOutboxBytes?: number;
  readonly maxOutboxCount?: number;
  /** 拥塞信号（滞回）：超过 high 暂停上游生产，消化到 low 以下恢复。 */
  readonly congestionHighBytes?: number;
  readonly congestionLowBytes?: number;
  readonly onCongestionChange?: CongestionChangeListener;
  /** 宽限期用尽仍未重连时回调（上层销毁会话）。 */
  readonly onExpire?: (session: ResumableSession) => void;
}

interface OutboxItem {
  readonly seq: number;
  readonly data: Uint8Array;
}

export class ResumableSession {
  readonly cid: string;
  private readonly logger: Pick<Console, "info" | "warn" | "error" | "debug">;
  private readonly graceMs: number;
  private readonly sendWindowBytes: number;
  private readonly maxOutboxBytes: number;
  private readonly maxOutboxCount: number;
  private readonly congestionHighBytes: number;
  private readonly congestionLowBytes: number;
  private readonly onCongestionChange?: CongestionChangeListener;
  private readonly onExpire: (session: ResumableSession) => void;

  private ws: WebSocket | null = null;
  private dead = false; // 已判定不可恢复
  private deadReason = "";
  private disposed = false;
  private sentSeq = 0; // 本端已发出的二进制帧总数
  private recvSeq = 0; // 本端已收到的二进制帧总数
  private readonly outbox: OutboxItem[] = []; // 尚未被对端确认的出站帧
  private outBytes = 0;
  attachCount = 0;
  private readonly createdAt = Date.now();
  private lastActiveAt = Date.now();

  private readonly _onData = new Emitter<ResumableMessageEvent>();
  /** 上层（SocketProtocol）订阅入站二进制帧。 */
  readonly onData = this._onData.event;

  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private ackTimer: ReturnType<typeof setInterval> | null = null;
  private ackedAt = 0;
  private sentIdx = 0; // outbox 中前 sentIdx 帧已压入当前 socket（未被 ack）
  private sentBytes = 0; // 上述帧的总字节数

  constructor(opts: ResumableSessionOptions) {
    this.cid = opts.cid;
    this.logger = opts.logger ?? console;
    this.graceMs = opts.graceMs ?? 10 * 60 * 1000;
    this.sendWindowBytes = opts.sendWindowBytes ?? 4 * 1024 * 1024;
    // outbox 需要能完整装下一个大对话的全量订阅快照（实测可达 24MB+），64MB 留出余量；
    // 上限只用于兜底「客户端彻底不发 ack」的死会话，正常会话靠发送窗口限流。
    this.maxOutboxBytes = opts.maxOutboxBytes ?? 64 * 1024 * 1024;
    this.maxOutboxCount = opts.maxOutboxCount ?? 8000;
    this.congestionHighBytes = opts.congestionHighBytes ?? 16 * 1024 * 1024;
    this.congestionLowBytes = opts.congestionLowBytes ?? 8 * 1024 * 1024;
    this.onCongestionChange = opts.onCongestionChange;
    this.onExpire = opts.onExpire ?? (() => {});
  }

  /** 当前是否已接入可用 socket。 */
  get isAttached(): boolean {
    return this.ws !== null && this.ws.readyState === this.ws.OPEN;
  }

  /** 拥塞状态（只读视图，供上层决定是否暂停上游生产）。 */
  get congested(): boolean {
    return this._congested;
  }

  private _congested = false;

  /**
   * 接管一条新 socket。
   * @param clientRecv 客户端声明「我已收到 N 个二进制帧」
   * @param isNew 本会话刚创建（首连）：hello.resumed=false，但会话本身完全可用
   * @returns ok=false 表示会话已无法继续，调用方应销毁它（客户端会整页重载）。
   */
  attach(ws: WebSocket, clientRecv: number, isNew = false): AttachResult {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.disposed) {
      this.closeSocket(ws);
      return { ok: false, resumed: false, reason: "disposed" };
    }

    // 旧 socket 可能还是「半开」的僵尸，先踢掉，避免两个 socket 同时写同一会话。
    if (this.ws && this.ws !== ws) {
      const old = this.ws;
      this.ws = null;
      this.closeSocket(old);
    }

    let ok = !this.dead;
    let reason = this.dead ? this.deadReason : "";

    if (ok && !isNew) {
      // 对端已确认收到 clientRecv 帧 → 这些可以丢；剩下的必须能连续重放。
      this.dropAcked(clientRecv);
      const firstNeeded = clientRecv + 1;
      if (clientRecv > this.sentSeq) {
        ok = false;
        reason = "客户端声明的接收序号超前于服务端发送序号";
      } else if (
        clientRecv < this.sentSeq &&
        (this.outbox.length === 0 || this.outbox[0]?.seq !== firstNeeded)
      ) {
        ok = false;
        reason = "重放缓冲已不含客户端缺失的帧";
      }
    }

    const resumed = ok && !isNew;

    this.ws = ws;
    this.attachCount += 1;
    this.lastActiveAt = Date.now();

    ws.on("message", (data, isBinary) => this.onWsMessage(data, isBinary));
    ws.on("close", () => {
      if (this.ws === ws) this.detach("socket-close");
    });
    ws.on("error", () => {
      if (this.ws === ws) this.detach("socket-error");
    });

    // 握手必须先于重放：客户端要先知道 server.recv 才能决定自己重放哪些帧。
    this.sendText({ [CTRL.HELLO]: "v1", cid: this.cid, resumed, recv: this.recvSeq, reason: reason || undefined });

    if (!ok) {
      this.markDead(reason || "not-resumable");
      return { ok: false, resumed: false, reason };
    }

    // 重放尚未确认的出站帧。首连时这里通常恰好是 ChannelServer.ready() 的初始化帧。
    // 同样走发送窗口：断线期间堆积的重放帧可能很大，一次性灌出去会再次淹没心跳。
    this.sentIdx = 0;
    this.sentBytes = 0;
    if (this.outbox.length && resumed) {
      this.logger.info?.(
        `[rpc] 会话 ${this.cid} 已恢复，待重放 ${this.outbox.length} 帧 / ${(this.outBytes / 1024).toFixed(0)}KB（客户端 recv=${clientRecv}，服务端 sent=${this.sentSeq}，按 ${Math.round(this.sendWindowBytes / 1048576)}MB 窗口限速发送）`,
      );
    }
    this.pump();
    this.startAckTimer();
    return { ok: true, resumed };
  }

  detach(reason: string): void {
    if (this.disposed) return;
    const ws = this.ws;
    this.ws = null;
    this.closeSocket(ws);
    this.stopAckTimer();
    if (this._congested) this.setCongested(false); // 断线的会话不再压制上游生产
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.logger.info?.(
        `[rpc] 会话 ${this.cid} 宽限期(${Math.round(this.graceMs / 1000)}s)内未重连，销毁`,
      );
      this.onExpire(this);
    }, this.graceMs);
    if (typeof this.graceTimer.unref === "function") this.graceTimer.unref();
    this.logger.info?.(
      `[rpc] 会话 ${this.cid} 已断开(${reason})，保活 ${Math.round(this.graceMs / 1000)}s 等待重连`,
    );
  }

  dispose(reason = "dispose"): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.stopAckTimer();
    const ws = this.ws;
    this.ws = null;
    this.closeSocket(ws);
    this.outbox.length = 0;
    this.outBytes = 0;
    this.sentIdx = 0;
    this.sentBytes = 0;
    if (this._congested) this.setCongested(false);
    this._onData.dispose();
    this.logger.debug?.(`[rpc] 会话 ${this.cid} 已销毁(${reason})`);
  }

  stats(): ResumableSessionStats {
    return {
      cid: this.cid,
      attached: this.isAttached,
      attachCount: this.attachCount,
      sent: this.sentSeq,
      recv: this.recvSeq,
      outbox: this.outbox.length,
      outboxKB: Math.round(this.outBytes / 1024),
      pending: this.outbox.length - this.sentIdx, // 因窗口限流尚未发出的帧
      dead: this.dead,
      ageSec: Math.round((Date.now() - this.createdAt) / 1000),
    };
  }

  // ── ISocket 兼容面（供 SocketProtocol 使用） ─────────────────────────────
  /** ISocket.write：编号后入 outbox，由 pump 按客户端 ack 进度压网。 */
  write(buffer: VSBuffer): void {
    if (this.disposed) return;
    const src = buffer.buffer;
    const bytes = new Uint8Array(src.buffer, src.byteOffset, buffer.byteLength);
    this.sentSeq += 1;
    if (!this.dead) {
      this.outbox.push({ seq: this.sentSeq, data: bytes });
      this.outBytes += bytes.byteLength;
      if (this.outBytes > this.maxOutboxBytes || this.outbox.length > this.maxOutboxCount) {
        // 重放缓冲撑爆：本会话不再可能无损恢复。丢缓冲省内存，标记为 dead，
        // 下次 attach 直接回 resumed:false 让客户端重载。
        this.markDead(
          `重放缓冲溢出 (${(this.outBytes / 1048576).toFixed(1)}MB / ${this.outbox.length} 帧)`,
        );
      } else if (!this._congested && this.isAttached && this.outBytes >= this.congestionHighBytes) {
        this.setCongested(true);
      }
    }
    // 发送窗口限流：帧只进 outbox 编号，实际压网由 pump 按客户端 ack 进度驱动。
    // 曾在这里直接 rawSend：订阅一个大对话的全量快照（24MB+）会一次性灌满 socket，
    // 心跳 PONG 排在数据后面出不去 → 客户端 12s 内无应答强制重连 → resumed:false 整页
    // 重载 → 重新订阅 → 死循环。窗口化后 socket 缓冲最多领先 ack 4MB，PONG 秒回。
    this.pump();
  }

  end(): void {
    this.dispose("protocol-close");
  }

  drain(): Promise<void> {
    return Promise.resolve();
  }

  // ── 内部 ───────────────────────────────────────────────────────────────
  private onWsMessage(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    this.lastActiveAt = Date.now();
    const buf = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data.map((c) => Buffer.from(c)))
        : Buffer.from(data as ArrayBuffer);

    if (!isBinary) {
      this.onTextFrame(buf.toString("utf8"));
      return;
    }

    this.recvSeq += 1;
    // SocketProtocol 期待 VSBuffer（ChunkStream.acceptChunk 直接读 buffer/slice/byteLength），
    // 不能只给裸 Uint8Array。
    this._onData.fire(VSBuffer.wrap(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
    if (this.recvSeq - this.ackedAt >= ACK_EVERY) this.sendAck();
  }

  private onTextFrame(txt: string): void {
    if (!txt || txt[0] !== "{") return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(txt) as Record<string, unknown>;
    } catch {
      return;
    }
    if (obj.__zcodeRpcControl === CTRL_FLOW) {
      // flow-control 帧只用于传输层，不投递给上层协议。
      return;
    }
    if (typeof obj[CTRL.ACK] === "number") {
      this.dropAcked(obj[CTRL.ACK] as number);
      return;
    }
    if (obj[CTRL.PING] !== undefined) {
      this.sendText({ [CTRL.PONG]: obj[CTRL.PING] });
      return;
    }
  }

  private dropAcked(upto: number): void {
    if (!(upto > 0)) return;
    let i = 0;
    let removedBytes = 0;
    while (i < this.outbox.length) {
      const item = this.outbox[i];
      if (!item || item.seq > upto) break;
      removedBytes += item.data.byteLength;
      i++;
    }
    if (i > 0) {
      this.outbox.splice(0, i);
      this.outBytes -= removedBytes;
    }
    if (this.outBytes < 0) this.outBytes = 0;
    if (i > 0) {
      // 被 ack 的帧必然已在当前 socket 上发出过（客户端收不到未发送的帧）。
      this.sentBytes = Math.max(0, this.sentBytes - removedBytes);
      this.sentIdx = Math.max(0, this.sentIdx - i);
      if (this._congested && this.outBytes <= this.congestionLowBytes) this.setCongested(false);
      this.pump(); // 窗口腾出来了，继续发
    }
  }

  private setCongested(v: boolean): void {
    if (this._congested === v) return;
    this._congested = v;
    try {
      this.onCongestionChange?.(v);
    } catch (e) {
      this.logger.error?.("[rpc] 拥塞回调异常（已隔离）:", (e as Error)?.message ?? e);
    }
  }

  /**
   * 发送窗口泵：把 outbox 中未发送的帧压上 socket，直到未确认字节超过 sendWindowBytes。
   * 保底至少保持 ACK_EVERY 帧在途：客户端每收满 32 帧才回一次 ack，若窗口被大帧
   * 提前填满且在途不足 32 帧，客户端永远不回 ack，泵会死锁。
   */
  private pump(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    while (this.sentIdx < this.outbox.length) {
      if (this.sentBytes >= this.sendWindowBytes && this.sentIdx >= ACK_EVERY) break;
      const it = this.outbox[this.sentIdx];
      // 只有真正压网成功才推进游标：socket 在 readyState 检查与 send 之间被踢掉时
      // send 会抛，若照常计数，该帧在当前 socket 生命周期内再也不会被重试
      // （游标已越过它），客户端也永远不会 ack 它 → 缺口帧永久丢失。
      if (!it || !this.rawSend(it.data)) break;
      this.sentIdx += 1;
      this.sentBytes += it.data.byteLength;
    }
  }

  private rawSend(bytes: Uint8Array): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return false; // 未连接 → 已在 outbox 里，重连时重放
    try {
      ws.send(bytes as Buffer, { binary: true });
      return true;
    } catch {
      return false; /* 下次 attach 重放 */
    }
  }

  private sendText(obj: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* noop */
    }
  }

  private sendAck(): void {
    if (this.recvSeq === this.ackedAt) return;
    this.ackedAt = this.recvSeq;
    this.sendText({ [CTRL.ACK]: this.recvSeq });
  }

  private startAckTimer(): void {
    if (this.ackTimer) return;
    this.ackTimer = setInterval(() => this.sendAck(), ACK_INTERVAL_MS);
    if (typeof this.ackTimer.unref === "function") this.ackTimer.unref();
  }

  private stopAckTimer(): void {
    if (this.ackTimer) {
      clearInterval(this.ackTimer);
      this.ackTimer = null;
    }
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.deadReason = reason;
    this.outbox.length = 0;
    this.outBytes = 0;
    this.sentIdx = 0;
    this.sentBytes = 0;
    if (this._congested) this.setCongested(false);
    this.logger.warn?.(`[rpc] 会话 ${this.cid} 不可恢复: ${reason}`);
  }

  private closeSocket(ws: WebSocket | null): void {
    if (!ws) return;
    try {
      ws.removeAllListeners("message");
    } catch {
      /* noop */
    }
    try {
      ws.removeAllListeners("close");
    } catch {
      /* noop */
    }
    try {
      ws.removeAllListeners("error");
    } catch {
      /* noop */
    }
    try {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    } catch {
      /* noop */
    }
  }
}

export interface AttachResult {
  readonly ok: boolean;
  readonly resumed: boolean;
  readonly reason?: string;
}

export interface ResumableSessionStats {
  readonly cid: string;
  readonly attached: boolean;
  readonly attachCount: number;
  readonly sent: number;
  readonly recv: number;
  readonly outbox: number;
  readonly outboxKB: number;
  readonly pending: number;
  readonly dead: boolean;
  readonly ageSec: number;
}

/** ResumableSession 暴露给 SocketProtocol 的 ISocket 适配面。 */
export function resumableSessionAsSocket(session: ResumableSession): ISocket {
  return {
    onData: session.onData,
    onClose: () => ({ dispose() {} }),
    onEnd: () => ({ dispose() {} }),
    write: (buffer: VSBuffer) => session.write(buffer),
    end: () => session.end(),
    drain: () => session.drain(),
    dispose: () => session.dispose("isocket-dispose"),
  };
}
