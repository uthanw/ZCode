// 共享 CDP/WS E2E 基建 —— zcode-web-service 回归套件
// 用法: import { withPage } from './e2e-lib.mjs'
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export const NODE = '/root/.nvm/versions/node/v22.23.2/bin/node';
export const CHROME = '/root/.cache/chrome-hs/chrome-headless-shell-linux64/chrome-headless-shell';
export const BASE = 'http://127.0.0.1:8080';
export const TOKEN = 'Ij88036082!!';

export function requireFromService(name) {
  const req = createRequire('/root/zcode-web-service/package.json');
  return req(name);
}

/** 起一个干净 chrome-headless-shell 并连接 CDP */
export async function launch({ port, profile, width = 1600, height = 900 } = {}) {
  const WebSocket = requireFromService('ws');
  // 端口被占 (上次孤儿) → 直接失败, 避免连上死页面挂死
  try {
    const occupied = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    if (occupied.ok) throw new Error(`E2E port ${port} 已被占用 (孤儿 chrome?): 先清理`);
  } catch (e) { if (e.message?.includes('已被占用')) throw e; }
  const proc = spawn(CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => { err += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { if (err.includes('DevTools listening')) break; await sleep(200); }
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let id = 0; const cbs = new Map(); const subs = new Set();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && cbs.has(msg.id)) { cbs.get(msg.id)(msg); cbs.delete(msg.id); }
    else if (msg.method) { for (const h of [...subs]) h(msg); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    cbs.set(i, (m) => { if (m.error) rej(new Error(JSON.stringify(m.error).slice(0, 300))); else res(m.result); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const on = (h) => subs.add(h);
  const kill = () => { try { proc.kill('SIGKILL'); } catch {} ws.close(); };
  return { send, on, kill };
}

/** 登录 + 打开主界面 (内置真实用户让路检查) */
export async function loginAndOpen(client, opts = {}) {
  if (!opts.skipUserGuard) {
    const clear = await assertNoActiveUser();
    if (!clear) { console.log('FAIL  E2E 中止: 真实用户在线, 让路'); process.exit(3); }
  }
  await client.send('Runtime.enable'); await client.send('Page.enable');
  await client.send('Page.navigate', { url: `${BASE}/login` });
  for (let i = 0; i < 15; i++) {
    await sleep(600);
    const { result } = await client.send('Runtime.evaluate', { expression: `!!document.querySelector('input')`, returnByValue: true });
    if (result?.value) break;
  }
  await client.send('Runtime.evaluate', {
    expression: `fetch('/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({token:'${TOKEN}'}) }).then(r=>r.text())`,
    returnByValue: true, awaitPromise: true,
  });
  // ephemeral=1：E2E 页面会话断开 15s 即回收，不占 10 分钟保活池（防挤掉真实用户会话）
  await client.send('Page.navigate', { url: `${BASE}/?ephemeral=1` });
}

/** eval 便捷封装 */
export async function ev(client, expression) {
  const { result } = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  return result?.value;
}

/** 真实鼠标点击 */
export async function click(client, x, y) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(120);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(80);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** Ctrl+K 打开命令中心 — 自带焦点前置 + 重试。
 *  headless 下 Ctrl+K 偶发失灵 (焦点不在 body / app-server 冷启动慢), 单发不可靠。
 *  判定: 「搜索并执行」文本出现 (面板标题固定文案)。 */
export async function openCommandPalette(client, { attempts = 4 } = {}) {
  for (let a = 0; a < attempts; a++) {
    // 焦点前置: 点页面空白处, 保证 keydown 落到 body
    await click(client, 700, 450);
    await sleep(150);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
    await sleep(1200);
    let open = await ev(client, `document.body.innerText.includes('搜索并执行')`);
    if (!open) { await sleep(1000); open = await ev(client, `document.body.innerText.includes('搜索并执行')`); }
    if (open) return true;
    console.log(`openCommandPalette: 第 ${a} 次未开, 重试`);
  }
  return false;
}

/** 在已打开的命令面板里输入并点击匹配项 — 返回是否点击成功 */
export async function palettePick(client, text, label) {
  await client.send('Input.insertText', { text });
  await sleep(900);
  const item = await ev(client, `(() => {
    const el = [...document.querySelectorAll('[role=option]')].find(e => (e.textContent||'').includes(${JSON.stringify(label)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`);
  if (!item) return false;
  await click(client, item.x, item.y);
  return true;
}

/** 真实用户活跃检测 — E2E 让路。
 *  964MB 小机上 chrome E2E 会挤压 node 服务, 导致真实用户 WS 心跳超时掉线
 *  (13:18 实测: 用户重连风暴 395+354+157 帧重放)。E2E 前调用, 活跃则退出等待。 */
export async function assertNoActiveUser({ quietMinutes = 4 } = {}) {
  const fs = await import('node:fs');
  const REAL_IP = '39.144.55.67';
  try {
    const log = fs.readFileSync('/tmp/web-server.log', 'utf8');
    const lines = log.split('\n');
    // 找最近一次真实用户活动行 (browser:ws from IP 或 rpc 会话活动)
    let last = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(REAL_IP)) { last = lines[i]; break; }
    }
    if (!last) return true;
    const m = last.match(/\[web (\d{2}):(\d{2}):(\d{2})\]/);
    if (!m) return true; // 无时间戳的老日志行, 视为陈旧
    const [ , hh, mm, ss ] = m;
    const now = new Date();
    const t = hh * 3600 + mm * 60 + ss * 1;
    const n = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const ageMin = (n - t) / 60;
    if (ageMin >= 0 && ageMin < quietMinutes) {
      console.log(`SKIP  真实用户 ${ageMin.toFixed(1)} 分钟前仍活跃, E2E 让路 (等待或稍后重试)`);
      return false;
    }
  } catch { /* 日志不可读时放行 */ }
  return true;
}
