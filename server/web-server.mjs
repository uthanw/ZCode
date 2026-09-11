// server/web-server.mjs —— ZCode Web IDE 主服务器
// - HTTP: 静态托管 ../renderer（未修改的 ZCode 渲染器资产）+ 注入 port-shim
// - WebSocket /rpc: 每条连接桥接为一个 ChannelServer（二进制 channel 协议）
// - app-server: 常驻 zcode.cjs 子进程（agent 后端）
// - 登录门户 /login（shadcn 风格）：未认证浏览器请求 302 到门户，token 换 HttpOnly cookie
'use strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'renderer');
const ZCODE_CLI = path.join(ROOT, 'bin', 'zcode.cjs');
const WORKSPACE_ROOT = process.env.ZCODE_WEB_WORKSPACE || path.join(ROOT, 'workspace');
const PORT = Number(process.env.ZCODE_WEB_PORT || 8443);
const HOST = process.env.ZCODE_WEB_HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.ZCODE_WEB_TOKEN || ''; // 可选 Bearer token

const { WebSocketServer } = require('ws');
const { Emitter, VSBuffer, ChannelServer, MessagePortProtocol, WebSocketMessagePort, fromService } = require('./lib/rpc.js');
const { ResumableSession } = require('./lib/resumable.js');
const { AppServerClient } = require('./lib/zcode-app-server.js');
const { CHANNELS, buildAllChannels } = require('./services/index.js');

const logger = (() => {
  const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  return {
    info: (...a) => console.log(`[web ${ts()}]`, ...a),
    warn: (...a) => console.warn(`[web ${ts()}]`, ...a),
    error: (...a) => console.error(`[web ${ts()}]`, ...a),
    debug: (...a) => { if (process.env.ZCODE_WEB_DEBUG) console.log(`[web:debug ${ts()}]`, ...a); },
  };
})();

// ---------- MIME ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
  '.wasm': 'application/wasm', '.map': 'application/json',
};

// ---------- 启动 app-server ----------
async function startAppServer() {
  await fsp.mkdir(WORKSPACE_ROOT, { recursive: true });
  const client = new AppServerClient({
    command: process.execPath,
    args: [ZCODE_CLI, 'app-server'],
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, ZCODE_LOG_DIR: path.join(os.homedir(), '.zcode', 'cli', 'log') },
    logger,
  });
  await client.start();
  logger.info('app-server 已启动 (zcode.cjs app-server --stdio)');
  return client;
}

// ---------- 静态文件 ----------
const SHIM_PATH = path.join(__dirname, 'inject', 'port-shim.js');
let shimCache = null;
async function getShim() {
  if (!shimCache) shimCache = await fsp.readFile(SHIM_PATH, 'utf8');
  return shimCache;
}

// ---------- 压缩 + 缓存 ----------
// renderer 资源总量 ~58MB（styles-*.js 单文件 4.5MB），必须压缩 + 强缓存，
// 否则每次刷新都全量明文重传。资源名带内容哈希 → 可安全 immutable 缓存一年。
const zlib = require('node:zlib');
const CACHE_DIR = path.join(ROOT, '.cache', 'compressed');
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.map', '.wasm', '.html', '.txt', '.ttf', '.otf']);
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/; // vite 内容哈希文件名
const memCache = new Map(); // key -> {buf, enc}
const MEM_LIMIT = 96 * 1024 * 1024;
let memBytes = 0;
const inflight = new Map();

function cacheKey(target, st, enc) {
  return `${target}|${st.size}|${Number(st.mtimeMs).toString(36)}|${enc}`;
}

async function compressOnce(target, st, enc) {
  const key = cacheKey(target, st, enc);
  const hit = memCache.get(key);
  if (hit) return hit;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const diskName = Buffer.from(key).toString('base64url') + (enc === 'br' ? '.br' : '.gz');
    const diskPath = path.join(CACHE_DIR, diskName);
    let buf;
    try {
      buf = await fsp.readFile(diskPath); // 磁盘缓存命中（跨进程重启保留）
    } catch {
      const raw = await fsp.readFile(target);
      buf = await new Promise((resolve, reject) => {
        const cb = (e, r) => (e ? reject(e) : resolve(r));
        if (enc === 'br') {
          zlib.brotliCompress(raw, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 5, // 5 = 压缩率/耗时的平衡点
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
          }, cb);
        } else {
          zlib.gzip(raw, { level: 6 }, cb);
        }
      });
      fsp.mkdir(CACHE_DIR, { recursive: true }).then(() => fsp.writeFile(diskPath, buf)).catch(() => {});
    }
    const entry = { buf, enc };
    if (buf.length < 12 * 1024 * 1024 && memBytes + buf.length < MEM_LIMIT) {
      memCache.set(key, entry); memBytes += buf.length;
    }
    return entry;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

function pickEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

async function sendFile(req, res, target, st) {
  const ext = path.extname(target).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const immutable = HASHED_ASSET.test(path.basename(target));
  const headers = {
    'content-type': mime,
    etag,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
    vary: 'Accept-Encoding',
  };

  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }

  const enc = COMPRESSIBLE.has(ext) && st.size > 1024 ? pickEncoding(req) : null;
  if (enc) {
    try {
      const { buf } = await compressOnce(target, st, enc);
      headers['content-encoding'] = enc;
      headers['content-length'] = String(buf.length);
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : buf);
      return;
    } catch (e) { logger.warn('压缩失败，回退明文:', path.basename(target), e.message); }
  }
  headers['content-length'] = String(st.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(target).pipe(res);
}

async function serveHtml(req, res) {
  let html = await fsp.readFile(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  const shim = await getShim();
  html = html.replace('<script type="module"', `<script>${shim}</script>\n    <script type="module"`);
  const body = Buffer.from(html, 'utf8');
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept-Encoding' };
  const enc = pickEncoding(req);
  if (enc) {
    const buf = await new Promise((resolve, reject) => {
      const cb = (e, r) => (e ? reject(e) : resolve(r));
      if (enc === 'br') zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, cb);
      else zlib.gzip(body, { level: 6 }, cb);
    }).catch(() => null);
    if (buf) {
      headers['content-encoding'] = enc;
      headers['content-length'] = String(buf.length);
      res.writeHead(200, headers); res.end(buf); return;
    }
  }
  headers['content-length'] = String(body.length);
  res.writeHead(200, headers); res.end(body);
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '/index.html') { await serveHtml(req, res); return; }
  // 归一化防目录穿越
  const filePath = path.normalize(path.join(RENDERER_DIR, urlPath));
  if (!filePath.startsWith(RENDERER_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const st = await fsp.stat(filePath);
    if (st.isDirectory()) {
      const idx = path.join(filePath, 'index.html');
      const ist = await fsp.stat(idx);
      await sendFile(req, res, idx, ist);
      return;
    }
    await sendFile(req, res, filePath, st);
  } catch {
    // SPA fallback（renderer 只有 index.html 一个入口）
    if (!path.extname(urlPath)) {
      try { await serveHtml(req, res); return; } catch {}
    }
    res.writeHead(404); res.end('not found');
  }
}

/** 后台预压缩：首屏关键资源先压好，避免用户第一次访问时等在压缩上。 */
async function precompressAssets() {
  const t0 = Date.now();
  let files = [];
  async function walk(dir) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (COMPRESSIBLE.has(path.extname(e.name).toLowerCase())) files.push(p);
    }
  }
  try { await walk(RENDERER_DIR); } catch { return; }
  const stats = await Promise.all(files.map(async (f) => ({ f, st: await fsp.stat(f).catch(() => null) })));
  // 大文件优先（首屏 JS 都是大块），只预压 > 8KB 的
  const targets = stats.filter((x) => x.st && x.st.size > 8 * 1024).sort((a, b) => b.st.size - a.st.size);
  let done = 0, bytesIn = 0, bytesOut = 0;
  const CONC = Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 1));
  let cursor = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (cursor < targets.length) {
      const { f, st } = targets[cursor++];
      try {
        const { buf } = await compressOnce(f, st, 'br');
        bytesIn += st.size; bytesOut += buf.length; done++;
      } catch {}
    }
  }));
  logger.info(`预压缩完成: ${done} 个文件 ${(bytesIn / 1048576).toFixed(1)}MB → ${(bytesOut / 1048576).toFixed(1)}MB (${((1 - bytesOut / bytesIn) * 100).toFixed(0)}% 压缩率), 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---------- 登录门户 ----------
// 未认证的浏览器访问不再裸 401：302 → /login 门户页；提交 token → 种 HttpOnly cookie → 回工作台。
// API/脚本语义保持不变（Bearer / ?token= 直通，校验失败仍 401 JSON）。
const LOGIN_HTML_PATH = path.join(__dirname, 'inject', 'login.html');
let loginHtmlCache = null;
async function getLoginHtml() {
  if (!loginHtmlCache) loginHtmlCache = await fsp.readFile(LOGIN_HTML_PATH, 'utf8');
  return loginHtmlCache;
}

function cookieFromReq(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)zcode-web-token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function tokenFromReq(req) {
  if (!AUTH_TOKEN) return '';
  const url = new URL(req.url || '/', 'http://x');
  const auth = req.headers['authorization'] || '';
  return auth.replace(/^Bearer\s+/i, '') || cookieFromReq(req) || url.searchParams.get('token') || '';
}

/** 浏览器导航请求（非 fetch/XHR）→ 跳登录页；否则保持 401 语义。 */
function wantsLoginPage(req) {
  if ((req.headers.accept || '').includes('text/html')) return true;
  const u = (req.url || '').split('?')[0];
  return u === '/' || u === '/index.html' || (!path.extname(u) && !req.headers['authorization']);
}

async function serveLoginPage(res, errorMsg) {
  let html = await getLoginHtml();
  if (errorMsg) {
    // 把失败提示预置进 alert（无 JS 也能看到）
    html = html.replace('<div class="alert" id="alert" role="alert"></div>',
      `<div class="alert show" id="alert" role="alert">${errorMsg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</div>`);
  }
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function handleLoginPost(req, res) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > 16 * 1024) { res.writeHead(413); res.end(); return; } }
  let token = '';
  try { const j = JSON.parse(body); token = String(j.token || ''); } catch {
    // 兼容表单提交（application/x-www-form-urlencoded）
    try { token = String(new URLSearchParams(body).get('token') || ''); } catch {}
  }
  if (AUTH_TOKEN && token && token === AUTH_TOKEN) {
    logger.info('登录成功:', req.socket.remoteAddress);
    // HttpOnly：JS 不可读，防 XSS 窃取；SameSite=Lax：正常导航携带、跨站 POST 不带
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `zcode-web-token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({ ok: true }));
  } else {
    logger.warn('登录失败:', req.socket.remoteAddress);
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: '令牌无效，请检查后重试' }));
  }
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  // 登录门户路由（未认证时的唯一入口）
  const urlPath0 = (req.url || '/').split('?')[0];
  if (AUTH_TOKEN) {
    if (urlPath0 === '/login') {
      if (req.method === 'POST') { await handleLoginPost(req, res); return; }
      // 已持有有效 cookie 的访问 /login → 直接进工作台
      if (tokenFromReq(req) === AUTH_TOKEN) { res.writeHead(302, { location: '/' }); res.end(); return; }
      await serveLoginPage(res); return;
    }
    if (urlPath0 === '/logout') {
      res.writeHead(302, { 'set-cookie': 'zcode-web-token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0', location: '/login' });
      res.end(); return;
    }
    if (tokenFromReq(req) !== AUTH_TOKEN) {
      if (wantsLoginPage(req)) { res.writeHead(302, { location: '/login' }); res.end(); return; }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }
  // 浏览器端调试回传（port-shim 的 beacon）：把前端报错写进服务端日志
  if (req.method === 'POST' && (req.url || '').split('?')[0] === '/__debug') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const r = JSON.parse(body);
        logger.info(`[browser:${r.kind}] ${r.msg}${r.extra ? '\n    ' + String(r.extra).split('\n').slice(0, 12).join('\n    ') : ''}`);
      } catch { logger.warn('[browser] 无法解析调试回传:', body.slice(0, 200)); }
      res.writeHead(204); res.end();
    });
    return;
  }
  try { await serveStatic(req, res); }
  catch (e) { logger.error('static error:', e); res.writeHead(500); res.end('internal error'); }
});

// ---------- WebSocket /rpc ----------
const wss = new WebSocketServer({ noServer: true });
const sessions = new Set();

// 可恢复 RPC 会话池：cid（每次页面加载生成一次）→ { session, channelServer, protocol }
// 断线重连时复用同一个 ChannelServer，保住事件订阅与进行中的请求（详见 lib/resumable.js 顶部说明）。
const rpcSessions = new Map();
const RESUME_GRACE_MS = Number(process.env.ZCODE_WEB_RESUME_GRACE_MS || 10 * 60 * 1000);
const MAX_RESUMABLE_SESSIONS = Number(process.env.ZCODE_WEB_MAX_SESSIONS || 64);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/rpc') { socket.destroy(); return; }
  if (AUTH_TOKEN) {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || cookieFromReq(req) || url.searchParams.get('token') || '';
    if (token !== AUTH_TOKEN) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

async function main() {
  const appServer = await startAppServer();
  const configPath = path.join(os.homedir(), '.zcode/cli/config.json');
  const services = buildAllChannels({ appServer, workspaceRoot: WORKSPACE_ROOT, logger, configPath });

  // ---------- 业务层健康探针 ----------
  // 「WebSocket 连上」≠「可以用了」：app-server 子进程可能已经死了，或者会话恢复后
  // 订阅其实已经全丢。前端必须能在宣布「已连接」之前验证这两件事，所以这里给每个会话
  // 挂一个专用 channel，由 port-shim 直接（绕过渲染器）发起真实 RPC 往返来验收。
  let backendProbe = { at: 0, ok: false, error: '未探测' };
  let backendInflight = null;
  const BACKEND_TTL_MS = 3000;
  function probeBackend() {
    if (Date.now() - backendProbe.at < BACKEND_TTL_MS) return Promise.resolve(backendProbe);
    if (backendInflight) return backendInflight;
    backendInflight = (async () => {
      let next;
      try {
        if (!appServer.proc || appServer.proc.exitCode !== null) throw new Error('app-server 进程已退出');
        await appServer.request('workspace/readState', { workspace: WORKSPACE_ROOT }, { timeoutMs: 8000 });
        next = { at: Date.now(), ok: true, error: '' };
      } catch (e) {
        next = { at: Date.now(), ok: false, error: String(e?.message || e).slice(0, 180) };
      }
      backendProbe = next;
      backendInflight = null;
      return next;
    })();
    return backendInflight;
  }

  function buildHealthService(session, channelServer) {
    return {
      async ping(arg) {
        const backend = await probeBackend();
        return {
          ok: backend.ok,
          ts: Date.now(),
          echo: arg && arg.t,
          appServer: backend.ok ? 'ok' : 'down',
          appServerError: backend.ok ? undefined : backend.error,
          // 本会话在服务端真实存活的**事件订阅**数（不含进行中的一次性请求）
          subscriptions: channelServer.eventRequests.size,
          inflight: channelServer.activeRequests.size,
          channels: channelServer.channels.size,
          transport: session.stats(),
        };
      },
    };
  }

  /** 把服务表注册到一个 ChannelServer 上（含 model-provider 形状诊断包装）。 */
  function registerServices(channelServer, session) {
    for (const [name, svc] of Object.entries(services)) {
      // 诊断：model-provider 的数组类方法返回时把形状摘要写进日志，
      // 用于核对渲染器收到的真实数据（排查形状契约 mismatches）。
      if (name === 'model-provider') {
        const wrapped = { ...svc };
        for (const m of ['getAll', 'getAllCached']) {
          if (typeof svc[m] === 'function') {
            wrapped[m] = async (...a) => {
              const out = await svc[m](...a);
              try {
                const digest = (Array.isArray(out) ? out : []).slice(0, 3).map((p) => ({
                  id: p?.id, name: p?.name, apiKeyType: typeof p?.apiKey, apiKeyRequired: p?.apiKeyRequired,
                  nModels: Array.isArray(p?.models) ? p.models.length : 'NOT_ARRAY',
                  model0: p?.models?.[0] ? { id: p.models[0].id, idType: typeof p.models[0].id, keys: Object.keys(p.models[0]).slice(0, 8) } : null,
                }));
                logger.info(`[diag] ${m} 返回: ${JSON.stringify(digest)}`);
              } catch (e) { logger.warn(`[diag] ${m} 摘要失败: ${e.message}`); }
              return out;
            };
          }
        }
        channelServer.registerChannel(name, fromService(wrapped));
        continue;
      }
      channelServer.registerChannel(name, fromService(svc));
    }
    channelServer.registerChannel('zcode-web-health', fromService(buildHealthService(session, channelServer)));
  }

  function destroySession(cid, reason) {
    const entry = rpcSessions.get(cid);
    if (!entry) return;
    rpcSessions.delete(cid);
    sessions.delete(entry.channelServer);
    try { entry.channelServer.dispose(); } catch {}
    try { entry.session.dispose(reason); } catch {}
    logger.info(`RPC 会话已回收 cid=${cid} (${reason})，剩余 ${rpcSessions.size} 个`);
  }

  /** 会话数上限保护：优先淘汰已断开且最久未活动的会话。 */
  function evictIfNeeded() {
    while (rpcSessions.size >= MAX_RESUMABLE_SESSIONS) {
      let victim = null;
      for (const [cid, e] of rpcSessions) {
        if (e.session.isAttached) continue;
        if (!victim || e.session.lastActiveAt < victim.e.session.lastActiveAt) victim = { cid, e };
      }
      if (!victim) { // 全部在线：淘汰最老的一个，避免无界增长
        const first = rpcSessions.keys().next();
        if (first.done) return;
        victim = { cid: first.value, e: rpcSessions.get(first.value) };
      }
      destroySession(victim.cid, '会话数超限淘汰');
    }
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/rpc', 'http://x');
    const cid = url.searchParams.get('cid') || `anon-${Math.random().toString(36).slice(2, 10)}`;
    const clientRecv = Number(url.searchParams.get('recv') || 0) || 0;
    ws.binaryType = 'nodebuffer';

    const existing = rpcSessions.get(cid);
    if (existing) {
      const r = existing.session.attach(ws, clientRecv);
      if (r.ok) {
        logger.info(`RPC 客户端重连 cid=${cid} ${req.socket.remoteAddress} · ${JSON.stringify(existing.session.stats())}`);
        return;
      }
      // attach 已把 resumed:false 告知客户端（它会整页重载并用新 cid 接入），这里直接回收。
      logger.warn(`RPC 会话无法恢复 cid=${cid}: ${r.reason}`);
      destroySession(cid, r.reason || 'not-resumable');
      return;
    }

    // 客户端在恢复一个服务端已不存在的会话（最常见：服务重启过）。
    // 直接告知不可恢复即可，不要为一个马上就要重载的页面白建一整套 ChannelServer。
    if (url.searchParams.get('new') !== '1') {
      logger.warn(`RPC 会话不存在 cid=${cid}（服务重启？），要求客户端重载`);
      try { ws.send(JSON.stringify({ __zcodeRpcHello: 'v1', cid, resumed: false, recv: 0, reason: 'session-not-found' })); } catch {}
      setTimeout(() => { try { ws.close(); } catch {} }, 200);
      return;
    }

    evictIfNeeded();
    logger.info(`RPC 客户端已连接 cid=${cid} ${req.socket.remoteAddress}`);
    const session = new ResumableSession({
      cid, logger, graceMs: RESUME_GRACE_MS,
      onExpire: () => destroySession(cid, '宽限期超时'),
    });
    const protocol = new MessagePortProtocol(session);
    const channelServer = new ChannelServer(protocol, null, 1000, true /*deferInit*/);
    registerServices(channelServer, session);
    channelServer.ready();

    rpcSessions.set(cid, { session, protocol, channelServer });
    sessions.add(channelServer);
    // 首连：hello.resumed=false（客户端首连不会因此重载），随后重放 ready() 的初始化帧。
    session.attach(ws, 0, true);
  });

  server.listen(PORT, HOST, () => {
    logger.info(`ZCode Web IDE: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    logger.info(`工作区: ${WORKSPACE_ROOT}`);
    logger.info(`renderer: ${RENDERER_DIR}`);
    logger.info(`RPC 会话保活: ${Math.round(RESUME_GRACE_MS / 1000)}s，最多 ${MAX_RESUMABLE_SESSIONS} 个`);
    // 后台预压缩（不阻塞启动，也不阻塞请求：请求命中未压完的文件会自行按需压缩）
    precompressAssets().catch((e) => logger.warn('预压缩失败:', e.message));
  });
}

// ---------- 进程级兜底：公网服务不允许被单个异常拖死 ----------
// 教训：渲染器订阅一个未实现的事件（onDidChangeProviderRegistry）曾使 onEventListen 同步抛错，
// 无人捕获 → 整个 web 服务进程退出 → 反向代理 502。RPC 层已逐层隔离，这里再加最后一道网。
process.on('uncaughtException', (e) => {
  logger.error('未捕获异常（已隔离，服务继续运行）:', e?.stack || e);
});
process.on('unhandledRejection', (e) => {
  logger.error('未处理的 Promise 拒绝（已隔离）:', (e && e.stack) || e);
});

main().catch((e) => { logger.error('fatal:', e); process.exit(1); });
