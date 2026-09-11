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


  // ==========================================================================
  // 连接状态指示器
  // --------------------------------------------------------------------------
  // 放在 Shadow DOM 里：自定义属性（--color-card 等）能穿透 shadow 边界继承进来，
  // 所以能自动跟随 ZCode 明/暗主题；而应用的 Tailwind preflight 不会反过来污染它。
  // 位置：顶部居中、标题栏（h-12）之下 —— 不与侧边栏标签/输入框抢地方，
  // 连接正常时自动淡出，只在异常时常驻；右侧「–」可折叠为一个小圆点。
  // ==========================================================================
  const Indicator = (function () {
    const TONE = {
      connecting: '#f0a92a', reconnecting: '#f0a92a', syncing: '#57a9ff',
      degraded: '#ff9f45', offline: '#ff5c5c',
      connected: '#2ecc8f', failed: '#ff5c5c', reloading: '#ff5c5c',
    };
    let host = null, sr = null, wrap = null, pill = null, txtEl = null, subEl = null, actEl = null, chip = null;
    let collapsed = false, hideTimer = null, showTimer = null;
    let cur = { state: 'idle', text: '', sub: '', action: null };
    let pendingRender = null;   // body 就绪前只保留最后一次状态，避免补播过期动画

    const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  position: fixed; top: 56px; left: 0; right: 0;
  display: flex; justify-content: center; align-items: flex-start;
  pointer-events: none;
  font-family: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif);
  font-feature-settings: "tnum" 1;
}
.pill, .chip {
  pointer-events: auto;
  color: var(--color-foreground, #e7e7e7);
  background: color-mix(in oklab, var(--color-card, #2b2b2b) 88%, transparent);
  border: 1px solid var(--color-border, rgba(255,255,255,.12));
  box-shadow: 0 12px 32px -14px rgba(0,0,0,.6), 0 2px 6px -2px rgba(0,0,0,.3), inset 0 1px 0 color-mix(in oklab, var(--color-foreground, #fff) 6%, transparent);
  -webkit-backdrop-filter: blur(14px) saturate(180%);
  backdrop-filter: blur(14px) saturate(180%);
  border-radius: 999px;
  opacity: 0; transform: translateY(-12px) scale(.94);
  transition: opacity .22s ease, transform .34s cubic-bezier(.22,1,.36,1);
  will-change: transform, opacity;
  -webkit-user-select: none; user-select: none;
}
.pill {
  display: none; align-items: center; gap: 8px;
  height: 30px; padding: 0 5px 0 11px;
  font-size: 12.5px; line-height: 1; font-weight: 450; letter-spacing: .01em; white-space: nowrap;
}
.chip { display: none; width: 24px; height: 24px; align-items: center; justify-content: center; padding: 0; cursor: pointer; }
.wrap[data-mode="pill"] .pill { display: inline-flex; }
.wrap[data-mode="chip"] .chip { display: inline-flex; }
.wrap[data-show="1"] .pill, .wrap[data-show="1"] .chip { opacity: 1; transform: translateY(0) scale(1); }
.dot {
  position: relative; flex: none; width: 7px; height: 7px; border-radius: 999px;
  background: var(--tone, #f0a92a);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--tone, #f0a92a) 20%, transparent);
}
.dot::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; background: var(--tone, #f0a92a);
  opacity: 0;
}
.wrap[data-busy="1"] .dot::after { animation: zc-ping 1.7s cubic-bezier(0,0,.2,1) infinite; }
@keyframes zc-ping { 0% { transform: scale(1); opacity: .55 } 70%, 100% { transform: scale(2.8); opacity: 0 } }
.txt { max-width: 46vw; overflow: hidden; text-overflow: ellipsis; }
.sub { color: var(--color-foreground-subtlest, color-mix(in oklab, currentColor 45%, transparent)); font-variant-numeric: tabular-nums; }
.sub:empty { display: none; }
button { appearance: none; border: 0; background: transparent; font: inherit; color: inherit; cursor: pointer; padding: 0; }
.act {
  height: 22px; padding: 0 9px; margin-left: 2px; border-radius: 999px; font-size: 11.5px; font-weight: 500;
  color: var(--color-foreground, #eee);
  background: color-mix(in oklab, var(--color-foreground, #fff) 9%, transparent);
  transition: background .15s ease;
}
.act:hover { background: color-mix(in oklab, var(--color-foreground, #fff) 17%, transparent); }
.act:empty, .act[hidden] { display: none; }
.min {
  width: 22px; height: 22px; border-radius: 999px; display: grid; place-items: center;
  color: var(--color-foreground-subtlest, color-mix(in oklab, currentColor 45%, transparent));
  transition: background .15s ease, color .15s ease;
}
.min:hover { color: var(--color-foreground, #eee); background: var(--color-hover, color-mix(in oklab, var(--color-foreground, #fff) 9%, transparent)); }
.min svg { display: block; }
@media (prefers-reduced-motion: reduce) {
  .pill, .chip { transition: opacity .12s linear; transform: none !important; }
  .wrap[data-busy="1"] .dot::after { animation: none; }
}`;

    function build() {
      if (host || !document.body) return !!host;
      host = document.createElement('div');
      host.id = 'zcode-net-indicator';
      host.setAttribute('data-testid', 'net-indicator');
      host.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:2147483646;pointer-events:none;';
      sr = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.setAttribute('data-mode', 'pill');
      wrap.innerHTML =
        '<div class="pill" role="status" aria-live="polite">' +
        '<span class="dot"></span><span class="txt"></span><span class="sub"></span>' +
        '<button class="act" type="button"></button>' +
        '<button class="min" type="button" title="隐藏" aria-label="隐藏连接指示器">' +
        '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
        '</button></div>' +
        '<button class="chip" type="button" aria-label="显示连接状态"><span class="dot"></span></button>';
      sr.append(style, wrap);
      pill = wrap.querySelector('.pill');
      txtEl = wrap.querySelector('.txt');
      subEl = wrap.querySelector('.sub');
      actEl = wrap.querySelector('.act');
      chip = wrap.querySelector('.chip');
      wrap.querySelector('.min').addEventListener('click', () => { collapsed = true; render(); });
      chip.addEventListener('click', () => { collapsed = false; render(); });
      actEl.addEventListener('click', () => { const a = cur.action; if (a && a.run) a.run(); });
      document.body.appendChild(host);
      const f = pendingRender; pendingRender = null;
      if (f) f();
      return true;
    }

    function whenReady(fn) {
      if (build()) { fn(); return; }
      const first = !pendingRender;
      pendingRender = fn;
      if (first) document.addEventListener('DOMContentLoaded', () => { build(); }, { once: true });
    }

    function render() {
      if (!wrap) return;
      const tone = TONE[cur.state] || '#f0a92a';
      const busy = cur.state === 'connecting' || cur.state === 'reconnecting' || cur.state === 'reloading' ||
        cur.state === 'syncing' || cur.state === 'degraded';
      wrap.style.setProperty('--tone', tone);
      wrap.setAttribute('data-busy', busy ? '1' : '0');
      wrap.setAttribute('data-mode', collapsed ? 'chip' : 'pill');
      txtEl.textContent = cur.text;
      subEl.textContent = cur.sub || '';
      if (cur.action) { actEl.hidden = false; actEl.textContent = cur.action.label; }
      else { actEl.hidden = true; actEl.textContent = ''; }
      const title = cur.text + (cur.sub ? ' ' + cur.sub : '');
      pill.title = title; chip.title = title;
      if (host) { host.dataset.state = cur.state; host.dataset.text = title; }
    }

    function show(visible) { if (wrap) wrap.setAttribute('data-show', visible ? '1' : '0'); }

    return {
      /**
       * @param {string} state connecting|connected|reconnecting|offline|failed|reloading|idle
       * @param {{text?:string, sub?:string, action?:{label:string,run:Function}, autoHideMs?:number, delayMs?:number}} o
       */
      set(state, o) {
        o = o || {};
        cur = { state, text: o.text || '', sub: o.sub || '', action: o.action || null };
        clearTimeout(hideTimer); clearTimeout(showTimer);
        try { window.dispatchEvent(new CustomEvent('zcode-net-state', { detail: { state, text: cur.text, sub: cur.sub } })); } catch {}
        whenReady(() => {
          render();
          if (state === 'idle') { show(false); return; }
          if (o.delayMs) { showTimer = setTimeout(() => { show(true); }, o.delayMs); }
          else show(true);
          if (o.autoHideMs) hideTimer = setTimeout(() => { show(false); collapsed = false; render(); }, o.autoHideMs);
        });
      },
      /** 仅更新副标题（倒计时），不重置动画。 */
      sub(text) { cur.sub = text; if (subEl) { subEl.textContent = text; if (host) host.dataset.text = cur.text + ' ' + text; } },
      get current() { return { state: cur.state, text: cur.text, sub: cur.sub, collapsed }; },
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
    let healthTimer = null, degradedSince = 0, lastHealth = null, peakSubs = 0, verifySeq = 0;
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
      let url = proto + '//' + location.host + '/rpc?cid=' + encodeURIComponent(cid) +
        '&recv=' + recvSeq + '&new=' + (established ? '0' : '1');
      if (tok) url += '&token=' + encodeURIComponent(tok);

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
