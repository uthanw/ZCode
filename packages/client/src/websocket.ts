import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
import {
  ResumableWebSocket,
  type ResumableTransportOptions,
} from "./resumableWebSocket.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;

    ws.addEventListener("error", () => {
      if (!settled) {
        reject(new Error(`WebSocket connection failed: ${wsUrl}`));
      }
    });
    ws.addEventListener("close", (event) => {
      options?.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      if (!settled) {
        reject(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      }
    });

    ws.addEventListener("open", () => {
      settled = true;
      options?.onOpenSocket?.(ws);
      const socket = wrapBrowserWebSocket(ws);
      resolve(connectViaProtocol(new SocketProtocol(socket)));
    });
  });
}

export function connectViaProtocol(protocol: IMessagePassingProtocol): IServiceAccessor {
  const client = new ChannelClient(protocol);
  return new RemoteServiceAccess(client);
}

/**
 * 可恢复 WebSocket 连接：底层断开时自动重连并重放未确认帧，ChannelClient 绑定的
 * 端口保持不变（见 resumableWebSocket.ts）。服务端按 cid 保留同一会话的订阅与
 * 进行中请求，重连后整条链路对渲染器透明。
 *
 * 默认在连接彻底无法恢复时整页重载——渲染器持有的订阅已全部失效，假装连上了
 * 会让界面「看起来正常但永不更新」。
 */
export function connectViaResumableWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions & ResumableTransportOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const transport = new ResumableWebSocket(wsUrl, {
      ephemeral: options?.ephemeral,
      onReady: () => {
        if (settled) return;
        settled = true;
        resolve(connectViaProtocol(new SocketProtocol(transport)));
      },
      onUnrecoverable: (reason) => {
        if (settled) {
          // 已建立过的会话不可恢复 → 整页重载是唯一正确语义：渲染器持有的订阅
          // 已全部失效，假装连上了会让界面「看起来正常但永不更新」。
          if (typeof window !== "undefined" && window.location) {
            console.warn(`[rpc] 会话不可恢复（${reason}），重载页面`);
            window.location.reload();
          }
          return;
        }
        reject(new Error(`WebSocket connection unrecoverable: ${reason}`));
      },
    });

    if (typeof window !== "undefined") {
      const kick = (reason: string) => transport.kick(reason);
      window.addEventListener("focus", () => kick("窗口获得焦点"));
      window.addEventListener("online", () => {
        transport.reconnect("网络恢复");
      });
      // 休眠探测：定时器在系统睡眠期间不触发，时钟跳变即可判定「刚醒」
      let lastTick = Date.now();
      window.setInterval(() => {
        const now = Date.now();
        const drift = now - lastTick;
        lastTick = now;
        if (drift > 20000) kick(`时钟跳变 ${Math.round(drift / 1000)}s（疑似休眠唤醒）`);
      }, 5000);
    }
  });
}
