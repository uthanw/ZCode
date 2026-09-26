/* eslint-disable max-lines -- 上传桥接链路（注册/去重/XHR/占位/引用结算）是一个整体，拆分会破坏可读性 */
/**
 * Web 端文件上传桥接（从 zcode-web-next 垫片 port-shim.js 移植，TypeScript 重写）。
 *
 * 背景：渲染器对拖入文件的处理是**同步**的（`getPathForFile(file)` 无 await），
 * 桌面端靠 Electron preload 直接返回 File.path；Web 端没有文件路径，只能先
 * 返回一个**预测落盘路径**，再异步把字节传到服务器。这就是「乐观路径」：
 *
 *   1. getPathForFile(file) 同步返回
 *      `<serverWorkspace>/.uploads/<token>__<safeName>`，同时 fire-and-forget
 *      POST /upload-register（带 size → 服务端立刻写占位文本，防路径空窗）；
 *   2. 后台 uploadFileSmart：本地算 SHA-256 → POST /upload-dedupe 查秒传 →
 *      命中则零字节结算，未命中则 XHR 流式传字节；
 *   3. 用户点发送时，服务端 sendText 闸门（uploadRegistry.resolveAttachmentRefs）
 *      等待字节真正落盘后才把注册路径替换为真实路径转发给 app-server。
 *
 * 三态完备：
 *   - 上传已完成 → 闸门直接放行真实路径；
 *   - 8s 宽限内完成 → 闸门等到落地再放行（小文件无感）；
 *   - 大文件未完 → 闸门放行占位路径，模型读占位里的阻塞等待命令自己等。
 */
import { hashBlob } from "./sha256Core.js";

const REGISTRY_PREFIX = "/upload-registry/";
const UPLOAD_DIR_NAME = ".uploads";

/** sha256 计算进度回调（loaded/total 字节）。 */
type ProgressFn = (loaded: number, total: number) => void;

type UploadPhase = "hash" | "dedupe" | "register" | "upload";

interface SmartUploadResult {
  path: string;
  token: string;
  deduped: boolean;
  sha256: string | null;
}

let workspaceRoot = "";

/** 由 main.tsx 在拿到 server-info 后注入；getPathForFile 需要它构造预测路径。 */
export function configureWebUpload(config: { workspaceRoot: string }): void {
  if (config.workspaceRoot) workspaceRoot = config.workspaceRoot.replace(/\/+$/, "");
}

// ── SHA-256：Worker 优先，主线程兜底 ──

interface WorkerCallbacks {
  resolve: (hex: string) => void;
  reject: (error: Error) => void;
  progress: ProgressFn;
}

let workerInstance: Worker | null = null;
let workerBroken = false;
let nextWorkerId = 0;
const workerCallbacks = new Map<number, WorkerCallbacks>();

function isWorkerAvailable(): boolean {
  return !workerBroken && typeof Worker !== "undefined";
}

/**
 * 在 Worker 中哈希；Worker 不可用/创建失败时返回 null，调用方回退主线程。
 * 失败是永久的（CSP 拦截 blob worker 等）：标记降级后后续直接走主线程。
 */
function hashViaWorker(blob: Blob, onProgress: ProgressFn): Promise<string> | null {
  if (!isWorkerAvailable()) return null;
  try {
    if (!workerInstance) {
      workerInstance = new Worker(new URL("./sha256Worker.js", import.meta.url), {
        type: "module",
      });
      workerInstance.onmessage = (event: MessageEvent) => {
        const data = event.data as {
          id?: number;
          hex?: string;
          error?: string;
          loaded?: number;
          total?: number;
        } | null;
        if (typeof data?.id !== "number") return;
        const cb = workerCallbacks.get(data.id);
        if (!cb) return;
        if (data.error) {
          workerCallbacks.delete(data.id);
          cb.reject(new Error(`sha256_worker: ${data.error}`));
        } else if (typeof data.hex === "string") {
          workerCallbacks.delete(data.id);
          cb.resolve(data.hex);
        } else if (typeof data.loaded === "number") {
          cb.progress(data.loaded, data.total ?? 0);
        }
      };
      workerInstance.onerror = () => {
        workerBroken = true;
        for (const [, cb] of workerCallbacks) cb.reject(new Error("sha256_worker_error"));
        workerCallbacks.clear();
        try {
          workerInstance?.terminate();
        } catch {
          // 已 dead 的 worker，terminate 抛错无意义
        }
        workerInstance = null;
      };
    }
  } catch {
    workerBroken = true;
    return null;
  }
  const id = ++nextWorkerId;
  return new Promise((resolve, reject) => {
    workerCallbacks.set(id, { resolve, reject, progress: onProgress });
    try {
      workerInstance?.postMessage({ id, blob });
    } catch (error) {
      workerCallbacks.delete(id);
      reject(error as Error);
    }
  });
}

async function hashForUpload(blob: Blob, onProgress: ProgressFn): Promise<string | null> {
  // 1. crypto.subtle（安全上下文）→ hashBlob 内部已优先处理
  // 2. Web Worker（不卡 UI）
  try {
    const viaWorker = hashViaWorker(blob, onProgress);
    if (viaWorker) return await viaWorker;
  } catch (error) {
    console.warn("[web-upload] SHA-256 Worker 失败，回退主线程:", errorMessage(error));
  }
  // 3. 主线程流式实现
  try {
    return await hashBlob(blob, onProgress);
  } catch (error) {
    console.error("[web-upload] SHA-256 计算失败（退回无哈希直传）:", errorMessage(error));
    return null;
  }
}

// ── HTTP 工具 ──

interface FetchError extends Error {
  status?: number;
}

async function httpJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (!response.ok || !json || json.ok === false) {
    const error = new Error(
      `web-bridge ${response.status}: ${String(json?.error ?? text.slice(0, 120))}`,
    ) as FetchError;
    error.status = response.status;
    throw error;
  }
  return json;
}

function uploadUrl(
  token: string,
  name: string,
  size: number,
  mime: string,
  sha256: string | null,
): string {
  const params = new URLSearchParams({
    name,
    size: String(size),
  });
  if (mime) params.set("mime", mime);
  if (sha256) params.set("sha256", sha256);
  return `/upload?token=${encodeURIComponent(token)}&${params.toString()}`;
}

function xhrUpload(
  url: string,
  blob: Blob,
  onProgress?: ProgressFn,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    // 停滞上传不要挂到 TCP 超时为止：15min 下限速率 ≈ 570KB/s（512MB 慢链路）。
    xhr.timeout = 15 * 60 * 1000;
    if (onProgress) {
      xhr.upload.onprogress = (event) => onProgress(event.loaded, event.total || 0);
    }
    xhr.onload = () => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        json = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && json && json.ok !== false) {
        resolve(json);
        return;
      }
      reject(
        Object.assign(
          new Error(
            `web-bridge ${String(xhr.status)}: ${String(json?.error ?? xhr.responseText.slice(0, 100))}`,
          ),
          { status: xhr.status },
        ),
      );
    };
    xhr.onerror = () => reject(new Error("network_error"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    try {
      xhr.send(blob);
    } catch (error) {
      reject(error as Error);
    }
  });
}

// ── 上传指示器（Shadow DOM，不依赖 UI 框架样式） ──

interface UploadUiItem {
  row: HTMLElement;
  fill: HTMLElement;
  state: HTMLElement;
}

const UploadUI = (() => {
  let host: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  const items = new Map<string, UploadUiItem>();

  function ensure(): boolean {
    if (host || !document.body) return Boolean(host);
    host = document.createElement("div");
    host.id = "zcode-upload-indicator";
    host.style.cssText =
      "position:fixed;right:18px;bottom:18px;z-index:2147483646;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif); }
        .list { display: flex; flex-direction: column; gap: 8px; }
        .item {
          width: 260px; padding: 8px 12px 10px; border-radius: 10px;
          color: var(--color-foreground, #e7e7e7);
          background: color-mix(in oklab, var(--color-card, #2b2b2b) 96%, transparent);
          border: 1px solid var(--color-border, rgba(255,255,255,.12));
          box-shadow: 0 12px 32px -12px rgba(0,0,0,.6);
          backdrop-filter: blur(12px);
          font-size: 12px; line-height: 1.4;
          animation: slide-in .25s cubic-bezier(.22,1,.36,1);
        }
        .item[data-state="done"] { animation: fade-out 1.6s ease 1.1s forwards; }
        .item[data-state="error"] { border-color: rgba(255,92,92,.55); }
        @keyframes slide-in { from { opacity: 0; transform: translateY(10px); } }
        @keyframes fade-out { to { opacity: 0; transform: translateY(6px); } }
        .row1 { display: flex; align-items: center; gap: 6px; }
        .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .state { font-size: 11px; color: var(--color-foreground-subtlest, rgba(231,231,231,.55)); font-variant-numeric: tabular-nums; }
        .state.ok { color: #2ecc8f; }
        .state.err { color: #ff5c5c; }
        .state.info { color: #57a9ff; }
        .track { margin-top: 6px; height: 3px; border-radius: 99px;
          background: color-mix(in oklab, var(--color-foreground, #fff) 12%, transparent); overflow: hidden; }
        .fill { height: 100%; width: 0%; border-radius: inherit;
          background: #57a9ff; transition: width .18s ease; }
        .item[data-state="done"] .fill { background: #2ecc8f; width: 100%; }
        .item[data-state="error"] .fill { background: #ff5c5c; }
      </style>
      <div class="list"></div>`;
    list = shadow.querySelector(".list");
    document.body.appendChild(host);
    return true;
  }

  function whenReady(fn: () => void): void {
    if (ensure()) {
      fn();
      return;
    }
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        ensure();
        fn();
      },
      { once: true },
    );
  }

  function formatBytes(bytes: number): string {
    return bytes >= 1048576
      ? `${(bytes / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return {
    begin(token: string, name: string, total: number): void {
      whenReady(() => {
        if (!list || items.has(token)) return;
        const row = document.createElement("div");
        row.className = "item";
        row.dataset.state = "uploading";
        row.innerHTML =
          '<div class="row1"><span class="name"></span><span class="state"></span></div>' +
          '<div class="track"><div class="fill"></div></div>';
        row.querySelector(".name")!.textContent = name;
        const state = row.querySelector(".state") as HTMLElement;
        state.textContent = total ? formatBytes(total) : "";
        list!.appendChild(row);
        items.set(token, {
          row,
          fill: row.querySelector(".fill") as HTMLElement,
          state,
        });
      });
    },
    progress(token: string, loaded: number, total: number): void {
      whenReady(() => {
        const item = items.get(token);
        if (!item) return;
        const pct = total ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
        item.fill.style.width = `${pct}%`;
        item.state.textContent = `${pct}% · ${formatBytes(Math.max(loaded, 0))}`;
      });
    },
    hashProgress(token: string, loaded: number, total: number): void {
      whenReady(() => {
        const item = items.get(token);
        if (!item) return;
        const pct = total ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
        item.fill.style.width = `${pct}%`;
        item.state.textContent = `${t("校验", "hashing")} ${pct}%`;
      });
    },
    deduped(token: string): void {
      whenReady(() => {
        const item = items.get(token);
        if (!item) return;
        item.state.textContent = t("秒传命中", "deduped");
        item.state.className = "state info";
      });
    },
    done(token: string): void {
      whenReady(() => {
        const item = items.get(token);
        if (!item) return;
        item.row.dataset.state = "done";
        item.state.textContent = t("已就绪", "ready");
        item.state.className = "state ok";
        window.setTimeout(() => {
          item.row.remove();
          items.delete(token);
        }, 2800);
      });
    },
    error(token: string, message: string): void {
      whenReady(() => {
        const item = items.get(token);
        if (!item) return;
        item.row.dataset.state = "error";
        item.state.textContent = message.slice(0, 60);
        item.state.className = "state err";
        window.setTimeout(() => {
          item.row.remove();
          items.delete(token);
        }, 6000);
      });
    },
  };
})();

function t(zh: string, en: string): string {
  return /^zh\b/i.test(navigator.language) ? zh : en;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 核心上传逻辑 ──

/** 生成客户端 token（服务端按它落盘到 .uploads/<token>__<name>）。 */
function makeToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeBaseName(name: unknown): string {
  const cleaned = String(name ?? "file")
    // eslint-disable-next-line no-control-regex -- 文件名里的控制字符必须被替换掉，否则会污染落盘路径
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, "_")
    .trim()
    .slice(0, 128);
  return cleaned || "file";
}

/** 已成功前置注册的 clientToken（getPathForFile 的 fire-and-forget register 完成时登记）。 */
const preRegistered = new Set<string>();

/**
 * 上传一个 File 到服务器（内容寻址去重）。
 * 流程：算 SHA-256 → POST /upload-dedupe 查询 → 命中=秒传（零字节）；未命中=XHR 传字节。
 *
 * @param file 浏览器 File 对象
 * @param clientToken 乐观路径（拖拽）传客户端已生成的 token，使预测路径与落盘路径一致
 */
export async function uploadFileSmart(
  file: File,
  options: {
    clientToken?: string;
    onProgress?: (phase: UploadPhase, loaded: number, total: number) => void;
  } = {},
): Promise<SmartUploadResult> {
  const name = file.name || "file";
  const { clientToken, onProgress } = options;

  // 1. 本地算哈希（进度条先走 hash 阶段）
  const sha = await hashForUpload(file, (loaded, total) => onProgress?.("hash", loaded, total));

  // 2. dedupe 查询（sha 为 null → 跳过，直接上传）
  if (sha) {
    try {
      const dedupeToken = clientToken ?? makeToken();
      const params = new URLSearchParams({
        sha256: sha,
        bytes: String(file.size),
        ...(file.type ? { mime: file.type } : {}),
        ...(name ? { fileName: name } : {}),
      });
      const result = await httpJson(
        `/upload-dedupe?token=${encodeURIComponent(dedupeToken)}&${params.toString()}`,
        { method: "POST" },
      );
      if (result.ok && result.deduped) {
        onProgress?.("dedupe", file.size, file.size);
        return {
          path: String(result.path),
          token: dedupeToken,
          deduped: true,
          sha256: sha,
        };
      }
    } catch (error) {
      console.error("[web-upload] dedupe 查询失败（退回直传）:", errorMessage(error));
    }
  }

  // 3. 注册（带 size → 服务端立即写占位）+ XHR 上传（带 sha256 校验 + 内容寻址落盘）
  //    getPathForFile 已抢先发过同 token 注册（占位已写）—— 前置注册成功时直接
  //    复用；否则幂等重注册（token_taken = 前置注册已成功 → 也复用）。
  let registerToken = clientToken;
  if (!clientToken) {
    // {method:'POST'} 不能省：httpJson 缺省会发 GET，而 /upload-register 只认 POST。
    const registered = await httpJson(
      `/upload-register?name=${encodeURIComponent(name)}&size=${String(file.size)}`,
      { method: "POST" },
    );
    registerToken = String(registered.token);
  } else if (!preRegistered.has(clientToken)) {
    try {
      await httpJson(
        `/upload-register?name=${encodeURIComponent(name)}&size=${String(file.size)}&token=${encodeURIComponent(clientToken)}`,
        { method: "POST" },
      );
      preRegistered.add(clientToken);
    } catch (error) {
      // token_taken = 前置注册已成功 → 直接复用
      if ((error as FetchError).status === 400) {
        preRegistered.add(clientToken);
      } else {
        throw error;
      }
    }
  }
  onProgress?.("register", 0, file.size);
  const uploaded = await xhrUpload(
    uploadUrl(registerToken as string, name, file.size, file.type, sha),
    file,
    (loaded, total) => onProgress?.("upload", loaded, total),
  );
  return {
    path: String(uploaded.path),
    token: registerToken as string,
    deduped: false,
    sha256: sha,
  };
}

/**
 * 乐观路径入口（拖拽）：同步返回预测落盘路径，字节上传在后台进行。
 *
 * 渲染器调用 getPathForFile 时不带 await，因此本函数**不能**做任何异步等待。
 * 返回 `<workspaceRoot>/.uploads/<token>__<safeName>`，与服务端命名约定一致。
 */
export function getPathForFileOptimistic(file: unknown): string | null {
  try {
    const candidate = file as { name?: string; size?: number } | null;
    const name = candidate?.name ?? "file";
    const size = candidate?.size ?? 0;
    if (!workspaceRoot) {
      console.warn("[web-upload] workspaceRoot 未配置，getPathForFile 降级");
      return null;
    }
    const token = makeToken();
    const predicted = `${workspaceRoot}/${UPLOAD_DIR_NAME}/${token}__${safeBaseName(name)}`;
    UploadUI.begin(token, name, size);
    // 立刻注册 + 占位（fetch 不阻塞返回值；uploadFileSmart 里会幂等重注册）。
    fetch(
      `/upload-register?name=${encodeURIComponent(name)}&size=${String(size)}&token=${encodeURIComponent(token)}`,
      { method: "POST" },
    )
      .then((response) => {
        if (response.ok) preRegistered.add(token);
      })
      .catch(() => {
        // 注册失败时 uploadFileSmart 会重试；占位缺失只是丢失阻塞等待能力
      });
    void uploadFileSmart(file as File, {
      clientToken: token,
      onProgress: (phase, loaded, total) => {
        if (phase === "hash") UploadUI.hashProgress(token, loaded, total);
        else if (phase === "dedupe") UploadUI.deduped(token);
        else UploadUI.progress(token, loaded, total);
      },
    })
      .then((result) => {
        if (!result.deduped) UploadUI.done(token);
      })
      .catch((error) => {
        console.error(`[web-upload] 拖拽附件上传失败 ${name}:`, errorMessage(error));
        UploadUI.error(token, errorMessage(error));
        // 告诉服务端把占位改写成失败说明（模型若在阻塞等待会因大小变化退出）
        fetch(`/upload-failed?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(
          () => {},
        );
      });
    return predicted;
  } catch (error) {
    console.error("[web-upload] getPathForFile 失败:", errorMessage(error));
    return null;
  }
}

/** 文件选择器入口（回形针）：弹原生选择器，上传后返回**服务器路径**。 */
function pickFiles(multiple: boolean): Promise<string[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (multiple) input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    const finish = (paths: string[] | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(paths);
    };
    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) {
        finish(null);
        return;
      }
      const paths: string[] = [];
      for (const file of files) {
        const uiToken = `sel-${Math.random().toString(36).slice(2, 8)}`;
        UploadUI.begin(uiToken, file.name, file.size);
        try {
          const result = await uploadFileSmart(file, {
            onProgress: (phase, loaded, total) => {
              if (phase === "hash") UploadUI.hashProgress(uiToken, loaded, total);
              else if (phase === "dedupe") UploadUI.deduped(uiToken);
              else UploadUI.progress(uiToken, loaded, total);
            },
          });
          paths.push(result.path);
          UploadUI.done(uiToken);
        } catch (error) {
          console.error(`[web-upload] 选择文件上传失败 ${file.name}:`, errorMessage(error));
          UploadUI.error(uiToken, errorMessage(error));
        }
      }
      finish(paths.length ? paths : null);
    });
    // 取消选择（change 不触发时靠 blur 兜底，避免 Promise 永久挂起）
    input.addEventListener("blur", () => {
      window.setTimeout(() => finish(null), 300);
    });
    input.click();
  });
}

export async function selectFileWeb(): Promise<string | null> {
  const paths = await pickFiles(false);
  return paths?.[0] ?? null;
}

export async function selectFilesWeb(): Promise<string[]> {
  const paths = await pickFiles(true);
  return paths ?? [];
}

/** 判断一个 ref 是否为注册路径（用于 UI 侧避免把注册路径当真实路径重复读取）。 */
export function isRegistryRef(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  if (ref.startsWith(REGISTRY_PREFIX)) return true;
  return new RegExp(`/${UPLOAD_DIR_NAME}/[^/]+__[^/]+$`).test(ref);
}
