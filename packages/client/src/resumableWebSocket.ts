/* eslint-disable max-lines -- 帧编号/重放/半开检测是一个状态机整体，拆分会破坏可读性 */
/**
 * 可恢复 WebSocket 传输（客户端侧，从 zcode-web-next 垫片 port-shim.js 移植）。
 *
 * 背景：渲染器只在启动时收一次 ServicePort，ChannelClient 永久绑定在该端口上；
 * 重连只能换底层 WebSocket，不能换端口。服务端按 cid 保留同一个 ChannelServer
 * （见 packages/server/src/resumable.ts），本模块负责：
 *  - 维持一个稳定的 ISocket 面给 SocketProtocol，底层 WS 随便换；
 *  - 双向给二进制帧编号，握手时交换「我已收到 N 帧」，各自重放缺口；
 *  - 半开检测（TCP 连着但字节已丢）与业务层探活。
 *
 * 序号机制不能省：合盖/切后台后 TCP 常处于半开状态——readyState 还是 OPEN、
 * send() 不报错、字节却已丢失，没有序号核对就会静默丢响应，渲染器的
 * Promise 永久挂起。
 */
import {
  Emitter,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";

const CTRL = {
  HELLO: "__zcodeRpcHello",
  ACK: "__zcodeRpcAck",
  PING: "__zcodeRpcPing",
  PONG: "__zcodeRpcPong",
} as const;

const CTRL_FLOW = "connection-flow-v1";

const BACKOFF = [400, 900, 1800, 3200, 5000, 8000, 12000, 20000];
const PING_INTERVAL_MS = 25000;
const PONG_TIMEOUT_MS = 12000;
const WAKE_PONG_TIMEOUT_MS = 5000;
const HELLO_TIMEOUT_MS = 15000;
const ACK_EVERY = 32;
const MAX_OUT_BYTES = 8 * 1024 * 1024;
const MAX_OUT_COUNT = 4000;

export interface ResumableTransportOptions {
  /** 透明 1 跳（反代）时给调用方回报状态变化。 */
  onStateChange?: (state: ResumableTransportState, info?: TransportStateInfo) => void;
  /** 首次握手成功（HELLO 收到）时回调一次——调用方据此 resolve 启动 Promise。 */
  onReady?: () => void;
  /** 每次连接建立（含重连）时回调。 */
  onAttached?: (info: { resumed: boolean }) => void;
  /** 会话不可恢复时的最终回调（调用方一般整页重载）。 */
  onUnrecoverable?: (reason: string) => void;
  /** 查询页面 URL 参数（token / ephemeral 透传）。 */
  ephemeral?: boolean;
}

export type ResumableTransportState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "unrecoverable";

export interface TransportStateInfo {
  attempts?: number;
  reason?: string;
}

interface OutboxItem {
  readonly seq: number;
  readonly data: Uint8Array;
}

/**
 * 一个可恢复的 ISocket：SocketProtocol 拿到的是稳定实例，底层 WebSocket 断开时
 * 自动重连并重放未确认的出站帧，上层完全无感。
 */
export class ResumableWebSocket implements ISocket {
  private readonly cid: string;
  private readonly wsUrl: string;
  private readonly options: ResumableTransportOptions;

  private ws: WebSocket | null = null;
  private state: ResumableTransportState = "connecting";
  private established = false; // 传输层会话已建立过（决定 resumed 判定与「恢复失败即重载」）
  private stopped = false; // 已判定不可恢复，停止一切重连
  private attempts = 0;
  private sentSeq = 0;
  private recvSeq = 0;
  private lastAckSent = 0;
  private outbox: OutboxItem[] = [];
  private outBytes = 0;
  private lossy = false; // 出站缓冲溢出 → 本会话不再可无损恢复

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline = 0;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private helloSeen = false;

  // 服务端在 HELLO 之后立即投递 ChannelServer 的 Initialize 帧；客户端这边
  // onReady/onAttached 回调与 SocketProtocol 订阅 onData 存在竞争，订阅完成前
  // 到达的数据帧必须先缓存，否则被静默丢弃、ChannelClient 永久卡在握手。
  private earlyFrames: VSBuffer[] = [];
  private hasDataListener = false;
  private readonly _onData = new Emitter<VSBuffer>({
    onWillAddFirstListener: () => {
      this.hasDataListener = true;
      this.flushEarlyFrames();
    },
  });
  private readonly _onClose = new Emitter<void>();
  private readonly _onEnd = new Emitter<void>();

  constructor(wsUrl: string, options: ResumableTransportOptions = {}) {
    this.wsUrl = wsUrl;
    this.options = options;
    this.cid = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.connect();
  }

  // ── ISocket 面（供 SocketProtocol 使用） ──

  private flushEarlyFrames(): void {
    // 必须 defer：onWillAddFirstListener 在 SocketProtocol 构造里触发，而
    // ChannelClient 要等构造完才订阅 protocol.onMessage。同步 flush 会让
    // Initialize 帧在 ChannelClient 订阅前被消费，握手永久卡住。
    const frames = this.earlyFrames;
    this.earlyFrames = [];
    if (frames.length === 0) return;
    queueMicrotask(() => {
      for (const frame of frames) this._onData.fire(frame);
    });
  }

  readonly onData = this._onData.event;
  readonly onClose = this._onClose.event;
  readonly onEnd = this._onEnd.event;

  write(buffer: VSBuffer): void {
    // 复制一份独立副本：原始 VSBuffer 可能是更大缓冲区的一个视图（wrap/subarray），
    // 重放时不能依赖调用方继续持有那块内存
    const src = buffer.buffer;
    const start = src.byteOffset;
    const bytes = new Uint8Array(src.buffer.slice(start, start + buffer.byteLength));
    this.sentSeq += 1;
    if (!this.lossy) {
      this.outbox.push({ seq: this.sentSeq, data: bytes });
      this.outBytes += bytes.byteLength;
      if (this.outBytes > MAX_OUT_BYTES || this.outbox.length > MAX_OUT_COUNT) {
        this.lossy = true;
        this.outbox = [];
        this.outBytes = 0;
        console.warn("[rpc] 出站重放缓冲溢出，本会话不再可无损恢复");
      }
    }
    this.rawSend(bytes);
  }

  end(): void {
    this.dispose("protocol-close");
  }

  drain(): Promise<void> {
    return Promise.resolve();
  }

  dispose(reason = "dispose"): void {
    this.stopped = true;
    this.clearTimers();
    const old = this.ws;
    this.ws = null;
    this.teardownSocket(old);
    this.outbox = [];
    this.outBytes = 0;
    console.info(`[rpc] 传输已销毁 cid=${this.cid} reason=${reason}`);
  }

  // ── 状态 ──

  get readyState(): number {
    return this.ws?.readyState ?? -1;
  }

  get stats() {
    return {
      cid: this.cid,
      state: this.state,
      established: this.established,
      attempts: this.attempts,
      sent: this.sentSeq,
      recv: this.recvSeq,
      outbox: this.outbox.length,
      outKB: Math.round(this.outBytes / 1024),
      lossy: this.lossy,
      readyState: this.readyState,
    };
  }

  /** 手动触发重连（调试/测试出口）。 */
  reconnect(reason = "manual"): void {
    this.forceReconnect(reason);
  }

  // ── 内部 ──

  private setState(next: ResumableTransportState, info?: TransportStateInfo): void {
    if (this.state === next && !info) return;
    this.state = next;
    try {
      this.options.onStateChange?.(next, info);
    } catch {
      // 状态回调失败不影响传输本身
    }
  }

  private rawSend(data: Uint8Array): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      // 本仓 DOM lib 的 send 重载只认 BufferSource；传 Uint8Array 需按底层
      // ArrayBuffer 投递（与 wrapBrowserWebSocket 的写法保持一致）
      this.ws.send(data.buffer as ArrayBuffer);
      return true;
    } catch {
      return false;
    }
  }

  private sendText(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      // socket 半开时 send 抛错，交给 onclose 重连
    }
  }

  private sendAck(): void {
    if (this.recvSeq === this.lastAckSent) return;
    this.lastAckSent = this.recvSeq;
    this.sendText({ [CTRL.ACK]: this.recvSeq });
  }

  private dropAcked(upto: number): void {
    if (!(upto > 0)) return;
    let i = 0;
    while (i < this.outbox.length) {
      const item = this.outbox[i] as OutboxItem;
      if (item.seq > upto) break;
      this.outBytes -= item.data.byteLength;
      i++;
    }
    if (i > 0) this.outbox.splice(0, i);
    if (this.outBytes < 0) this.outBytes = 0;
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearRetry();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      this.teardownSocket(old);
    }
    if (this.state !== "connected") this.announceRetry();

    const url = new URL(this.wsUrl, window.location.href);
    url.searchParams.set("cid", this.cid);
    url.searchParams.set("recv", String(this.recvSeq));
    url.searchParams.set("new", this.established ? "0" : "1");
    if (this.options.ephemeral) url.searchParams.set("ephemeral", "1");
    // 透传页面可能携带的鉴权 token（与官方 /ws 鉴权同源）
    const pageToken = new URLSearchParams(window.location.search).get("token");
    if (pageToken) url.searchParams.set("token", pageToken);

    let sock: WebSocket;
    try {
      sock = new WebSocket(url.toString());
    } catch (e) {
      console.error("[rpc] WebSocket 构造失败:", (e as Error)?.message);
      this.scheduleRetry();
      return;
    }
    sock.binaryType = "arraybuffer";
    this.ws = sock;
    this.helloSeen = false;
    // 上一条连接残留的早到帧对这条连接无效（SocketProtocol 的订阅跨重连保留，
    // hasDataListener 无需重置）
    this.earlyFrames = [];

    sock.addEventListener("open", () => {
      // 连上但握手迟迟不来 = 坏连接（中间代理吞包），主动换一条
      this.clearHelloTimer();
      this.helloTimer = setTimeout(() => {
        if (this.ws === sock && !this.helloSeen) this.forceReconnect("握手超时");
      }, HELLO_TIMEOUT_MS);
    });

    sock.addEventListener("message", (event) => {
      // 任何入站帧都证明链路活着。下载大对话快照期间心跳 PONG 可能排在数据帧后面，
      // 若只认 PONG 会误判「心跳无应答」触发重连，进而 resumed:false 整页重载死循环。
      this.pongDeadline = 0;
      const data = event.data;
      if (typeof data === "string") {
        this.onTextFrame(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        this.recvSeq += 1;
        // SocketProtocol 判定 `e.data instanceof Uint8Array`，必须投递 Uint8Array
        const frame = VSBuffer.wrap(new Uint8Array(data));
        if (this.hasDataListener) {
          this._onData.fire(frame);
        } else {
          this.earlyFrames.push(frame);
        }
        if (this.recvSeq - this.lastAckSent >= ACK_EVERY) this.sendAck();
      }
    });

    sock.addEventListener("error", () => {
      // 浏览器只给一个无信息的 error；具体原因在 close 里
    });

    sock.addEventListener("close", (event) => {
      if (this.ws !== sock) return;
      this.ws = null;
      this.stopHeartbeat();
      this.clearHelloTimer();
      console.info(`[rpc] WebSocket 关闭 code=${String(event.code)} reason=${event.reason}`);
      if (this.stopped) return;
      this.scheduleRetry();
    });
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
      // flow-control 帧只用于传输层，不投递给上层协议
      return;
    }
    if (typeof obj[CTRL.ACK] === "number") {
      this.dropAcked(obj[CTRL.ACK] as number);
      return;
    }
    if (obj[CTRL.PONG] !== undefined) {
      this.pongDeadline = 0;
      return;
    }
    if (obj[CTRL.HELLO] !== undefined) {
      this.onHello(obj as Record<string, unknown> & { resumed?: boolean; recv?: number; reason?: string });
    }
  }

  private onHello(hello: {
    resumed?: boolean;
    recv?: number;
    reason?: string;
  }): void {
    this.clearHelloTimer();
    this.helloSeen = true;
    const serverRecv = Number(hello.recv ?? 0);

    // 服务端说恢复不了（会话过期 / 服务重启 / 缓冲溢出）：渲染器手里的订阅全是废的，
    // 只能整页重载。首次连接 resumed 本来就是 false，不能误伤。
    if (hello.resumed === false && this.established) {
      this.markUnrecoverable("会话已过期", hello.reason ?? "server-not-resumable");
      return;
    }
    if (this.lossy && this.established) {
      this.markUnrecoverable("连接数据不完整", "client-outbox-overflow");
      return;
    }

    if (this.established) {
      this.dropAcked(serverRecv);
      const firstOut = this.outbox[0] as OutboxItem | undefined;
      if (
        serverRecv > this.sentSeq ||
        (firstOut !== undefined && firstOut.seq !== serverRecv + 1)
      ) {
        this.markUnrecoverable("连接数据不完整", "client-gap");
        return;
      }
      let replayed = 0;
      for (const item of this.outbox) {
        if (this.rawSend(item.data)) replayed++;
      }
      if (replayed) {
        console.info(
          `[rpc] 重连后重放 ${replayed} 个出站帧（服务端 recv=${serverRecv}）`,
        );
      }
    }

    this.attempts = 0;
    const wasEstablished = this.established;
    this.established = true;
    this.startHeartbeat();
    this.sendAck();
    this.setState("connected", { reason: wasEstablished ? "resumed" : "established" });
    // 首次握手成功才回调 onReady（重连不算——accessor 早已交给调用方）
    if (!wasEstablished) {
      try {
        this.options.onReady?.();
      } catch {
        // 回调失败不影响传输
      }
    }
    try {
      this.options.onAttached?.({ resumed: wasEstablished });
    } catch {
      // 同上
    }
  }

  private announceRetry(): void {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.setState("offline", { reason: "offline" });
      return;
    }
    this.setState(
      this.established ? "reconnecting" : "connecting",
      { attempts: this.attempts },
    );
  }

  private teardownSocket(sock: WebSocket | null): void {
    if (!sock) return;
    try {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
    } catch {
      // 已 dead 的 socket 赋值可能抛错
    }
    try {
      if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
        sock.close();
      }
    } catch {
      // 同上
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.attempts += 1;
    this.announceRetry();
    const base = BACKOFF[Math.min(this.attempts - 1, BACKOFF.length - 1)] ?? 20000;
    const delay = base + Math.round(base * 0.25 * Math.random());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private forceReconnect(reason: string): void {
    if (this.stopped) return;
    console.info(`[rpc] 主动重连: ${reason}`);
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      this.teardownSocket(old);
    }
    this.stopHeartbeat();
    this.clearRetry();
    this.attempts = 0;
    this.connect();
  }

  private markUnrecoverable(text: string, reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    console.warn(`[rpc] 无法恢复连接（${reason}），通知上层: ${text}`);
    this.stopHeartbeat();
    this.clearRetry();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      this.teardownSocket(old);
    }
    this.setState("unrecoverable", { reason });
    try {
      this.options.onUnrecoverable?.(reason);
    } catch {
      // 回调失败不重试，避免掩盖原始错误
    }
  }

  // ── 心跳 / 半开检测 ──

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => this.ping(PONG_TIMEOUT_MS), PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.pongDeadline = 0;
  }

  private ping(timeoutMs: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const sock = this.ws;
    this.pongDeadline = Date.now() + timeoutMs;
    this.sendText({ [CTRL.PING]: Date.now() });
    setTimeout(() => {
      if (this.ws !== sock || !this.pongDeadline) return;
      if (Date.now() >= this.pongDeadline) {
        this.forceReconnect("心跳无应答（连接疑似半开）");
      }
    }, timeoutMs + 60);
  }

  private clearHelloTimer(): void {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearRetry();
    this.clearHelloTimer();
    this.stopHeartbeat();
  }

  /**
   * 页面重新活跃时的统一入口：
   *  1) 传输层：断了就立刻重连，看着还连着就发心跳探半开；
   *  2) 业务层由调用方自行重校验（休眠期间后端可能重启过，socket 活着但订阅已空）。
   */
  kick(reason: string): void {
    if (this.stopped) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED) {
      if (this.retryTimer) return; // 马上就要重试了，不叠加
      this.attempts = 0;
      console.info(`[rpc] 唤醒重连: ${reason}`);
      this.connect();
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ping(WAKE_PONG_TIMEOUT_MS);
    }
  }
}
