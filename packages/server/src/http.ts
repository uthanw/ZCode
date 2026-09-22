/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { type ReadStream } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
  IProviderProvisioningTargetService,
} from "@zcode/services";
import {
  formatLogPrefix,
  formatZodError,
  remoteTargetSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import { createHostCapabilityStore } from "./hostCapability.js";
import {
  ResumableSession,
  resumableSessionAsSocket,
} from "./resumable.js";
import { UploadRegistry } from "./uploadRegistry.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
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

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

/** 解析 /ws 握手查询参数：cid（会话身份）、recv（客户端已收帧数）、ephemeral（短保活）。 */
function parseWsHandshake(url: string | URL): {
  cid: string | null;
  recv: number;
  ephemeral: boolean;
} {
  try {
    // @hono/node-ws 的 ctx.url 已经是绝对 URL；裸字符串则按相对路径解析。
    const { searchParams } =
      typeof url === "string" ? new URL(url, "http://localhost") : url;
    const cid = searchParams.get("cid");
    const recvRaw = searchParams.get("recv");
    const recv = Number.isFinite(Number(recvRaw)) ? Math.max(0, Number(recvRaw)) : 0;
    const ephemeral = searchParams.get("ephemeral") === "1";
    return { cid, recv, ephemeral };
  } catch {
    return { cid: null, recv: 0, ephemeral: false };
  }
}

/**
 * Web RPC 会话存储：cid → （ResumableSession + ChannelServer + 连接级资源）。
 *
 * 与桌面/trusted-host 路径不同：浏览器渲染器只在启动时收一次 ServicePort，
 * 之后 ChannelClient 永久绑定在该端口上，重连只能换底层 WebSocket 而不能换端口。
 * 因此把「WS 连接」与「RPC 会话」解耦：ChannelServer 存活在会话里，
 * 断线时 detach（宽限期继续缓冲出站帧），重连时 attach 并重放缺口。
 * 宽限期用尽时把 ChannelServer 与连接级 scope 一并释放。
 */
class WebRpcSessionStore {
  private readonly sessions = new Map<string, ResumableSession>();
  private readonly disposers = new Map<string, () => void>();
  private readonly graceMs: number;
  private readonly ephemeralGraceMs: number;

  constructor(opts?: { graceMs?: number; ephemeralGraceMs?: number }) {
    this.graceMs = opts?.graceMs ?? 10 * 60 * 1000;
    this.ephemeralGraceMs = opts?.ephemeralGraceMs ?? 15 * 1000;
  }

  get size(): number {
    return this.sessions.size;
  }

  attach(
    cid: string,
    ws: WebSocket,
    clientRecv: number,
    ephemeral: boolean,
    services: ServiceCollection,
    clientMode: "desktop-continuous" | "web-remote-replayable",
    attachmentResolver?: (attachments: unknown) => Promise<unknown>,
  ): { resumed: boolean; ok: boolean; reason?: string } {
    const existing = this.sessions.get(cid);
    const isNew = !existing;
    const session = isNew
      ? new ResumableSession({
          cid,
          logger: console,
          graceMs: ephemeral ? this.ephemeralGraceMs : this.graceMs,
          onExpire: (s) => this.expire(s.cid),
        })
      : existing;
    if (isNew) this.sessions.set(cid, session);
    const result = session.attach(ws, clientRecv, isNew);
    if (!result.ok) {
      // 不可恢复的会话直接回收，避免僵尸条目常驻。
      this.expire(cid);
      return result;
    }
    if (isNew) {
      // 首连时创建 ChannelServer 与连接级资源；重连时全部复用。
      const { rawServer, connectionScope } = this.createServer(
        session,
        services,
        clientMode,
        attachmentResolver,
      );
      this.disposers.set(cid, () => {
        void connectionScope?.dispose();
        rawServer.dispose();
      });
    }
    return result;
  }

  private createServer(
    session: ResumableSession,
    services: ServiceCollection,
    clientMode: "desktop-continuous" | "web-remote-replayable",
    attachmentResolver?: (attachments: unknown) => Promise<unknown>,
  ) {
    const socket = resumableSessionAsSocket(session);
    const protocol = new SocketProtocol(socket);
    const rawServer = new ChannelServer(protocol, "server");
    // 用日志中间件包装，统一记录所有 RPC 调用
    const server = new LoggingChannelServer(rawServer, log);
    const agentService = services.getOptional(IZCodeAgentService);
    const connectionScope = agentService
      ? createZCodeAgentConnectionScope(agentService, {
          connectionId: `server-ws-${randomUUID()}`,
          clientMode,
          role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
          resolveAttachmentRefs: attachmentResolver,
        })
      : undefined;
    const overrides = new Map<string, unknown>();
    if (connectionScope) {
      overrides.set(IZCodeAgentService.channelName, connectionScope.service);
    }
    // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
    // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
    if (
      clientMode !== "desktop-continuous" &&
      services.getOptional(IProviderProvisioningTargetService)
    ) {
      overrides.set(IProviderProvisioningTargetService.channelName, {
        apply: async () => {
          throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
        },
      });
    }
    services.exposeOnChannelServer(server, overrides);
    return { rawServer, connectionScope };
  }

  private expire(cid: string): void {
    const session = this.sessions.get(cid);
    const dispose = this.disposers.get(cid);
    this.sessions.delete(cid);
    this.disposers.delete(cid);
    dispose?.();
    session?.dispose("grace-expired");
    log(
      `[rpc] RPC 会话已回收 cid=${cid}（宽限期结束），剩余 ${this.sessions.size} 个`,
    );
  }

  disposeAll(reason = "shutdown"): void {
    for (const [cid, session] of this.sessions) {
      this.disposers.get(cid)?.();
      session.dispose(reason);
    }
    this.sessions.clear();
    this.disposers.clear();
  }
}

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  attachmentResolver?: (attachments: unknown) => Promise<unknown>,
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
        resolveAttachmentRefs: attachmentResolver,
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<string, RemoteConnection>();

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * 注册 Web 端文件上传的 HTTP 端点（乐观路径）。
 *
 * 渲染器拖入文件时 getPathForFile 同步返回预测落盘路径，随后异步把字节发到这些端点；
 * sendText 转发前由 resolveAttachmentRefs 把注册路径替换为真实磁盘路径（见
 * uploadRegistry.ts）。端点设计保持与 zcode-web-next 垫片兼容：
 *   POST /upload-register?name=&size=&token=   预登记 + 写占位（防「路径不存在」空窗）
 *   POST /upload-dedupe?token=                 内容寻址秒传查询（命中则零字节结算）
 *   POST /upload?token=&name=&size=&sha256=    流式落地（边写边算哈希）
 *   POST /upload-failed?token=                 失败回写占位（幂等兜底）
 *   GET  /uploads/:token                       下载已落地文件（预览/重发用）
 */
function registerUploadRoutes(
  app: Hono,
  registry: UploadRegistry,
  _authToken?: string,
): void {
  app.post("/upload-register", async (c) => {
    const name = c.req.query("name") ?? undefined;
    const token = c.req.query("token") ?? undefined;
    const sizeRaw = c.req.query("size");
    const size = sizeRaw === undefined ? undefined : Number(sizeRaw);
    const result = await registry.registerEndpoint(name, token, size);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post("/upload-dedupe", async (c) => {
    const token = c.req.query("token") ?? undefined;
    const body = await c.req.json().catch(() => ({}));
    const result = await registry.dedupeCheck(token, {
      sha256: String(body.sha256 ?? ""),
      bytes: Number(body.bytes ?? 0),
      mime: body.mime,
      fileName: body.fileName,
    });
    // false = 未命中秒传，客户端继续正常上传
    return c.json(result === false ? { ok: false, deduped: false } : result);
  });

  app.post("/upload", async (c) => {
    const token = c.req.query("token") ?? undefined;
    const name = c.req.query("name") ?? undefined;
    const sizeRaw = c.req.query("size");
    const sha256 = c.req.query("sha256") ?? undefined;
    const mime = c.req.header("content-type") ?? undefined;
    const size = Number(sizeRaw ?? 0);
    if (!Number.isFinite(size) || size < 0) {
      return c.json({ ok: false, error: "bad_size" }, 400);
    }
    const rawBody = c.req.raw.body;
    if (!rawBody) {
      return c.json({ ok: false, error: "no_body" }, 400);
    }
    // Web ReadableStream → Node Readable：settle 内部用 data 事件与 pipe。
    // （settle 的入参类型按 fs.ReadStream 声明，此处只用到 data/error/pipe，
    // fromWeb 产物完全满足，用窄转换避免引入 fs 依赖。）
    const stream = Readable.fromWeb(rawBody as ReadableStream<Uint8Array>) as unknown as ReadStream;
    const result = await registry.settle(
      token,
      { stream, bytes: size, mime, fileName: name, sha256 },
      c.req.header("x-forwarded-for") ?? "local",
    );
    return c.json(result, result.error ? 400 : 200);
  });

  app.post("/upload-failed", async (c) => {
    const token = c.req.query("token") ?? "";
    const reason = c.req.query("reason") ?? "client-reported";
    await registry.markFailed(token, reason);
    return c.json({ ok: true });
  });

  app.get("/uploads/:token", async (c) => {
    const token = c.req.param("token");
    const path = registry.getSettledPath(token);
    if (!path) {
      return c.json({ error: "not_found" }, 404);
    }
    try {
      const data = await readFile(path);
      return new Response(data, {
        headers: { "content-type": "application/octet-stream" },
      });
    } catch {
      return c.json({ error: "read_failed" }, 500);
    }
  });
}

interface HttpServerOptions {
  serverId?: string;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveServerId(options: HttpServerOptions): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ZCODE_SERVER_ID") || hostname() || "zcode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ZCODE_SERVER_NAME") }
      : {}),
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? Boolean(readTrimmedEnv("ZCODE_SERVER_TOKEN")),
    workspaces: resolveServerWorkspaces(options),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };
}

const zcodeLiteTokenCookieName = "zcode_lite_token";

// 登录门户页：与旧垫片（zcode-web-next）等价的入口，未认证浏览器请求 302 到此。
// 页面零依赖，POST /login 校验 token 后种 HttpOnly cookie。
// ESM bundle 里没有 __dirname（tsup 不注入），用 import.meta.url 定位包根。
const loginHtmlPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "inject",
  "login.html",
);
let loginHtmlCache: string | null = null;
async function renderLoginPage(): Promise<string> {
  // inject 目录随 npm 包发布；dist 里运行时上一级才是包根。
  if (loginHtmlCache === null) {
    loginHtmlCache = await readFile(loginHtmlPath, "utf8");
  }
  return loginHtmlCache;
}

/** 浏览器导航请求（非 fetch/XHR）→ 跳登录页；其余保持 401 JSON 语义。 */
function wantsLoginPage(c: Context): boolean {
  const pathname = new URL(c.req.url).pathname;
  // API/WS/上传端点永远保持 JSON 401，客户端代码依赖状态码而非跳转。
  if (pathname.startsWith("/api/") || pathname.startsWith("/ws") || isUploadPath(pathname)) {
    return false;
  }
  if (c.req.header("accept")?.includes("text/html")) return true;
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    (!extname(pathname) && !c.req.header("authorization"))
  );
}

/** 门户页提交的 token：JSON 与 urlencoded 两种格式都取。 */
async function readLoginBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const parsed = (await c.req.json()) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    }
    const form = await c.req.parseBody();
    if (form instanceof FormData) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) out[key] = value;
      return out;
    }
    return form as Record<string, unknown>;
  } catch {
    return {};
  }
}

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function hasValidLiteToken(c: Context, token: string): boolean {
  const url = new URL(c.req.url);
  // 上传路由的 ?token= 是上传注册表的内容寻址 token，与鉴权 token 同名不同义：
  // 这些路径只认 cookie，避免把上传 token 误当作鉴权通过。
  if (!isUploadPath(url.pathname) && url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

// /upload、/upload-register、/upload-dedupe、/upload-failed、/uploads/:token
// 统一以 /upload 开头；静态产物都在 /assets 下，不会误伤。
function isUploadPath(pathname: string): boolean {
  return pathname.startsWith("/upload");
}

// 分享页（/share/*、/cn/share/*）走独立的分享码鉴权，不占用访问令牌，
// 否则公开分享链接也会被挡在登录门户外。
function isSharePath(pathname: string): boolean {
  return (
    pathname === "/share" ||
    pathname.startsWith("/share/") ||
    pathname === "/cn/share" ||
    pathname.startsWith("/cn/share/")
  );
}

function isTokenProtectedPath(pathname: string): boolean {
  if (pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/")) {
    return true;
  }
  // 上传端点能往工作区写文件，公网暴露时必须鉴权（垫片时代也是如此）。
  if (isUploadPath(pathname)) return true;
  // 工作台入口本身也保护：否则未认证用户拿到 index.html，JS 启动后 /api 才 401，
  // 页面停在 bootstrap 错误屏而不是登录门户。分享页不在此列（见 isSharePath）。
  if (isSharePath(pathname)) return false;
  return pathname === "/" || pathname === "/index.html";
}

// SPA fallback 只对页面路径开放：API/WS/上传端点有自己的 404 语义，
// 不能回退到 index.html（会把 JSON 调用变成 HTML 响应）。
function isStaticFallbackAllowed(pathname: string): boolean {
  return (
    !pathname.startsWith("/api/") &&
    !pathname.startsWith("/ws") &&
    !isUploadPath(pathname)
  );
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();

  const authToken = options.authToken?.trim();
  if (authToken) {
    // 登录门户（/login GET 渲染页面、POST 提交 token 换 cookie）与登出本身必须免鉴权，
    // 否则未认证用户连门户页都看不到，形成死循环。
    app.get("/login", async (c) => {
      if (hasValidLiteToken(c, authToken)) return c.redirect("/", 302);
      return c.html(await renderLoginPage(), 200, { "cache-control": "no-store" });
    });
    app.post("/login", async (c) => {
      // Hono 的 parseBody 只吃 form-data / urlencoded，门户页前端发的是 JSON，
      // 这里统一从原始 body 里取 token 字段（两种格式都支持，无 JS 降级表单也能用）。
      const body = await readLoginBody(c);
      const token = String(body.token ?? "").trim();
      if (token && token === authToken) {
        return c.json({ ok: true }, 200, {
          "set-cookie": `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          "cache-control": "no-store",
        });
      }
      return c.json({ ok: false, error: "令牌无效，请检查后重试" }, 401, { "cache-control": "no-store" });
    });
    app.get("/logout", (c) => {
      c.header("set-cookie", `${zcodeLiteTokenCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return c.redirect("/login", 302);
    });

    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      const validToken = hasValidLiteToken(c, authToken);
      if (!isTokenProtectedPath(pathname) || validToken) {
        await next();
        return;
      }
      // 浏览器导航请求（Accept: text/html 或无扩展名的页面路径）跳门户页；
      // fetch/XHR 与脚本保持 401 JSON 语义。
      if (wantsLoginPage(c)) return c.redirect("/login", 302);
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  app.get("/api/server-info", (c) => c.json(createServerInfo(options)));
  app.post("/api/rpc-host-capability", (c) => c.json(hostCapabilities.issue()));

  // Web 端可恢复 RPC 会话：渲染器只在启动时收一次 ServicePort，重连只能换底层
  // WebSocket。会话按 cid 常驻，ChannelServer 的订阅与进行中请求在重连后原样保留。
  const sessionStore = new WebRpcSessionStore();
  // 文件上传注册表（乐观路径 + 内容寻址秒传），落盘到主工作区下的 .uploads/。
  // 必须与 /api/server-info 报给客户端的 workspace 完全一致——客户端据此构造
  // getPathForFile 的预测路径，不一致会让乐观路径的占位与真实落盘路径对不上。
  const primaryWorkspacePath = resolveServerWorkspaces(options)[0]?.path;
  const uploadRegistry = new UploadRegistry({
    workspaceRoot: primaryWorkspacePath ?? process.cwd(),
    logger: console,
  });
  uploadRegistry.start();
  registerUploadRoutes(app, uploadRegistry, authToken);
  // sendText 转发前把注册引用替换为真实落盘路径（乐观路径闸门）。
  const attachmentResolver = (attachments: unknown) =>
    uploadRegistry.resolveAttachmentRefs(attachments);

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(event, ws) {
        // 有 cid 查询参数 → 走可恢复会话；无 cid 的旧客户端退化为一次一会。
        // @hono/node-ws 的 onOpen(evt, ctx)：第一个参数是裸 Event，带 URL 的
        // WSContext 是第二个参数（即这里的 ws）。
        const handshake = parseWsHandshake(
          (ws as unknown as { url?: string | URL } | undefined)?.url ?? "",
        );
        if (handshake.cid) {
          const r = sessionStore.attach(
            handshake.cid,
            ws.raw as WebSocket,
            handshake.recv,
            handshake.ephemeral,
            services,
            "web-remote-replayable",
            attachmentResolver,
          );
          if (r.ok) {
            log(
              r.resumed
                ? `[rpc] RPC 客户端已重连 cid=${handshake.cid}`
                : `[rpc] RPC 客户端已连接 cid=${handshake.cid}`,
            );
          } else {
            log(`[rpc] 会话 ${handshake.cid} 无法恢复: ${r.reason ?? "unknown"}`);
          }
          return;
        }
        setupChannelServer(
          ws.raw as WebSocket,
          services,
          "web-remote-replayable",
          attachmentResolver,
        );
      },
    })),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      // Desktop trusted host 走本地零拷贝，不需要上传闸门。
      setupChannelServer(ws.raw as WebSocket, services, "desktop-continuous");
    },
  }));
  app.use("/ws/host", async (c, next) => {
    const capability = c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER);
    if (!hostCapabilities.consume(capability)) {
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  // Web 模式下发起远程连接
  app.post("/api/connect-remote", async (c) => {
    const rawBody = await c.req.json();
    const parsedBody = remoteTargetSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    const body = parsedBody.data;

    try {
      const backend = await createRemoteBackend(body);
      const connection = await connectRemote(backend);
      const id = generateId();
      remoteConnections.set(id, connection);

      return c.json({ id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器
  app.get(
    "/ws/remote/:id",
    upgradeWebSocket((c) => {
      const id = c.req.param("id");
      return {
        onOpen(_event, ws) {
          if (!id) {
            ws.close(4000, "Missing remote connection id");
            return;
          }
          const connection = remoteConnections.get(id);
          if (!connection) {
            ws.close(4004, "Remote connection not found");
            return;
          }
          // 一个连接只给一个 WS 客户端使用，取出后从 Map 移除
          remoteConnections.delete(id);

          // 将远程 services 包装为 ServiceCollection，复用 exposeOnChannelServer 统一注册
          const remoteServices = new ServiceCollection()
            .register(IFileService, connection.services.fileService)
            .register(IGitService, connection.services.gitService)
            .register(ISystemService, connection.services.systemService)
            .register(ITerminalService, connection.services.terminalService);

          setupChannelServer(ws.raw as WebSocket, remoteServices, "web-remote-replayable");
        },
      };
    }),
  );

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  const server = serve({ fetch: app.fetch, hostname: options.host, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    const listenHost = options.host?.trim() || "localhost";
    log(`http://${listenHost}:${listenPort}`);
  });

  injectWebSocket(server);

  return server;
}
