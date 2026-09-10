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
  try {
    if (!/[?&]initialWorkspacePath=/.test(window.location.search)) {
      var __ws = (window.__ZCODE_WEB_WORKSPACE__ || '/root/zcode-web-service/workspace');
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
    // 文件对话框：浏览器拿不到绝对路径，返回 null = 用户取消
    selectDirectory: OK(null),
    selectFile: OK(null),
    createTempTextAttachment: OK(null),
    // 桌面集成
    openInEditor: OK(UNSUPPORTED),
    openInFileManager: OK(UNSUPPORTED),
    executeDesktopCommand: OK(UNSUPPORTED),
    getInstalledEditors: OK([]),
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
  });

  // getPathForFile：桌面版用 webUtils 拿拖入文件的绝对路径；Web 端无此能力，返回 null
  zcode.getPathForFile = zcode.getPathForFile || (() => null);

  // 说明：以下 66 个桌面专属 API **故意不定义**，渲染器特性检测后会自动禁用相关 UI：
  //   窗口外观(getDesktopWindowChromeState/getWindowControlsOverlayMetrics/getDesktopZoomLevel)、
  //   内嵌浏览器(browserView*)、CUA 权限引导(*CuaHelper*/openCuaPermissionOnboarding)、
  //   自动更新查询(getUpdateState/getAutoUpdatePreferences/downloadUpdate/...)、
  //   窗口截图/PDF 导出(captureWindowScreenshot/printPageToPdf)、多标签同步(syncAppSettings/...)等。


  // ---- WebSocket ⇄ 真实 MessageChannel 桥 ----
  function connectPort(wsUrl) {
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { beacon('fatal', 'WebSocket 构造失败: ' + e.message); return null; }
    ws.binaryType = 'arraybuffer';

    const channel = new MessageChannel();
    const local = channel.port1;   // 我们这侧
    const remote = channel.port2;  // 交给渲染器

    const outQueue = []; // ws 未就绪时缓存渲染器发出的消息

    function sendToWs(data) {
      if (ws.readyState !== 1) { outQueue.push(data); return; }
      if (data instanceof ArrayBuffer) ws.send(data);
      else if (data && data.buffer instanceof ArrayBuffer) ws.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      else ws.send(JSON.stringify(data)); // flow-control 控制帧
    }

    // 渲染器 → 服务端
    local.onmessage = (ev) => sendToWs(ev.data);
    local.start();

    // 服务端 → 渲染器
    ws.onmessage = (ev) => {
      let data = ev.data;
      if (data instanceof ArrayBuffer) {
        // 渲染器 Protocol 判定 `e.data instanceof Uint8Array`，故必须投递 Uint8Array
        local.postMessage(new Uint8Array(data));
        return;
      }
      if (typeof data === 'string') {
        try { local.postMessage(JSON.parse(data)); } catch { beacon('warn', '无法解析文本帧: ' + data.slice(0, 200)); }
        return;
      }
      if (data instanceof Blob) { beacon('warn', '收到 Blob 帧，预期 arraybuffer'); return; }
    };

    // 端口派发时机：必须等渲染器注册好 window 'message' 监听器。
    // module 脚本默认 defer，在 DOMContentLoaded 之前执行完毕，因此 DOM ready 即可安全派发。
    // WebSocket 握手则提前发起，与资源下载并行，省掉串行等待。
    let wsOpen = false, domReady = false, dispatched = false;
    function maybeDispatch() {
      if (dispatched || !wsOpen || !domReady) return;
      dispatched = true;
      try {
        // 与桌面 webContents.postMessage(ServicePort, '*', [port]) 完全等价：
        // 真实 MessagePort 走 transfer list，渲染器从 e.ports[0] 取到它。
        window.postMessage('zcode:service-port', '*', [remote]);
        beacon('ws', 'service-port 已派发');
      } catch (e) {
        beacon('fatal', 'service-port 派发失败: ' + e.message, e.stack);
      }
    }

    ws.onopen = () => {
      wsOpen = true;
      beacon('ws', 'WebSocket 已连接');
      while (outQueue.length) sendToWs(outQueue.shift());
      maybeDispatch();
    };
    ws.onerror = () => beacon('error', 'WebSocket 错误');
    ws.onclose = (e) => beacon('ws', 'WebSocket 关闭 code=' + e.code + ' reason=' + e.reason);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { domReady = true; maybeDispatch(); }, { once: true });
    } else { domReady = true; maybeDispatch(); }

    return remote;
  }

  function main() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams(location.search);
    const tok = qs.get('token');
    const url = proto + '//' + location.host + '/rpc' + (tok ? '?token=' + encodeURIComponent(tok) : '');
    connectPort(url);
  }
  main(); // 立即发起（内部自行等待 DOM ready 才派发端口）
})();
