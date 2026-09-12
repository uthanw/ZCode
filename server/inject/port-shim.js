// server/inject/port-shim.js —— 浏览器端注入：把 Electron MessagePort 替换为 WebSocket 传输。
// 渲染器自身的 Protocol/ChannelClient 原样运行在此 shim 之上。
//
// 关键实现要点：
// 桌面版 main 进程用 webContents.postMessage(ServicePort, ..., [MessagePortMain]) 把端口交给渲染器，
// 渲染器读 e.ports[0]。浏览器里 window.postMessage 的第三参是 transfer list，只接受**真实**可转移
// 对象（MessagePort/ArrayBuffer 等）；普通 JS 对象会 DataCloneError，而 new MessageEvent({ports:[obj]})
// 也会因 WebIDL 转换失败抛 TypeError。
// 因此：创建真实 MessageChannel，port2 转移给渲染器（它拿到的是原生 MessagePort，语义 100% 一致），
// 我们持有 port1 与 WebSocket 之间双向搬运字节。
(function () {
  'use strict';

  // ---- 初始工作区：桌面版由主进程通过 URL 参数 ?initialWorkspacePath= 传入。
  // 渲染器入口读 URLSearchParams(location.search)。Web 版在 shim（entry 之前同步执行）
  // 里用 history.replaceState 注入默认工作区，保证 Root 的 tJt bootstrap 能建首个
  // workspace tab（否则 skip 登录后 Ft=null → Root 渲染 null → 白屏）。
  // WORKSPACE_ROOT 由服务端 serveHtml 注入到 window.__ZCODE_WEB_WORKSPACE__（下方
  // 乐观路径的落盘路径预测也读它）。取不到配置值时留空串 —— 宁可启动失败也不要
  // 静默指向一个不存在的机器路径。
  var __ws = window.__ZCODE_WEB_WORKSPACE__ || '';
  try {
    if (__ws && !/[?&]initialWorkspacePath=/.test(window.location.search)) {
      var __sep = window.location.search ? '&' : '?';
      window.history.replaceState(null, '', window.location.pathname + window.location.search + __sep + 'initialWorkspacePath=' + encodeURIComponent(__ws));
    }
  } catch (e) { /* replaceState 失败不阻塞启动 */ }

  // ---- 调试回传：把浏览器端错误/进度送到服务端日志（无浏览器环境时的唯一可观测手段）----
  const DBG = [];
  function beacon(kind, msg, extra) {
    const rec = { kind, msg: String(msg).slice(0, 2000), extra: extra ? String(extra).slice(0, 4000) : undefined, t: Date.now() };
    DBG.push(rec);
    try {
      fetch('/__debug', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rec),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }
  window.__zcodeWebDebug = DBG;
  window.addEventListener('error', (e) => beacon('error', e.message, (e.error && e.error.stack) || (e.filename + ':' + e.lineno + ':' + e.colno)));
  window.addEventListener('unhandledrejection', (e) => {
    // 诊断增强：错误发生时抓取渲染器 modelProviders store（bb/mb 模块内部状态），
    // 以及全局可能的 provider 缓存，帮助定位形状错配的 provider 来源。
    let stores = null;
    try {
      const grab = [];
      // React DevTools hook 上可能挂着 store 快照
      if (window.__zcodeWebModelProviders !== undefined) grab.push({ hook: window.__zcodeWebModelProviders });
      stores = grab.length ? grab : null;
    } catch {}
    beacon('unhandledrejection', (e.reason && e.reason.message) || e.reason, e.reason && e.reason.stack, stores);
  });
  const origErr = console.error.bind(console);
  console.error = function (...a) {
    try { beacon('console.error', a.map((x) => (x && x.stack) || (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' | ')); } catch {}
    origErr(...a);
  };
  beacon('boot', 'port-shim 已加载');

  // ---- window.zcode：Electron preload 桥的 Web 替身 ----
  // 权威来源：原版 out/preload/index.cjs 的 contextBridge.exposeInMainWorld("zcode", {...})，共 120 个 API。
  // 分类原则（照抄原版调用语义，避免形状错误引发更深的崩溃）：
  //  * 渲染器对 66 个 API 做了特性检测（`window.zcode.X ? ... : void 0` / `X?.()`）——桌面专属能力
  //    **故意不定义**，渲染器会自动降级禁用，比返回错误结构安全；
  //  * 剩下 51 个是无保护直调，必须定义，否则 "X is not a function" 直接崩组件树。
  window.zcode = window.zcode || {};
  const zcode = window.zcode;
  const NOOP = () => {};
  const UNSUB = () => NOOP;                       // 事件订阅型：返回退订函数
  const OK = (v) => () => Promise.resolve(v);     // Promise 型

  // --- 事件订阅型（11 个无保护直调）：注册回调，返回退订函数。Web 端无对应事件源，恒不触发。---
  for (const k of [
    'onBotRemoteWorkspaceReconnected', 'onFocusTab', 'onNewTab', 'onNewTask',
    'onOAuthCallback', 'onPaymentCallback', 'onRemoteConnectionLog', 'onRemoteSessionClosed',
    'onTaskNotificationClick', 'onUpdateCheckResult', 'onWindowFullscreenChanged',
    // 以下虽有特性检测，但定义为空订阅无害且能避免个别路径遗漏：
    'onPostUpdateReleaseNotes', 'onUpdateReady', 'onUpdateStateChanged', 'onSettingsChanged',
    'onApplicationLocaleChanged', 'onOpenWorkspace', 'onOpenWorkspacePath',
    'onCloseActiveContextRequest', 'onOpenFeedbackDialog', 'onOpenTicketsPanel',
    'onWebRemoteControlStatusChanged', 'onWebRemoteControlReconnectWorkspace',
  ]) zcode[k] = zcode[k] || UNSUB;

  // --- 同步 send 型：原版是 ipcRenderer.send（无返回值），Web 端空实现 ---
  for (const k of [
    'notifyRendererReady', 'openExternal', 'registerOAuthState', 'showTaskNotification',
    'syncActiveTaskSession', 'syncTelemetryContext', 'syncWindowTabs', 'syncWindowUnreadCount',
    'log',
  ]) zcode[k] = zcode[k] || NOOP;
  // openExternal 在 Web 端有真实语义：开新标签页
  zcode.openExternal = (url) => { try { window.open(url, '_blank', 'noopener'); } catch {} };

  // --- Promise 型（30 个无保护直调）：解析为「不支持/空」的安全值 ---
  const UNSUPPORTED = { success: false, error: 'not_supported_in_web' };
  Object.assign(zcode, {
    // 设备/环境
    getDeviceId: () => Promise.resolve(
      localStorage.getItem('zcode-device-id') ||
      (() => {
        const id = 'web-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('zcode-device-id', id);
        return id;
      })()),
    getSystemLocale: () => Promise.resolve(navigator.language || 'en-US'),
    setApplicationLocale: OK(undefined),
    setTitleBarTheme: OK(undefined),
    // 远程/容器环境探测：Web 端一律不可用（返回空列表而非报错，UI 显示"无可用项"）
    isDockerAvailable: OK(false),
    listWSLDistros: OK([]),
    listDockerContainers: OK([]),
    listSSHConfigAliases: OK([]),
    connectRemote: OK({ ok: false, error: 'not_supported_in_web' }),
    disposeRemoteSession: OK(undefined),
    startWebRemoteControl: OK(UNSUPPORTED),
    stopWebRemoteControl: OK(undefined),
    refreshWebRemoteControlPairing: OK(UNSUPPORTED),
    getWebRemoteControlStatus: OK({ running: false, enabled: false }),
    // MCP 用户目录读写（桌面版读本地文件；Web 端由 mcp-sync channel 负责，这里返回空）
    loadMcpFromUserDirectory: OK({ mcpServers: {} }),
    saveMcpToUserDirectory: OK({ success: true }),
    migrateLegacyCommonMcp: OK({ migrated: false }),
    // 文件对话框：selectDirectory 无 Web 语义（不能浏览服务器目录树），保持 null；
    // selectFile/selectFiles 由下方「文件上传桥」实现：弹原生选择器 → 上传 → 服务器路径。
    selectDirectory: OK(null),
    // 桌面集成
    executeDesktopCommand: OK(UNSUPPORTED),
    canOpenCommunity: OK(false),
    exportLogs: OK(UNSUPPORTED),
    // 遥测：Web 端不外发
    reportTelemetryEvent: OK(undefined),
    reportArmsCustomEvent: OK(undefined),
    // 自动更新：Web 端由服务端部署决定，全部禁用
    quitAndInstallUpdate: OK(undefined),
    acknowledgePostUpdateReleaseNotes: OK(undefined),
    // 性能追踪
    startPerformanceTrace: OK(UNSUPPORTED),
    stopPerformanceTrace: OK(UNSUPPORTED),
    // 「用编辑器打开」菜单：Web 端无本地编辑器可枚举；保留空列表（菜单显示「无可用打开方式」，
    // 主按钮与 revealInFileManager 仍走下载桥）
    getInstalledEditors: OK([]),
  });

  // ==========================================================================
  // 文件上传/下载桥 —— 把桌面的「本地文件路径」语义映射为 Web 的「HTTP 传输 + 服务器路径」
  // --------------------------------------------------------------------------
  // 桌面版语义（渲染器 bundle 固化，不可改）：
  //  * 拖拽文件: f.getPathForFile(file) **同步**返回绝对路径 → 附件状态机判定
  //    localZeroCopy（本地工作区）→ 发送时 ref=绝对路径，app-server 自己读盘。
  //  * 回形针按钮: canSelectFilePath:!0 硬编码 → xIe(f) → await selectFiles() → 路径数组。
  //  * 粘贴长文本: createTempTextAttachment({text,filename}) → 临时文件路径。
  //  * 「在文件管理器中打开」/「用编辑器打开」: openInFileManager / openInEditor。
  //
  // Web 语义映射（本桥 + server/web-server.mjs 的 /upload /upload-text /download 端点）：
  //  * getPathForFile: 同步契约没法先上传 → **乐观路径**。同步返回预测落盘路径
  //    <workspace>/.uploads/<token>__<safeName>（渲染器视为本地文件 → localZeroCopy），
  //    同时立刻 XHR POST /upload 送字节（带进度）。sendText 时服务端闸门等字节真正
  //    落盘后才转发 app-server，竞态为零。
  //  * selectFile/selectFiles: 弹 <input type=file> → 逐个 await 上传 → 路径数组。
  //  * createTempTextAttachment: POST /upload-text → 临时文件路径。
  //  * openInFileManager/openInEditor: 隐藏 <a download> 触发浏览器下载该路径。
  //    目录（pathKind:'directory'）无下载语义 → 直接报不支持（原生对目录也是打开面板）。
  // ==========================================================================
  async function httpJson(url, opts) {
    const r = await fetch(url, opts);
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { j = null; }
    if (!r.ok || !j || j.ok === false) {
      const err = new Error('web-bridge ' + r.status + ': ' + (j?.error || txt.slice(0, 120)));
      err.status = r.status;
      throw err;
    }
    return j;
  }

  // ---- 上传进度条（自绘，Shadow DOM）----
  // 渲染器原生的「正在上传 x%」UI 只在远程工作区分支（transferService.stage）激活，
  // 拖拽乐观路径走 localZeroCopy 分支永远不显示进度 → 自己画一枚右下角浮动条。
  const UploadUI = (function () {
    let host = null, sr = null, list = null;
    const items = new Map();   // token -> { row, bar, pct, label }
    function ensure() {
      if (host || !document.body) return !!host;
      host = document.createElement('div');
      host.id = 'zcode-upload-indicator';
      host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;pointer-events:none;';
      sr = host.attachShadow({ mode: 'open' });
      sr.innerHTML = `
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
      list = sr.querySelector('.list');
      document.body.appendChild(host);
      return true;
    }
    function whenReady(fn) { if (ensure()) fn(); else document.addEventListener('DOMContentLoaded', () => { ensure(); fn(); }, { once: true }); }
    function fmt(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
    return {
      begin(token, name, total) {
        whenReady(() => {
          if (items.has(token)) return;
          const item = document.createElement('div');
          item.className = 'item';
          item.dataset.state = 'uploading';
          item.innerHTML = `<div class="row1"><span class="name"></span><span class="state"></span></div><div class="track"><div class="fill"></div></div>`;
          item.querySelector('.name').textContent = name;
          item.querySelector('.state').textContent = total ? fmt(total) : '';
          list.appendChild(item);
          items.set(token, { row: item, bar: item.querySelector('.fill'), pct: 0, total: total || 0 });
        });
      },
      progress(token, loaded, total) {
        whenReady(() => {
          const it = items.get(token);
          if (!it) return;
          const pct = total ? Math.min(100, Math.floor((loaded / total) * 100)) : it.pct;
          it.pct = pct;
          it.bar.style.width = pct + '%';
          it.row.querySelector('.state').textContent = pct + '% · ' + fmt(Math.max(loaded, 0));
        });
      },
      /** 本地哈希计算阶段（dedupe 前置）：显示「校验中 xx%」。 */
      hashProgress(token, loaded, total) {
        whenReady(() => {
          const it = items.get(token);
          if (!it) return;
          const pct = total ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
          it.bar.style.width = pct + '%';
          const st = it.row.querySelector('.state');
          st.textContent = '校验 ' + pct + '%';
          st.className = 'state info';
        });
      },
      /** 秒传命中：条子直接拉满并显示「已存在，秒传」。 */
      deduped(token) {
        whenReady(() => {
          const it = items.get(token);
          if (!it) return;
          it.row.dataset.state = 'done';
          it.bar.style.width = '100%';
          const st = it.row.querySelector('.state');
          st.textContent = '服务器已有 · 秒传';
          st.className = 'state ok';
          items.delete(token);
          setTimeout(() => it.row.remove(), 2800);
        });
      },
      done(token, name) {
        whenReady(() => {
          const it = items.get(token);
          if (!it) return;
          it.row.dataset.state = 'done';
          it.row.querySelector('.state').textContent = '已上传';
          it.row.querySelector('.state').className = 'state ok';
          items.delete(token);
          setTimeout(() => it.row.remove(), 2800);
        });
      },
      error(token, msg) {
        whenReady(() => {
          const it = items.get(token);
          if (!it) { return; }
          it.row.dataset.state = 'error';
          const st = it.row.querySelector('.state');
          st.textContent = '失败: ' + String(msg || '').slice(0, 40);
          st.className = 'state err';
          items.delete(token);
          setTimeout(() => it.row.remove(), 6000);
        });
      },
    };
  })();

  /** XHR 上传（fetch 拿不到上传进度）；onProgress(loaded,total)。resolve JSON。 */
  function xhrUpload(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      // 停滞上传不要挂到 TCP 超时为止：15min 下限速率 ≈ 570KB/s（512MB 慢链路），
      // 低于此速度按失败处理，由 UploadUI.error 呈现并触发 /upload-failed。
      xhr.timeout = 15 * 60 * 1000;
      if (onProgress) {
        xhr.upload.onprogress = (e) => { try { onProgress(e.loaded, e.total || 0); } catch {} };
      }
      xhr.onload = () => {
        let j = null;
        try { j = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && j && j.ok !== false) resolve(j);
        else reject(Object.assign(new Error('web-bridge ' + xhr.status + ': ' + (j?.error || xhr.responseText.slice(0, 100))), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error('network_error'));
      xhr.ontimeout = () => reject(new Error('timeout'));
      try { xhr.send(file); } catch (e) { reject(e); }
    });
  }

  function uploadUrl(token, name, size, file, sha256) {
    return '/upload?token=' + encodeURIComponent(token) +
      '&name=' + encodeURIComponent(name) + '&size=' + size +
      (file && file.type ? '&mime=' + encodeURIComponent(file.type) : '') +
      (sha256 ? '&sha256=' + encodeURIComponent(sha256) : '');
  }

  // ---- 纯 JS SHA-256 ----
  // 为什么不用 crypto.subtle.digest：它只在安全上下文（HTTPS/localhost）存在；本服务
  // 常以 http://IP:8080 裸跑，subtle undefined。内置实现 ~60 行，对 ≤512MB 的上传
  // 分块流式计算（File.slice 避免整文件进内存）。
  // 大文件的压缩循环是同步计算：主线程按 4MB 块跑会连续抢占 UI（每块几十 ms），
  // 512MB 级上传整个哈希期界面都会发卡 → 优先丢进 Web Worker（Blob 克隆是引用
  // 语义，不拷字节），Worker 不可用/出错时回退主线程实现。
  // 注意：sha256WorkerMain 经 toString() 序列化为 worker 源，必须保持**零闭包引用**；
  // 算法与下方主线程兜底实现保持同步（同 test-codec.cjs 的双实现约定）。
  function sha256WorkerMain() {
    const K = new Uint32Array([
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ]);
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    function process(H, data) {
      for (let off = 0; off < data.length; off += 64) {
        const chunk = data.subarray(off, off + 64);
        const w = new Uint32Array(64);
        for (let i = 0; i < 16; i++) w[i] = (chunk[i * 4] << 24) | (chunk[i * 4 + 1] << 16) | (chunk[i * 4 + 2] << 8) | chunk[i * 4 + 3];
        for (let i = 16; i < 64; i++) {
          const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
          const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
          w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = H;
        for (let i = 0; i < 64; i++) {
          const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
          const ch = (e & f) ^ (~e & g);
          const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
          const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
          const mj = (a & b) ^ (a & c) ^ (b & c);
          const t2 = (S0 + mj) >>> 0;
          h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
      }
    }
    async function ofBlob(blob, progress) {
      const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
      const CHUNK = 4 * 1024 * 1024;
      const total = blob.size;
      let offset = 0;
      let pending = new Uint8Array(0);
      while (offset < total) {
        const buf = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
        offset += buf.length;
        const data = pending.length ? concat(pending, buf) : buf;
        const full = data.length - (data.length % 64);
        if (full > 0) process(H, data.subarray(0, full));
        pending = data.subarray(full);
        if (progress) { try { progress(offset, total); } catch {} }
      }
      const rem = pending.length;
      const tailLen = rem + 1 + 8 <= 64 ? 64 : 128;
      const tail = new Uint8Array(tailLen);
      tail.set(pending, 0);
      tail[rem] = 0x80;
      const dv = new DataView(tail.buffer);
      dv.setUint32(tailLen - 8, Math.floor(total / 0x20000000));
      dv.setUint32(tailLen - 4, (total * 8) >>> 0);
      for (let i = 0; i < tailLen; i += 64) process(H, tail.subarray(i, i + 64));
      let hex = '';
      for (let i = 0; i < 8; i++) hex += H[i].toString(16).padStart(8, '0');
      return hex;
    }
    function concat(a, b) {
      const r = new Uint8Array(a.length + b.length);
      r.set(a, 0); r.set(b, a.length);
      return r;
    }
    self.onmessage = async (ev) => {
      const d = ev.data || {};
      try {
        const hex = await ofBlob(d.blob, (l, t) => { try { self.postMessage({ id: d.id, loaded: l, total: t }); } catch {} });
        self.postMessage({ id: d.id, hex });
      } catch (e) { self.postMessage({ id: d.id, error: String((e && e.message) || e) }); }
    };
  }

  const Sha256 = (function () {
    let worker = null, workerBroken = false, nextMsgId = 0;
    const cbs = new Map();   // msgId -> { resolve, reject, progress }

    function ensureWorker() {
      if (workerBroken || typeof Worker === 'undefined' || typeof Blob === 'undefined') return null;
      if (worker) return worker;
      try {
        const url = URL.createObjectURL(new Blob(['(' + sha256WorkerMain.toString() + ')();'], { type: 'text/javascript' }));
        worker = new Worker(url);
        worker.onmessage = (ev) => {
          const d = ev.data || {};
          const cb = cbs.get(d.id);
          if (!cb) return;
          if (d.error) { cbs.delete(d.id); cb.reject(new Error('sha256_worker: ' + d.error)); }
          else if (d.hex !== undefined) { cbs.delete(d.id); cb.resolve(d.hex); }
          else if (d.loaded !== undefined) { try { cb.progress(d.loaded, d.total); } catch {} }
        };
        worker.onerror = () => {
          // 脚本级失败（如 CSP 拦截 blob worker）：标记永久降级，在途任务回退主线程
          workerBroken = true;
          for (const [, cb] of cbs) cb.reject(new Error('sha256_worker_error'));
          cbs.clear();
          try { worker.terminate(); } catch {}
          worker = null;
        };
      } catch (e) {
        workerBroken = true;
        beacon('warn', 'SHA-256 Worker 创建失败，回退主线程: ' + e.message);
        return null;
      }
      return worker;
    }

    function hashViaWorker(blob, progress) {
      const w = ensureWorker();
      if (!w) return null;
      return new Promise((resolve, reject) => {
        const id = ++nextMsgId;
        cbs.set(id, { resolve, reject, progress: progress || (() => {}) });
        try { w.postMessage({ id, blob }); } catch (e) { cbs.delete(id); reject(e); }
      });
    }

    // ---- 主线程兜底实现（算法与 sha256WorkerMain 保持同步）----
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    const K = new Uint32Array([
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ]);
    /** 压缩函数：一次处理 64 字节整块。data 是 64 倍数长度的视图。 */
    function process(H, data) {
      for (let off = 0; off < data.length; off += 64) {
        const chunk = data.subarray(off, off + 64);
        const w = new Uint32Array(64);
        for (let i = 0; i < 16; i++) w[i] = (chunk[i * 4] << 24) | (chunk[i * 4 + 1] << 16) | (chunk[i * 4 + 2] << 8) | chunk[i * 4 + 3];
        for (let i = 16; i < 64; i++) {
          const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
          const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
          w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = H;
        for (let i = 0; i < 64; i++) {
          const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
          const ch = (e & f) ^ (~e & g);
          const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
          const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
          const mj = (a & b) ^ (a & c) ^ (b & c);
          const t2 = (S0 + mj) >>> 0;
          h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
      }
    }
    /** 流式 SHA-256：progress(loaded,total) 可选。分块读 File（不整进内存）。 */
    async function ofBlobMainThread(blob, progress) {
      const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
      const CHUNK = 4 * 1024 * 1024;
      const total = blob.size;
      let offset = 0;
      let pending = new Uint8Array(0);   // 尾部不足 64 字节的余量
      while (offset < total) {
        const buf = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
        offset += buf.length;
        const data = pending.length ? concat(pending, buf) : buf;
        const full = data.length - (data.length % 64);
        if (full > 0) process(H, data.subarray(0, full));
        pending = data.subarray(full);   // 0..63 字节视图
        if (progress) { try { progress(offset, total); } catch {} }
      }
      // 标准填充：0x80 + 0 填充 + 8 字节大端位长，补齐到 64 的倍数（1 或 2 块）
      const rem = pending.length;
      const tailLen = rem + 1 + 8 <= 64 ? 64 : 128;
      const tail = new Uint8Array(tailLen);
      tail.set(pending, 0);
      tail[rem] = 0x80;
      const dv = new DataView(tail.buffer);
      dv.setUint32(tailLen - 8, Math.floor(total / 0x20000000)); // 高 32 位（字节→位）
      dv.setUint32(tailLen - 4, (total * 8) >>> 0);              // 低 32 位
      for (let i = 0; i < tailLen; i += 64) process(H, tail.subarray(i, i + 64));
      let hex = '';
      for (let i = 0; i < 8; i++) hex += H[i].toString(16).padStart(8, '0');
      return hex;
    }
    function concat(a, b) {
      const r = new Uint8Array(a.length + b.length);
      r.set(a, 0); r.set(b, a.length);
      return r;
    }

    return {
      async ofBlob(blob, progress) {
        try {
          const viaWorker = hashViaWorker(blob, progress);
          if (viaWorker) return await viaWorker;
        } catch (e) { beacon('warn', 'SHA-256 Worker 计算失败，回退主线程: ' + (e && e.message)); }
        return ofBlobMainThread(blob, progress);
      },
    };
  })();

  // 已成功前置注册的 clientToken（getPathForFile 的 fire-and-forget register 完成时登记）。
  // uploadFileSmart 据此跳过一次注定 400 token_taken 的重复注册 —— 拖拽路径原本每次
  // 都要白付这个往返。只在注册真正成功后登记：失败/竞态时 uploadFileSmart 照常重注册。
  const preRegistered = new Set();

  /** 上传一个 File 到服务器（内容寻址去重）。
   *  流程：算 SHA-256 → POST /upload-dedupe 查询 → 命中=秒传（零字节）；未命中=XHR 传字节。
   *  clientToken：乐观路径（getPathForFile 拖拽）传客户端已生成的 token —— dedupe 命中时
   *  服务端按它结算，落盘路径与垫片同步返回的预测路径一致。
   *  返回 Promise<{ path, token, deduped, sha256 }>；onProgress 汇报阶段：
   *  'hash'（本地计算）/ 'dedupe'（秒传命中）/ 'register' / 'upload'（网络传输）。 */
  async function uploadFileSmart(file, onProgress, clientToken) {
    const name = file.name || 'file';
    // 1. 本地算哈希（进度条先走 hash 阶段）
    let sha = null;
    try { sha = await Sha256.ofBlob(file, (l, t) => onProgress?.('hash', l, t)); }
    catch (e) { beacon('error', 'SHA-256 计算失败（退回直传）: ' + e.message); }
    // 2. dedupe 查询（sha 可能为 null —— 跳过，直接上传）
    if (sha) {
      try {
        const tok = clientToken || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
        const d = await httpJson('/upload-dedupe?token=' + encodeURIComponent(tok) +
          '&sha256=' + sha + '&size=' + file.size +
          (file.type ? '&mime=' + encodeURIComponent(file.type) : '') +
          '&name=' + encodeURIComponent(name), { method: 'POST' });
        if (d.ok && d.deduped) {
          onProgress?.('dedupe', file.size, file.size);
          return { path: d.path, token: tok, deduped: true, sha256: sha };
        }
      } catch (e) { beacon('error', 'dedupe 查询失败（退回直传）: ' + e.message); }
    }
    // 3. 注册（带 size → 服务端立即写占位）+ XHR 上传（带 sha256 校验 + 内容寻址落盘）
    //    getPathForFile 已抢先发过同 token 注册（占位已写）—— 前置注册成功时直接
    //    复用；否则幂等重注册（token_taken = 前置注册已成功 → 也复用）。
    let reg = null;
    if (!clientToken) {
      // {method:'POST'} 不能省：httpJson 缺省会发 GET，而 /upload-register 路由只认
      // POST —— GET 会落进 SPA 静态兜底返回 index.html（曾导致所有直传必失败）。
      reg = await httpJson('/upload-register?name=' + encodeURIComponent(name) + '&size=' + file.size, { method: 'POST' });
    } else if (preRegistered.has(clientToken)) {
      reg = { token: clientToken };
    } else {
      reg = await httpJson('/upload-register?name=' + encodeURIComponent(name) +
        '&size=' + file.size + '&token=' + encodeURIComponent(clientToken), { method: 'POST' })
        .then((r) => { preRegistered.add(clientToken); return r; })
        .catch((e) => {
          // token_taken = 前置注册已成功 → 直接复用
          if (e.status === 400) { preRegistered.add(clientToken); return { token: clientToken }; }
          throw e;
        });
    }
    onProgress?.('register', 0, file.size);
    const r = await xhrUpload(uploadUrl(reg.token, name, file.size, file, sha), file,
      (l, t) => onProgress?.('upload', l, t));
    return { path: r.path, token: reg.token, deduped: false, sha256: sha };
  }

  /** 把一个 File/Blob 上传到服务器 .uploads/；返回 { path, token }（await 完成态）。 */
  async function uploadFileToServer(file) {
    const name = file.name || 'file';
    const uiTok = 'sel-' + Math.random().toString(36).slice(2, 8);
    UploadUI.begin(uiTok, name, file.size);
    try {
      const r = await uploadFileSmart(file, (phase, l, t) => {
        if (phase === 'hash') UploadUI.hashProgress(uiTok, l, t);
        else if (phase === 'dedupe') UploadUI.deduped(uiTok);
        else UploadUI.progress(uiTok, l, t);
      });
      UploadUI.done(uiTok, name);
      return { path: r.path, token: r.token };
    } catch (e) {
      UploadUI.error(uiTok, e.message);
      throw e;
    }
  }

  // getPathForFile：渲染器同步调用（map 里无 await）→ 乐观路径。
  // 同步返回预测落盘路径 <ws>/.uploads/<token>__<safeName>（双方约定的确定性命名），
  // 并立刻 fire-and-forget 注册（带 size → 服务端马上写占位文本），字节/秒传由
  // uploadFileSmart 后台处理。用户在任意时刻点发送都有完备语义：
  //  - 上传已完成 → 闸门直接放行真实路径；
  //  - 8s 宽限内完成 → 闸门等到落地再放行（小文件无感）；
  //  - 大文件未完 → 闸门放行占位路径，模型读占位文本里的阻塞等待命令自己等。
  zcode.getPathForFile = function (file) {
    try {
      const name = (file && file.name) || 'file';
      const size = (file && file.size) || 0;
      const token = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      const safeName = String(name).replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, '_').trim().slice(0, 128) || 'file';
      const predicted = __ws + '/.uploads/' + token + '__' + safeName;
      UploadUI.begin(token, name, size);
      // 立刻注册 + 占位（fetch 不阻塞返回值；uploadFileSmart 里会幂等重注册）。
      // 成功后登记 preRegistered，uploadFileSmart 跳过重复注册。
      fetch('/upload-register?name=' + encodeURIComponent(name) +
        '&size=' + size + '&token=' + encodeURIComponent(token), { method: 'POST' })
        .then((r) => { if (r.ok) preRegistered.add(token); })
        .catch(() => {});
      uploadFileSmart(file, (phase, l, t) => {
        if (phase === 'hash') UploadUI.hashProgress(token, l, t);
        else if (phase === 'dedupe') UploadUI.deduped(token);
        else UploadUI.progress(token, l, t);
      }, token)
        .then((r) => { if (!r.deduped) UploadUI.done(token, name); })
        .catch((e) => {
          beacon('error', '拖拽附件上传失败 ' + name + ': ' + e.message);
          UploadUI.error(token, e.message);
          // 告诉服务端把占位改写成失败说明（模型若在阻塞等待会因大小变化退出）
          fetch('/upload-failed?token=' + encodeURIComponent(token), { method: 'POST' }).catch(() => {});
        });
      return predicted;
    } catch (e) {
      beacon('error', 'getPathForFile 失败: ' + e.message);
      return null;
    }
  };

  // selectFile / selectFiles：回形针入口。弹原生文件选择器，上传后返回**服务器路径**数组。
  function pickFiles(multiple) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (multiple) input.multiple = true;
      input.style.display = 'none';
      document.body.appendChild(input);
      let settled = false;
      const finish = (paths) => { if (!settled) { settled = true; input.remove(); resolve(paths); } };
      input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        if (!files.length) return finish(null);
        const paths = [];
        for (const f of files) {
          try {
            const r = await uploadFileToServer(f);
            paths.push(r.path);
            beacon('upload', '已上传 ' + f.name + ' → ' + r.path);
          } catch (e) {
            beacon('error', '选择文件上传失败 ' + f.name + ': ' + e.message);
          }
        }
        finish(paths.length ? paths : null);
      });
      // cancel 事件：用户关掉选择器 → null（= 用户取消，渲染器静默处理）
      window.addEventListener('focus', () => {
        setTimeout(() => { if (!settled && !(input.files && input.files.length)) { /* 可能仍在选 */ } }, 1000);
      }, { once: true });
      input.click();
    });
  }
  zcode.selectFile = () => pickFiles(false).then((r) => (r && r[0]) || null);
  zcode.selectFiles = () => pickFiles(true).then((r) => r || []);

  // createTempTextAttachment：粘贴长文本 → 服务器临时文件（渲染器随后零拷贝引用它）
  zcode.createTempTextAttachment = async ({ text, filename }) => {
    try {
      const r = await httpJson('/upload-text', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: String(text || ''), filename: filename || undefined }),
      });
      return r.path;
    } catch (e) {
      beacon('error', '文本附件上传失败: ' + e.message);
      return null;
    }
  };

  // openInFileManager / openInEditor：原生「打开文件」手势 → 浏览器下载。
  function triggerDownload(p) {
    try {
      const a = document.createElement('a');
      a.href = '/download?path=' + encodeURIComponent(p);
      a.download = '';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 5000);
      beacon('download', '触发下载: ' + p);
    } catch (e) {
      beacon('error', '触发下载失败: ' + e.message);
    }
  }
  // pathKind 判定与渲染器一致（file → 下载; directory → 不支持）
  zcode.openInFileManager = async (p) => {
    if (!p) return UNSUPPORTED;
    triggerDownload(p);
    return { success: true };
  };
  zcode.openInEditor = async (_editorId, p, opts) => {
    if (!p) return UNSUPPORTED;
    if (opts && opts.pathKind === 'directory') return UNSUPPORTED;
    triggerDownload(p);
    return { success: true };
  };

  // 说明：以下 66 个桌面专属 API **故意不定义**，渲染器特性检测后会自动禁用相关 UI：
  //   窗口外观(getDesktopWindowChromeState/getWindowControlsOverlayMetrics/getDesktopZoomLevel)、
  //   内嵌浏览器(browserView*)、CUA 权限引导(*CuaHelper*/openCuaPermissionOnboarding)、
  //   自动更新查询(getUpdateState/getAutoUpdatePreferences/downloadUpdate/...)、
  //   窗口截图/PDF 导出(captureWindowScreenshot/printPageToPdf)、多标签同步(syncAppSettings/...)等。


  // ==========================================================================
  // 连接状态指示器（Next.js devtools 徽标风格）
  // --------------------------------------------------------------------------
  // 形态参考 Next.js 的浮动 debugger 徽标：视口右上角一枚圆形徽标，
  // 平时缩成半透明小点安静待命，状态变化时以弹性动画放大出现；
  // 点击展开一张从徽标下方弹出的浮动状态卡（含副标题/倒计时/操作按钮），
  // 点外部或再次点击徽标收回。整个组件在 Shadow DOM 里：自定义属性
  // （--color-card 等）能穿透 shadow 边界继承，自动跟随 ZCode 明/暗主题；
  // 而应用的 Tailwind preflight 不会反过来污染它。
  //
  // 位置：默认右上角（标题栏 h-12 之下、避开窗口控制按钮），**可拖动**——
  // pointer 事件 + 位移阈值区分「点按开合面板」与「拖动改位」，位置存
  // localStorage 跨会话记忆；面板自动跟随徽标，贴边时上下/左右翻转。
  // 徽标常驻（连接正常时低调半透明），用户随时可点开查看连接详情。
  // ==========================================================================
  const Indicator = (function () {
    const TONE = {
      connecting: '#f0a92a', reconnecting: '#f0a92a', syncing: '#57a9ff',
      degraded: '#ff9f45', offline: '#ff5c5c',
      connected: '#2ecc8f', failed: '#ff5c5c', reloading: '#ff5c5c',
    };
    const POS_KEY = 'zcode-indicator-pos';
    const BADGE_SIZE = 34;
    let host = null, sr = null, wrap = null, badge = null, face = null,
      panel = null, pTitle = null, pSub = null, pAct = null, pStats = null;
    let open = false, spotlightTimer = null, showTimer = null;
    let cur = { state: 'idle', text: '', sub: '', action: null };
    let pendingRender = null;   // body 就绪前只保留最后一次状态，避免补播过期动画
    let pos = null;             // 徽标坐标 {x,y}（wrap 的 --bx/--by）

    const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  position: fixed; left: 0; top: 0; right: 0; bottom: 0;
  pointer-events: none;
  font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif);
  font-feature-settings: "tnum" 1;
}
/* ---- 徽标：常驻圆点，状态变化时弹性放大；--bx/--by 由拖动逻辑维护 ---- */
.badge {
  pointer-events: auto;
  position: absolute; left: var(--bx); top: var(--by); right: auto; bottom: auto;
  width: 34px; height: 34px; border-radius: 999px;
  display: grid; place-items: center; cursor: pointer;
  touch-action: none;
  color: var(--color-foreground, #e7e7e7);
  background: color-mix(in oklab, var(--color-card, #2b2b2b) 92%, transparent);
  border: 1px solid var(--color-border, rgba(255,255,255,.12));
  box-shadow: 0 8px 24px -10px rgba(0,0,0,.55), 0 2px 6px -2px rgba(0,0,0,.3), inset 0 1px 0 color-mix(in oklab, var(--color-foreground, #fff) 6%, transparent);
  -webkit-backdrop-filter: blur(14px) saturate(180%);
  backdrop-filter: blur(14px) saturate(180%);
  /* 默认安静态：缩小 + 半透明；出现/状态活跃时弹回全尺寸 */
  opacity: .5; transform: scale(.62);
  transition: opacity .3s ease, transform .45s cubic-bezier(.34,1.56,.64,1);
  will-change: transform, opacity;
  -webkit-user-select: none; user-select: none;
}
.badge:hover { opacity: 1; }
.wrap[data-attn="1"] .badge, .wrap[data-open="1"] .badge { opacity: 1; transform: scale(1); }
.wrap[data-dragging="1"] .badge { cursor: grabbing; opacity: 1; transform: scale(1); transition: opacity .15s ease; }
.face { position: relative; width: 10px; height: 10px; border-radius: 999px;
  background: var(--tone, #f0a92a);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--tone, #f0a92a) 22%, transparent);
  transition: transform .45s cubic-bezier(.34,1.56,.64,1);
  flex: none;
}
.wrap[data-attn="1"] .face, .wrap[data-open="1"] .face { transform: scale(1.15); }
.face::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; background: var(--tone, #f0a92a);
  opacity: 0;
}
.wrap[data-busy="1"] .face::after { animation: zc-ping 1.7s cubic-bezier(0,0,.2,1) infinite; }
@keyframes zc-ping { 0% { transform: scale(1); opacity: .55 } 70%, 100% { transform: scale(2.6); opacity: 0 } }
/* ---- 浮动状态卡：从徽标下方弹出，右缘对齐徽标；贴底时翻转到上方 ---- */
.panel {
  pointer-events: auto;
  position: absolute; top: calc(var(--by) + ${BADGE_SIZE + 10}px); left: auto;
  right: calc(100% - var(--bx) - ${BADGE_SIZE}px);
  min-width: 250px; max-width: 380px;
  padding: 11px 13px;
  border-radius: var(--radius-lg, .5rem);
  color: var(--color-foreground, #e7e7e7);
  background: color-mix(in oklab, var(--color-card, #2b2b2b) 96%, transparent);
  border: 1px solid var(--color-border, rgba(255,255,255,.12));
  box-shadow: 0 24px 48px -16px rgba(0,0,0,.6), 0 4px 12px -4px rgba(0,0,0,.35), inset 0 1px 0 color-mix(in oklab, var(--color-foreground, #fff) 6%, transparent);
  -webkit-backdrop-filter: blur(18px) saturate(180%);
  backdrop-filter: blur(18px) saturate(180%);
  opacity: 0; transform: translateY(-8px) scale(.92);
  transform-origin: calc(100% - 17px) -14px;
  transition: opacity .18s ease, transform .38s cubic-bezier(.22,1,.36,1);
  will-change: transform, opacity;
  visibility: hidden;
  -webkit-user-select: none; user-select: none;
}
.wrap[data-flip="1"] .panel {
  top: auto; bottom: calc(100% - var(--by) + 10px);
  transform-origin: calc(100% - 17px) calc(100% + 14px);
}
.wrap[data-open="1"] .panel {
  opacity: 1; transform: translateY(0) scale(1); visibility: visible;
}
.wrap:not([data-open="1"]) .panel { pointer-events: none; }
.p-head { display: flex; align-items: center; gap: 8px; }
.p-head .face { width: 8px; height: 8px; }
.p-title { flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.35; font-weight: 550; letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.p-sub { margin-top: 4px; font-size: 11.5px; line-height: 1.4; color: var(--color-foreground-subtlest, color-mix(in oklab, currentColor 45%, transparent)); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.p-sub:empty { display: none; }
.p-stats { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--color-border, rgba(255,255,255,.08)); font-size: 10.5px; line-height: 1.5; color: var(--color-foreground-subtlest, color-mix(in oklab, currentColor 45%, transparent)); display: none; white-space: pre-line; }
.p-stats:not(:empty) { display: block; }
.p-actrow { margin-top: 8px; display: none; gap: 6px; }
.p-actrow:not(:has(button[hidden])) { display: flex; }
button { appearance: none; border: 0; background: transparent; font: inherit; color: inherit; cursor: pointer; padding: 0; }
.act {
  height: 24px; padding: 0 11px; border-radius: 999px; font-size: 11.5px; font-weight: 500;
  color: var(--color-foreground, #eee);
  background: color-mix(in oklab, var(--color-foreground, #fff) 9%, transparent);
  transition: background .15s ease;
}
.act:hover { background: color-mix(in oklab, var(--color-foreground, #fff) 17%, transparent); }
.act[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) {
  .badge, .face, .panel { transition: opacity .12s linear; transform: none !important; }
  .wrap[data-busy="1"] .face::after { animation: none; }
}`;

    function build() {
      if (host || !document.body) return !!host;
      host = document.createElement('div');
      host.id = 'zcode-net-indicator';
      host.setAttribute('data-testid', 'net-indicator');
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
      sr = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.setAttribute('data-attn', '0');
      wrap.setAttribute('data-open', '0');
      wrap.innerHTML =
        '<button class="badge" type="button" aria-label="连接状态">' +
          '<span class="face"></span>' +
        '</button>' +
        '<div class="panel" role="status" aria-live="polite">' +
          '<div class="p-head"><span class="face"></span><div class="p-title"></div></div>' +
          '<div class="p-sub"></div>' +
          '<div class="p-stats"></div>' +
          '<div class="p-actrow"><button class="act" type="button" hidden></button></div>' +
        '</div>';
      sr.append(style, wrap);
      badge = wrap.querySelector('.badge');
      panel = wrap.querySelector('.panel');
      pTitle = wrap.querySelector('.p-title');
      pSub = wrap.querySelector('.p-sub');
      pAct = wrap.querySelector('.act');
      pStats = wrap.querySelector('.p-stats');
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        if (suppressClick) { suppressClick = false; return; }   // 刚拖完，忽略尾随 click
        setOpen(!open);
      });
      pAct.addEventListener('click', () => { const a = cur.action; if (a && a.run) a.run(); });
      // 点面板外部 / Esc 收回
      document.addEventListener('click', (e) => { if (open && !host.contains(e.target)) setOpen(false); }, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) setOpen(false); });
      document.body.appendChild(host);
      initPos();
      initDrag();
      const f = pendingRender; pendingRender = null;
      if (f) f();
      return true;
    }

    // ---------- 位置管理：默认右上角，localStorage 记忆，越界钳制 ----------
    function clampPos(x, y) {
      const vw = window.innerWidth || 1600, vh = window.innerHeight || 900;
      return {
        x: Math.max(8, Math.min(x, vw - BADGE_SIZE - 8)),
        y: Math.max(8, Math.min(y, vh - BADGE_SIZE - 8)),
      };
    }
    function applyPos() {
      if (!wrap || !pos) return;
      wrap.style.setProperty('--bx', pos.x + 'px');
      wrap.style.setProperty('--by', pos.y + 'px');
      // 徽标贴近视口底部时面板翻转到上方
      const vh = window.innerHeight || 900;
      const flip = pos.y + BADGE_SIZE + 190 > vh;
      wrap.setAttribute('data-flip', flip ? '1' : '0');
      // 面板右缘对齐徽标右缘；徽标被拖到最左侧时改为左缘对齐，避免面板溢出视口
      const vw = window.innerWidth || 1600;
      if (pos.x + BADGE_SIZE - 250 < 8) {
        panel.style.right = 'auto';
        panel.style.left = 'var(--bx)';
      } else {
        panel.style.left = 'auto';
        panel.style.right = 'calc(100% - var(--bx) - ' + BADGE_SIZE + 'px)';
      }
      if (host) host.dataset.pos = pos.x + ',' + pos.y;   // 调试/E2E 观察
    }
    function initPos() {
      try {
        const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
        if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
          pos = clampPos(saved.x, saved.y);
        }
      } catch {}
      if (!pos) {
        // 默认：右上角，标题栏(h-12)之下，避开宿主窗口控制按钮
        const vw = window.innerWidth || 1600;
        pos = clampPos(vw - BADGE_SIZE - 14, 54);
      }
      applyPos();
      window.addEventListener('resize', () => { pos = clampPos(pos.x, pos.y); applyPos(); });
    }
    function savePos() {
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {}
    }

    // ---------- 拖动：pointer 事件 + 位移阈值区分点按 / 拖动 ----------
    let suppressClick = false;
    function initDrag() {
      let startX = 0, startY = 0, dragging = false, pid = 0;
      badge.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        pid = e.pointerId;
        startX = e.clientX; startY = e.clientY;
        dragging = false;
        badge.setPointerCapture(pid);
      });
      badge.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pid || !pos) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) < 5) return;   // 阈值内视为点按
        if (!dragging) {
          dragging = true;
          wrap.setAttribute('data-dragging', '1');
          setOpen(false);                                    // 拖动时收起面板
        }
        pos = clampPos(e.clientX - BADGE_SIZE / 2, e.clientY - BADGE_SIZE / 2);
        applyPos();
      });
      const end = (e) => {
        if (e.pointerId !== pid) return;
        try { badge.releasePointerCapture(pid); } catch {}
        pid = 0;
        if (dragging) {
          dragging = false;
          suppressClick = true;                              // 吞掉 pointerup 之后的 click
          wrap.setAttribute('data-dragging', '0');
          savePos();
          setTimeout(() => { suppressClick = false; }, 0);
        }
      };
      badge.addEventListener('pointerup', end);
      badge.addEventListener('pointercancel', end);
    }

    function whenReady(fn) {
      if (build()) { fn(); return; }
      const first = !pendingRender;
      pendingRender = fn;
      if (first) document.addEventListener('DOMContentLoaded', () => { build(); }, { once: true });
    }

    /** 开合浮动状态卡。attn=1 时徽标全尺寸高亮；连接正常且面板关着则回落为安静小点。 */
    function setOpen(v) {
      open = v;
      if (wrap) wrap.setAttribute('data-open', v ? '1' : '0');
    }

    function render() {
      if (!wrap) return;
      const tone = TONE[cur.state] || '#f0a92a';
      const busy = cur.state === 'connecting' || cur.state === 'reconnecting' || cur.state === 'reloading' ||
        cur.state === 'syncing' || cur.state === 'degraded';
      const calm = (cur.state === 'idle' || cur.state === 'connected') && !open;
      wrap.style.setProperty('--tone', tone);
      wrap.setAttribute('data-busy', busy ? '1' : '0');
      wrap.setAttribute('data-attn', calm ? '0' : '1');
      const title = cur.text || (cur.state === 'connected' ? '已连接' : '连接状态');
      pTitle.textContent = title;
      pSub.textContent = cur.sub || '';
      if (cur.action) { pAct.hidden = false; pAct.textContent = cur.action.label; }
      else { pAct.hidden = true; pAct.textContent = ''; }
      badge.title = title + (cur.sub ? ' · ' + cur.sub : '');
      badge.setAttribute('aria-label', title);
      if (host) { host.dataset.state = cur.state; host.dataset.text = title + (cur.sub ? ' ' + cur.sub : ''); }
    }

    return {
      /**
       * @param {string} state connecting|connected|reconnecting|offline|failed|reloading|idle
       * @param {{text?:string, sub?:string, action?:{label:string,run:Function}, autoHideMs?:number, delayMs?:number}} o
       */
      set(state, o) {
        o = o || {};
        cur = { state, text: o.text || '', sub: o.sub || '', action: o.action || null };
        clearTimeout(spotlightTimer); clearTimeout(showTimer);
        try { window.dispatchEvent(new CustomEvent('zcode-net-state', { detail: { state, text: cur.text, sub: cur.sub } })); } catch {}
        whenReady(() => {
          render();
          if (state === 'idle') { setOpen(false); return; }
          if (o.delayMs) { showTimer = setTimeout(() => render(), o.delayMs); }
          // 状态切换时给徽标一次「聚光」：放大高亮一段时间，然后回落到安静态。
          // autoHide 只取消聚光，徽标本身常驻不消失（Next.js devtools 徽标同款行为）。
          const spotlightMs = o.autoHideMs || (state === 'connected' ? 2200 : 0);
          if (spotlightMs) {
            wrap.setAttribute('data-attn', '1');
            spotlightTimer = setTimeout(() => { render(); }, spotlightMs);
          }
        });
      },
      /** 仅更新副标题（倒计时），不重置动画。 */
      sub(text) {
        cur.sub = text;
        if (pSub) pSub.textContent = text;
        if (host) host.dataset.text = (cur.text || '连接状态') + ' ' + text;
      },
      /** 面板详情区（stats 快照，面板打开时可见）。 */
      stats(text) { if (pStats) pStats.textContent = text || ''; },
      get current() { return { state: cur.state, text: cur.text, sub: cur.sub, open }; },
      /** 测试/调试用：直接控制面板开合。 */
      setOpen,
      /** 徽标当前坐标（调试/E2E 用）。 */
      get pos() { return pos ? { ...pos } : null; },
      /** 恢复默认右上角位置。 */
      resetPos() {
        const vw = window.innerWidth || 1600;
        pos = clampPos(vw - BADGE_SIZE - 14, 54);
        applyPos(); savePos();
      },
    };
  })();

  // ==========================================================================
  // WebSocket ⇄ 真实 MessageChannel 桥（可恢复传输）
  // --------------------------------------------------------------------------
  // 渲染器只接收一次 ServicePort（入口里有一次性闸门），因此重连**必须**保持 MessagePort
  // 不变，只换底下的 WebSocket。服务端同样保留同一个 ChannelServer（见 server/lib/resumable.js），
  // 这样事件订阅和进行中的请求都不会丢。
  //
  // 双向各自给二进制帧编号；握手时交换「我已收到 N 帧」，各自重放缺口。这一步不能省：
  // 合盖/切后台后 TCP 常处于半开状态——readyState 还是 OPEN、send() 不报错、字节却已丢失，
  // 没有序号核对就会静默丢响应，渲染器的 Promise 永久挂起。
  // ==========================================================================
  const CTRL = { HELLO: '__zcodeRpcHello', ACK: '__zcodeRpcAck', PING: '__zcodeRpcPing', PONG: '__zcodeRpcPong' };
  const FLOW = 'connection-flow-v1';
  const BACKOFF = [400, 900, 1800, 3200, 5000, 8000, 12000, 20000];
  const PING_INTERVAL_MS = 25000;   // 传输层心跳（便宜、发现半开快）
  const PONG_TIMEOUT_MS = 12000;
  const WAKE_PONG_TIMEOUT_MS = 5000;// 切回前台/唤醒后的探活期限（要快）
  const HEALTH_INTERVAL_MS = 60000; // 业务层健康巡检
  const HEALTH_TIMEOUT_MS = 12000;
  const DEGRADED_RETRY_MS = 3000;
  const BUSY_LIMIT = 10;         // 后端「忙」宽限轮数上限（10 轮 × 3s ≈ 30s 预热窗口）
  const DEGRADED_GIVEUP_MS = 120000;
  const HELLO_TIMEOUT_MS = 15000;   // 连上后迟迟收不到握手 → 视为坏连接
  const READY_DISPATCH_FALLBACK_MS = 8000; // 后端未就绪时也别把界面永远卡在启动图上
  const MAX_OUT_BYTES = 8 * 1024 * 1024;
  const MAX_OUT_COUNT = 4000;

  // ==========================================================================
  // channel 二进制协议的最小编解码器
  // --------------------------------------------------------------------------
  // 只为 shim 自己的健康探针服务：它需要发一个**真实**的 RPC 请求、拿到真实响应，
  // 才能证明「传输 + ChannelServer + 后端」整条业务链路是通的——只看 WebSocket
  // 的 readyState 是不够的。
  // 请求 id 取 0x40000000 起的保留段：渲染器 ChannelClient 的 lastRequestId 从 0 递增，
  // 永远碰不到；响应回来时 shim 直接截留，渲染器完全无感。
  // 帧格式见 lib/rpc.js：serialize(head) + serialize(data)，tag: 0=undef 1=str 4=arr 5=obj 6=int。
  // ==========================================================================
  const PROBE_ID_BASE = 0x40000000;
  const TE = new TextEncoder();
  const TD = new TextDecoder();

  function vqlPush(out, v) {
    if (v === 0) { out.push(0); return; }
    while (v !== 0) { let b = v & 127; v = v >>> 7; if (v > 0) b |= 128; out.push(b); }
  }
  function pushStr(out, s) { const b = TE.encode(s); out.push(1); vqlPush(out, b.length); for (let i = 0; i < b.length; i++) out.push(b[i]); }
  function pushObj(out, v) { const b = TE.encode(JSON.stringify(v)); out.push(5); vqlPush(out, b.length); for (let i = 0; i < b.length; i++) out.push(b[i]); }
  function pushInt(out, v) { out.push(6); vqlPush(out, v); }

  /** 组一个 type=100（promise 调用）请求帧。 */
  function encodeRequest(id, channelName, method, args) {
    const out = [];
    out.push(4); vqlPush(out, 4);          // head = [100, id, channel, method]
    pushInt(out, 100); pushInt(out, id);
    pushStr(out, channelName); pushStr(out, method);
    out.push(4); vqlPush(out, args.length); // data = 参数数组
    for (const a of args) pushObj(out, a);
    return Uint8Array.from(out);
  }

  function makeReader(u8) {
    let p = 0;
    return {
      get pos() { return p; },
      get left() { return u8.length - p; },
      byte() { return u8[p++]; },
      vql() { let v = 0, s = 0, b; do { b = u8[p++]; v |= (b & 127) << s; s += 7; } while (b & 128 && p < u8.length); return v; },
      take(n) { const r = u8.subarray(p, p + n); p += n; return r; },
    };
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

  function createTransport() {
    const cid = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const channel = new MessageChannel();
    const local = channel.port1;    // 我们这侧
    const remote = channel.port2;   // 交给渲染器

    let ws = null;
    let state = 'connecting';
    // established = 传输层会话已建立过（决定 new= 标志与「恢复失败即重载」规则）
    // everReady   = 业务层至少就绪过一次（决定文案，以及「订阅丢失」的判定基线）
    let established = false, everReady = false, ready = false;
    let attempts = 0;
    let sentSeq = 0, recvSeq = 0, lastAckSent = 0;
    const outbox = [];              // [{seq, data:ArrayBuffer}] 未被服务端确认的出站帧
    let outBytes = 0;
    let lossy = false;              // 出站缓冲溢出 → 已无法无损恢复
    let lastFlowOut = null;         // 最近一次出站 flow-control，重连后补发
    let stopped = false;            // 准备整页重载，停止一切重连
    let retryTimer = null, retryAt = 0, countdownTimer = null;
    let pingTimer = null, pongDeadline = 0, helloTimer = null;
    let healthTimer = null, degradedSince = 0, lastHealth = null, peakSubs = 0, verifySeq = 0, busyStreak = 0;
    let portDispatched = false, domReady = false, helloSeen = false, dispatchFallback = null;

    // ---- 状态机 → 指示器 ----------------------------------------------------
    function setState(next, opts) {
      state = next;
      Indicator.set(next, opts);
    }
    function announceReady() {
      setState('connected', {
        text: everReady ? '连接已恢复' : '已连接',
        autoHideMs: everReady ? 2200 : 1400,
      });
    }
    function announceRetry() {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setState('offline', { text: '网络已断开', sub: '恢复网络后将自动重连' });
        return;
      }
      if (!everReady) {
        // 首次加载：给 1.2s 宽限，正常启动不该闪一下提示
        setState('connecting', {
          text: '正在连接服务',
          sub: attempts > 1 ? '第 ' + attempts + ' 次' : '',
          delayMs: 1200,
          action: attempts > 1 ? { label: '立即重试', run: () => { attempts = 0; connect(); } } : null,
        });
        return;
      }
      setState('reconnecting', {
        text: '连接已断开 · 正在重连',
        sub: attempts > 1 ? '第 ' + attempts + ' 次' : '',
        action: { label: '立即重试', run: () => { attempts = 0; connect(); } },
      });
    }

    // ---- 出站 ---------------------------------------------------------------
    function rawSend(ab) {
      if (!ws || ws.readyState !== 1) return false;
      try { ws.send(ab); return true; } catch { return false; }
    }
    function sendText(obj) {
      if (!ws || ws.readyState !== 1) return;
      try { ws.send(JSON.stringify(obj)); } catch {}
    }
    function sendAck() {
      if (recvSeq === lastAckSent) return;
      lastAckSent = recvSeq;
      sendText({ [CTRL.ACK]: recvSeq });
    }
    function dropAcked(upto) {
      if (!(upto > 0)) return;
      let i = 0;
      while (i < outbox.length && outbox[i].seq <= upto) { outBytes -= outbox[i].data.byteLength; i++; }
      if (i > 0) outbox.splice(0, i);
      if (outBytes < 0) outBytes = 0;
    }

    local.onmessage = (ev) => {
      const d = ev.data;
      if (d instanceof ArrayBuffer || (d && d.buffer instanceof ArrayBuffer && typeof d.byteLength === 'number')) {
        const ab = d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
        sentSeq += 1;
        if (!lossy) {
          outbox.push({ seq: sentSeq, data: ab });
          outBytes += ab.byteLength;
          if (outBytes > MAX_OUT_BYTES || outbox.length > MAX_OUT_COUNT) {
            lossy = true; outbox.length = 0; outBytes = 0;
            beacon('warn', '出站重放缓冲溢出，本会话不再可无损恢复');
          }
        }
        rawSend(ab);
        return;
      }
      if (d && d.__zcodeRpcControl === FLOW) lastFlowOut = d;
      sendText(d);
    };
    local.start();

    // ---- 入站 ---------------------------------------------------------------
    function onText(txt) {
      let obj;
      try { obj = JSON.parse(txt); } catch { return; }
      if (obj.__zcodeRpcControl === FLOW) { local.postMessage(obj); return; }
      if (typeof obj[CTRL.ACK] === 'number') { dropAcked(obj[CTRL.ACK]); return; }
      if (obj[CTRL.PONG] !== undefined) { pongDeadline = 0; return; }
      if (obj[CTRL.HELLO]) { onHello(obj); return; }
    }

    /**
     * 截留属于健康探针的响应帧（id 在保留段内），渲染器不该看到它们。
     * @returns {boolean} true = 已消化，不要转交渲染器
     */
    function interceptProbeFrame(u8) {
      if (u8.length < 4 || u8[0] !== 4) return false;   // head 必定是 Array
      try {
        const r = makeReader(u8);
        const head = decodeValue(r);
        if (!Array.isArray(head) || head.length < 2) return false;
        const id = head[1];
        if (typeof id !== 'number' || id < PROBE_ID_BASE) return false;
        const type = head[0];
        const cb = probePending.get(id);
        if (cb) {
          // 201=成功 202/203=失败；重连后重放的过期探针没有 cb，直接丢弃即可
          cb(type === 201, type === 201 ? decodeValue(r) : null);
        }
        return true;
      } catch { return false; }
    }

    function onHello(hello) {
      clearTimeout(helloTimer); helloTimer = null;
      helloSeen = true;
      const serverRecv = Number(hello.recv || 0);

      // 服务端说恢复不了（会话过期 / 服务重启 / 缓冲溢出）：渲染器手里的订阅全是废的，
      // 只能整页重载。首次连接 resumed 本来就是 false，不能误伤。
      if (!hello.resumed && established) { hardReload('会话已过期', hello.reason || 'server-not-resumable'); return; }
      if (lossy && established) { hardReload('连接数据不完整', 'client-outbox-overflow'); return; }

      if (established) {
        dropAcked(serverRecv);
        if (serverRecv > sentSeq || (outbox.length && outbox[0].seq !== serverRecv + 1)) {
          hardReload('连接数据不完整', 'client-gap'); return;
        }
        let n = 0;
        for (const it of outbox) { if (rawSend(it.data)) n++; }
        if (n) beacon('ws', '重连后重放 ' + n + ' 个出站帧（服务端 recv=' + serverRecv + '）');
        if (lastFlowOut) sendText(lastFlowOut);
      }

      attempts = 0;
      established = true;
      startHeartbeat();
      sendAck();
      // 传输层通了 ≠ 可以用了。必须先跑一次真实 RPC 往返，确认后端存活、
      // 本会话的事件订阅还在，才允许宣布「已连接」。
      verifyBusiness(false);
      armDispatchFallback();
    }

    // ---- 业务层就绪校验 -------------------------------------------------------
    const probePending = new Map();
    let probeSeq = 0;

    /** 发一个真实 RPC（zcode-web-health.ping）并等响应。失败/超时返回 null。 */
    function healthPing(timeoutMs) {
      return new Promise((resolve) => {
        if (!ws || ws.readyState !== 1) { resolve(null); return; }
        const id = PROBE_ID_BASE + (++probeSeq);
        const frame = encodeRequest(id, 'zcode-web-health', 'ping', [{ t: Date.now() }]);
        const timer = setTimeout(() => { probePending.delete(id); resolve(null); }, timeoutMs);
        probePending.set(id, (ok, data) => { clearTimeout(timer); probePending.delete(id); resolve(ok ? data : null); });
        // 探针帧同样要进序号与重放缓冲，否则双方序号会错位
        sentSeq += 1;
        if (!lossy) { outbox.push({ seq: sentSeq, data: frame.buffer }); outBytes += frame.byteLength; }
        rawSend(frame.buffer);
      });
    }

    async function verifyBusiness(isRecheck) {
      if (stopped) return;
      const myTurn = ++verifySeq;
      if (!isRecheck) {
        setState('syncing', {
          text: everReady ? '连接已恢复 · 正在校验会话' : '正在同步会话',
          delayMs: everReady ? 0 : 1200,
        });
      }
      const r = await healthPing(HEALTH_TIMEOUT_MS);
      if (stopped || myTurn !== verifySeq) return;     // 已有更新的一轮校验
      if (!r) {
        // 连接还在却问不出话 = RPC 通道坏了（半开 / ChannelServer 异常），换一条链路
        if (!ws || ws.readyState !== 1) return;        // 已经断了，交给重连流程
        ready = false;
        forceReconnect('业务校验无响应（RPC 通道不通）');
        return;
      }
      lastHealth = r;

      // 后端忙碌（readState 暂时排不上队，但进程活着）→ 保持 syncing 继续等，
      // 不算 degraded —— 谎报「服务未就绪」和谎报「已连接」一样糟糕。
      // 但忙碌宽限有上限：连续 BUSY_LIMIT 轮后照常走 degraded 流程，防止永远卡在预热。
      if (r.appServer === 'ok' && r.appServerBusy) {
        busyStreak += 1;
        if (busyStreak < BUSY_LIMIT) {
          setState('syncing', {
            text: everReady ? '连接已恢复 · 正在校验会话' : '正在同步会话',
            sub: '后端正在预热…',
            delayMs: everReady ? 0 : 1200,
          });
          clearTimeout(healthTimer);
          healthTimer = setTimeout(() => verifyBusiness(true), DEGRADED_RETRY_MS);
          armDispatchFallback();
          return;
        }
      } else {
        busyStreak = 0;
      }
      if (r.appServer !== 'ok') { enterDegraded(r); return; }

      // 业务状态一致性：重连前有订阅、重连后一个都不剩 → 渲染器的事件流已经全死，
      // 界面会「看起来正常但永不更新」，这种情况必须重载而不是假装连上了。
      if (everReady && peakSubs > 0 && !(r.subscriptions > 0)) {
        hardReload('会话订阅已失效', 'subscriptions-lost');
        return;
      }
      if (r.subscriptions > peakSubs) peakSubs = r.subscriptions;

      const wasReady = ready;
      ready = true;
      degradedSince = 0;
      // 面板详情：真实往返延迟 + 会话/订阅快照，点开徽标即可看到
      try {
        Indicator.stats('会话 ' + cid + ' · 延迟 ' + (Date.now() - (r.echo || Date.now())) + 'ms\n' +
          '订阅 ' + r.subscriptions + ' · 通道 ' + r.channels + ' · 发送 ' + sentSeq + ' / 接收 ' + recvSeq + ' 帧');
      } catch {}
      if (!wasReady) announceReady();
      everReady = true;
      scheduleHealthCheck();
      maybeDispatchPort();
    }

    function enterDegraded(r) {
      ready = false;
      if (!degradedSince) degradedSince = Date.now();
      const waited = Date.now() - degradedSince;
      if (waited > DEGRADED_GIVEUP_MS) { hardReload('后端长时间未就绪', 'backend-down'); return; }
      setState('degraded', {
        text: '服务未就绪',
        sub: r && r.appServerError ? String(r.appServerError).slice(0, 46) : '后端正在恢复，将持续重试',
        action: { label: '重试', run: () => verifyBusiness(true) },
      });
      clearTimeout(healthTimer);
      healthTimer = setTimeout(() => verifyBusiness(true), DEGRADED_RETRY_MS);
      armDispatchFallback();
    }

    function scheduleHealthCheck() {
      clearTimeout(healthTimer);
      healthTimer = setTimeout(() => verifyBusiness(true), HEALTH_INTERVAL_MS);
    }

    // ---- 连接 ---------------------------------------------------------------
    function clearRetry() {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      retryAt = 0;
    }

    function connect() {
      if (stopped) return;
      clearRetry();
      if (ws) { const old = ws; ws = null; teardownSocket(old); }
      if (state !== 'connected') announceRetry();

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const tok = new URLSearchParams(location.search).get('token');
      // ephemeral=1（页面 URL 透传）：一次性会话（E2E/自动化），断开 15s 即销毁，
      // 不占 10 分钟保活池，避免密集自动化把真实用户会话挤掉。
      const eph = new URLSearchParams(location.search).get('ephemeral');
      let url = proto + '//' + location.host + '/rpc?cid=' + encodeURIComponent(cid) +
        '&recv=' + recvSeq + '&new=' + (established ? '0' : '1');
      if (tok) url += '&token=' + encodeURIComponent(tok);
      if (eph === '1') url += '&ephemeral=1';

      let sock;
      try { sock = new WebSocket(url); } catch (e) { beacon('error', 'WebSocket 构造失败: ' + e.message); scheduleRetry(); return; }
      sock.binaryType = 'arraybuffer';
      ws = sock;
      helloSeen = false;
      ready = false;

      sock.onopen = () => {
        beacon('ws', 'WebSocket 已连接' + (established ? '（重连 #' + attempts + '）' : ''));
        // 连上但握手迟迟不来 = 坏连接（例如中间代理吞包），主动换一条
        clearTimeout(helloTimer);
        helloTimer = setTimeout(() => { if (ws === sock && !helloSeen) forceReconnect('握手超时'); }, HELLO_TIMEOUT_MS);
      };
      sock.onmessage = (ev) => {
        const d = ev.data;
        if (typeof d === 'string') { onText(d); return; }
        if (d instanceof ArrayBuffer) {
          recvSeq += 1;
          const u8 = new Uint8Array(d);
          if (!interceptProbeFrame(u8)) {
            // 渲染器 Protocol 判定 `e.data instanceof Uint8Array`，故必须投递 Uint8Array
            local.postMessage(u8);
          }
          if (recvSeq - lastAckSent >= 32) sendAck();
          return;
        }
        if (d instanceof Blob) beacon('warn', '收到 Blob 帧，预期 arraybuffer');
      };
      sock.onerror = () => { if (ws === sock) beacon('error', 'WebSocket 错误'); };
      sock.onclose = (e) => {
        if (ws !== sock) return;
        ws = null;
        ready = false;
        stopHeartbeat();
        clearTimeout(helloTimer); helloTimer = null;
        beacon('ws', 'WebSocket 关闭 code=' + e.code + ' reason=' + e.reason);
        if (stopped) return;
        scheduleRetry();
      };
    }

    function teardownSocket(sock) {
      try { sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null; } catch {}
      try { if (sock.readyState === 0 || sock.readyState === 1) sock.close(); } catch {}
    }

    function scheduleRetry() {
      if (stopped || retryTimer) return;
      attempts += 1;
      announceRetry();
      const base = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)];
      const delay = base + Math.round(base * 0.25 * Math.random());
      retryAt = Date.now() + delay;
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
      if (delay > 1500) {
        countdownTimer = setInterval(() => {
          const left = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
          if (!left) { clearInterval(countdownTimer); countdownTimer = null; return; }
          Indicator.sub((attempts > 1 ? '第 ' + attempts + ' 次 · ' : '') + left + ' 秒后重试');
        }, 250);
      }
    }

    function forceReconnect(reason) {
      if (stopped) return;
      beacon('ws', '主动重连: ' + reason);
      if (ws) { const old = ws; ws = null; teardownSocket(old); }
      stopHeartbeat(); clearRetry();
      attempts = 0;
      connect();
    }

    function hardReload(text, reason) {
      if (stopped) return;
      stopped = true;
      beacon('ws', '无法恢复连接，重载页面: ' + reason);
      stopHeartbeat(); clearRetry();
      if (ws) { const old = ws; ws = null; teardownSocket(old); }
      Indicator.set('reloading', { text: text, sub: '正在重新载入…' });
      setTimeout(() => { try { location.reload(); } catch {} }, 900);
    }

    // ---- 心跳 / 半开检测 -----------------------------------------------------
    function startHeartbeat() {
      stopHeartbeat();
      pingTimer = setInterval(() => ping(PONG_TIMEOUT_MS), PING_INTERVAL_MS);
    }
    function stopHeartbeat() {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
      pongDeadline = 0;
    }
    function ping(timeoutMs) {
      if (!ws || ws.readyState !== 1) return;
      const sock = ws;
      pongDeadline = Date.now() + timeoutMs;
      sendText({ [CTRL.PING]: Date.now() });
      setTimeout(() => {
        if (ws !== sock || !pongDeadline) return;
        if (Date.now() >= pongDeadline) forceReconnect('心跳无应答（连接疑似半开）');
      }, timeoutMs + 60);
    }

    /**
     * 页面重新活跃时的统一入口。注意这里做两件事而不是一件：
     *  1) 传输层：断了就立刻重连，看着还连着就发心跳探半开；
     *  2) 业务层：立刻重跑一次健康校验——休眠期间后端可能已经重启过，
     *     socket 还活着但订阅已经空了，光看连接是发现不了的。
     */
    function kick(reason) {
      if (stopped) return;
      if (!ws || ws.readyState === 2 || ws.readyState === 3) {
        if (retryTimer && retryAt - Date.now() < 400) return; // 马上就要重试了，不叠加
        attempts = 0;
        beacon('ws', '唤醒重连: ' + reason);
        connect();
        return;
      }
      if (ws.readyState === 1) {
        ping(WAKE_PONG_TIMEOUT_MS);
        if (helloSeen) verifyBusiness(ready);  // ready=false 时按「首次校验」展示同步中
      }
    }

    // ---- 唤醒触发源 ----------------------------------------------------------
    document.addEventListener('visibilitychange', () => { if (!document.hidden) kick('标签页切回前台'); });
    window.addEventListener('focus', () => kick('窗口获得焦点'));
    window.addEventListener('pageshow', (e) => { if (e.persisted) kick('bfcache 恢复'); });
    window.addEventListener('online', () => { attempts = 0; kick('网络恢复'); });
    window.addEventListener('offline', () => {
      if (stopped) return;
      Indicator.set('offline', { text: '网络已断开', sub: '恢复网络后将自动重连' });
    });
    // 休眠探测：定时器在系统睡眠期间不会按时触发，时钟跳变即可判定「刚醒」。
    let lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const drift = now - lastTick;
      lastTick = now;
      if (drift > 20000) kick('时钟跳变 ' + Math.round(drift / 1000) + 's（疑似休眠唤醒）');
    }, 5000);

    // ---- 端口派发（只做一次；渲染器入口有一次性闸门）-------------------------
    // 正常路径等「业务就绪」再派发，避免渲染器一上来就对着一个不可用的后端发请求；
    // 但后端长时间不就绪时也不能把界面永远钉在启动图上——超时后照常派发，
    // 由指示器如实显示「服务未就绪」。
    function maybeDispatchPort() {
      if (portDispatched || !domReady || !helloSeen) return;
      if (!ready && !dispatchForced) return;
      portDispatched = true;
      if (dispatchFallback) { clearTimeout(dispatchFallback); dispatchFallback = null; }
      try {
        // 与桌面 webContents.postMessage(ServicePort, '*', [port]) 完全等价：
        // 真实 MessagePort 走 transfer list，渲染器从 e.ports[0] 取到它。
        window.postMessage('zcode:service-port', '*', [remote]);
        beacon('ws', 'service-port 已派发' + (ready ? '' : '（后端未就绪，降级派发）'));
      } catch (e) {
        beacon('fatal', 'service-port 派发失败: ' + e.message, e.stack);
      }
    }
    let dispatchForced = false;
    function armDispatchFallback() {
      if (portDispatched || dispatchFallback) return;
      dispatchFallback = setTimeout(() => {
        dispatchFallback = null;
        dispatchForced = true;
        maybeDispatchPort();
      }, READY_DISPATCH_FALLBACK_MS);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { domReady = true; maybeDispatchPort(); }, { once: true });
    } else { domReady = true; maybeDispatchPort(); }

    // ---- 调试/测试出口 --------------------------------------------------------
    window.__zcodeNet = {
      get state() { return state; },
      get ready() { return ready; },
      get stats() {
        return {
          cid, state, ready, everReady, established, attempts,
          sent: sentSeq, recv: recvSeq, outbox: outbox.length, outKB: Math.round(outBytes / 1024), lossy,
          readyState: ws ? ws.readyState : -1,
          peakSubs,
          health: lastHealth ? { appServer: lastHealth.appServer, subscriptions: lastHealth.subscriptions, inflight: lastHealth.inflight, channels: lastHealth.channels } : null,
        };
      },
      reconnect: () => forceReconnect('手动触发'),
      /** 主动重跑业务层校验（返回健康快照）。 */
      health: () => healthPing(HEALTH_TIMEOUT_MS),
      verify: () => verifyBusiness(true),
      /** 测试用：模拟链路中断（不通知服务端，等同拔网线）。 */
      drop: () => { const s = ws; if (!s) return false; ws = null; ready = false; try { s.onclose = null; s.onmessage = null; s.close(4009, 'simulated-drop'); } catch {} stopHeartbeat(); scheduleRetry(); return true; },
      indicator: Indicator,
    };

    setState('connecting', { text: '正在连接服务', delayMs: 1200 });
    connect();
  }

  createTransport();
})();
