// E2E: 重连 + 业务层就绪判定 + 连接指示器
import { createRequire } from 'node:module';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const require2 = createRequire(new URL('../../package.json', import.meta.url));
const WebSocket = require2('ws');
const CHROME = '/root/.cache/chrome-hs/chrome-headless-shell-linux64/chrome-headless-shell';
const PORT = 9372;
const SHOT = process.env.SHOT === '1';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

const proc = spawn(CHROME, ['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--user-data-dir=/tmp/e2e-rc2-profile','--remote-debugging-port='+PORT,'--window-size=1600,950','about:blank'], { stdio: ['ignore','pipe','pipe'] });
let cerr=''; proc.stderr.on('data',(d)=>{cerr+=d;});
const t0=Date.now();
while (Date.now()-t0<15000) { if (cerr.includes('DevTools listening')) break; await sleep(200); }
function cdp(wsUrl){
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256*1024*1024 });
  const ready = new Promise((res, rej) => { ws.on('open', ()=>res()); ws.on('error', rej); });
  let id = 0; const cbs = new Map(); const subs = new Set();
  ws.on('message', (raw) => { const msg = JSON.parse(raw.toString()); if (msg.id && cbs.has(msg.id)) { cbs.get(msg.id)(msg); cbs.delete(msg.id); } else if (msg.method) { for (const h of [...subs]) h(msg); } });
  return { ready, on: (h)=>subs.add(h), send: (method, params={}) => new Promise((res, rej) => { const i = ++id; cbs.set(i, (m) => { if (m.error) rej(new Error(JSON.stringify(m.error).slice(0,300))); else res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); }), close: ()=>ws.close() };
}
const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
const client = cdp(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
await client.ready;
const jsErrors = [];
client.on((m)=>{ if (m.method==='Runtime.exceptionThrown') jsErrors.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0,240)); });
await client.send('Runtime.enable'); await client.send('Page.enable');
// 每次导航后自动装状态记录器（必须在 shim 之前）
await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__netLog = [];
  window.addEventListener('zcode-net-state', (e) => window.__netLog.push(e.detail.state));
` });

const ev = (expr, awaitPromise=false) => client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }).then(r=>r.result?.value);
async function shot(name) {
  if (!SHOT) return;
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`/tmp/rc-${name}.png`, Buffer.from(data,'base64'));
}
async function waitApp(maxSec=80) {
  for (let i=0;i<maxSec;i++) { await sleep(1000); if (await ev(`!!document.querySelector('[data-testid=composer-workspace-trigger]')`)) return i+1; }
  return -1;
}
const netState = () => ev(`(document.getElementById('zcode-net-indicator')||{dataset:{}}).dataset.state || 'none'`);
const netText  = () => ev(`(document.getElementById('zcode-net-indicator')||{dataset:{}}).dataset.text || ''`);
const netView  = () => ev(`(()=>{ const h=document.getElementById('zcode-net-indicator'); if(!h||!h.shadowRoot) return null; const w=h.shadowRoot.querySelector('.wrap'); const b=h.shadowRoot.querySelector('.badge'); const p=h.shadowRoot.querySelector('.panel'); const bc=getComputedStyle(b); const pc=getComputedStyle(p); return { attn: w.getAttribute('data-attn'), open: w.getAttribute('data-open'), busy: w.getAttribute('data-busy'), badgeOpacity: bc.opacity, badgeScale: bc.transform, badgeRect: b.getBoundingClientRect().toJSON(), panelOpacity: pc.opacity, panelVisible: pc.visibility, panelRect: p.getBoundingClientRect().toJSON() }; })()`);
const innerHeightOfPage = () => ev('innerHeight');
const stats = () => ev(`JSON.stringify(window.__zcodeNet ? window.__zcodeNet.stats : null)`).then(s=>JSON.parse(s||'null'));
const netLog = () => ev(`(window.__netLog||[]).join(' → ')`);
async function waitState(target, maxMs=20000) {
  const t = Date.now();
  while (Date.now()-t < maxMs) { if ((await netState()) === target) return Date.now()-t; await sleep(300); }
  return -1;
}

console.log('\n=== 1. 首次加载：业务就绪才算连上 ===');
await client.send('Page.navigate', { url: 'http://127.0.0.1:8080/login' });
for (let i=0;i<15;i++) { await sleep(600); if (await ev(`!!document.querySelector('input')`)) break; }
await ev(`fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'Ij88036082!!'})}).then(r=>r.text())`, true);
await client.send('Page.navigate', { url: 'http://127.0.0.1:8080/' });
const loadSec = await waitApp();
check('应用加载完成', loadSec > 0, loadSec>0?`${loadSec}s`:'超时');
const s1 = await stats();
check('__zcodeNet 已注入', !!s1);
check('业务就绪 ready=true', s1?.ready === true, JSON.stringify(s1?.health));
check('健康探针确认后端 ok', s1?.health?.appServer === 'ok');
check('健康探针返回订阅计数字段', typeof (s1?.health?.subscriptions) === 'number', 'subs=' + s1?.health?.subscriptions);
check('状态序列含 syncing 再 connected', /syncing/.test(await netLog()) && /connected/.test(await netLog()), await netLog());
await sleep(2500);
check('连接正常时徽标回落安静态', (await netView())?.attn === '0');
await shot('idle');

console.log('\n=== 2. 断线 → 重连 → 业务校验 → 已恢复 ===');
const before = await stats();
await ev(`window.__netLog.length = 0; window.__zcodeNet.drop()`);
await sleep(400);
const v = await netView();
check('断线后徽标立即高亮脉冲', v?.attn === '1' && v?.busy === '1', `state=${await netState()}`);
check('断线文案正确', /重连|断开/.test(await netText()), await netText());
await shot('reconnecting');
const tSync = await waitState('syncing', 20000);
check('重连后先进入业务校验(syncing)', tSync >= 0, tSync>=0?`${tSync}ms`:'未观察到');
const tConn = await waitState('connected', 25000);
check('业务校验通过后才宣布已连接', tConn >= 0, tConn>=0?`+${tConn}ms`:'未恢复');
check('恢复文案正确', /恢复/.test(await netText()), await netText());
await shot('recovered');
const after = await stats();
check('会话未重建（cid 不变）', after.cid === before.cid, `${before.cid}`);
check('未整页重载（everReady 保持）', after.everReady === true);
check('业务订阅仍然存活', (after.health?.subscriptions ?? 0) > 0, `subs=${after.health?.subscriptions}（断线前 ${before.health?.subscriptions}）`);
check('序号连续未归零', after.recv > before.recv, `recv ${before.recv} → ${after.recv}`);
console.log('     状态序列:', await netLog());
await sleep(3000);
check('恢复后徽标回落安静态', (await netView())?.attn === '0');

console.log('\n=== 3. 重连后业务功能仍可用 ===');
const ui = await ev(`(()=>{ const t=document.body.innerText; return { composer: !!document.querySelector('[data-testid=composer-workspace-trigger]'), crashed: /ran into a problem|出错了/.test(t), sections: [...document.querySelectorAll('[data-testid$=-section]')].map(e=>e.getAttribute('data-testid')) }; })()`);
check('UI 未崩溃、区块仍在', ui?.composer && !ui?.crashed, JSON.stringify(ui?.sections));
await client.send('Input.dispatchKeyEvent', { type:'keyDown', modifiers:2, key:'k', code:'KeyK', windowsVirtualKeyCode:75 });
await client.send('Input.dispatchKeyEvent', { type:'keyUp', modifiers:2, key:'k', code:'KeyK', windowsVirtualKeyCode:75 });
await sleep(1500);
check('重连后命令面板可打开（RPC 通）', !!(await ev(`[...document.querySelectorAll('input')].some(i=>/搜索|search|命令/i.test(i.placeholder||''))`)));
await client.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
await client.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
await sleep(600);
const afterRpc = await stats();
check('重连后仍有双向流量', afterRpc.sent > after.sent && afterRpc.recv > after.recv, `sent ${after.sent}→${afterRpc.sent}, recv ${after.recv}→${afterRpc.recv}`);

console.log('\n=== 4. 切后台 → 切回前台（含链路已死） ===');
await ev(`window.__netLog.length = 0`);
await client.send('Emulation.setPageVisibilityOverride', { visibility: 'hidden' }).catch(()=>{});
await sleep(600);
await ev(`window.__zcodeNet.drop()`);   // 后台期间链路失效
await sleep(300);
await client.send('Emulation.setPageVisibilityOverride', { visibility: 'visible' }).catch(()=>{});
await ev(`document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'));`);
const tBack = await waitState('connected', 25000);
check('切回前台后自动恢复到已连接', tBack >= 0, tBack>=0?`${tBack}ms`:'未恢复');
check('切回后业务订阅仍在', ((await stats()).health?.subscriptions ?? 0) > 0);
console.log('     状态序列:', await netLog());

console.log('\n=== 5. 前台但链路半开：主动业务探活 ===');
await ev(`window.__netLog.length = 0`);
const sv = await ev(`(async()=>{ const r = await window.__zcodeNet.health(); return r ? { appServer: r.appServer, subs: r.subscriptions } : null; })()`, true);
check('可主动发起业务健康探针', !!sv && sv.appServer === 'ok', JSON.stringify(sv));

console.log('\n=== 6. 指示器交互 / 视觉 ===');
await ev(`window.__zcodeNet.indicator.set('reconnecting', { text: '连接已断开 · 正在重连', sub: '第 3 次' })`);
await sleep(500);
check('状态变化时徽标高亮出现', (await netView())?.attn === '1');
const v6 = await netView();
const box = v6?.badgeRect;
const vh = await innerHeightOfPage();
check('徽标位于内容区左下角、不遮挡侧边栏', box && box.x > 264 && box.x < 340 && box.bottom > vh - 60, JSON.stringify(box) + ' vh=' + vh);
await shot('badge');
await ev(`document.getElementById('zcode-net-indicator').shadowRoot.querySelector('.badge').click()`);
// 面板展开有 180ms opacity + 380ms transform 过渡, 轮询到稳定
let opened = null;
for (let i=0;i<12;i++) {
  await sleep(150);
  opened = await netView();
  if (opened?.open === '1' && opened?.panelOpacity === '1') break;
}
check('点击徽标展开浮动面板', opened?.open === '1' && opened?.panelOpacity === '1' && opened?.panelVisible === 'visible', JSON.stringify({open:opened?.open, po:opened?.panelOpacity, pv:opened?.panelVisible}));
await shot('panel-open');
await ev(`document.getElementById('zcode-net-indicator').shadowRoot.querySelector('.badge').click()`);
await sleep(400);
check('再次点击收回面板', (await netView())?.open === '0');
// 主题一致性：取自应用 CSS 变量
const themed = await ev(`(()=>{ const h=document.getElementById('zcode-net-indicator'); const p=h.shadowRoot.querySelector('.panel'); const cs=getComputedStyle(p); const app=getComputedStyle(document.documentElement); return { bg: cs.backgroundColor, color: cs.color, radius: cs.borderRadius, blur: cs.backdropFilter, appCard: app.getPropertyValue('--color-card').trim(), appFg: app.getPropertyValue('--color-foreground').trim() }; })()`);
check('样式继承应用主题变量', themed && themed.color && themed.bg && themed.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(themed));
await ev(`window.__zcodeNet.indicator.set('idle', {})`);

console.log('\n=== 7. 后端宕机 → 只报「服务未就绪」，不谎称已连接 ===');
await ev(`window.__netLog.length = 0`);
// 注意: app-server 由 bin/zcode.cjs 派生, 自带 process.title='zcode-cli',
// pkill -f "zcode.cjs app-server" 永远匹配不到它。且 pgrep -f 'node server/web-server.mjs'
// 会同时匹配 bash -c 包装进程, 用 pkill -P 直接杀会误杀 web-server 自身 → 服务重启。
// 正确姿势: 锚定 serve.sh 的 node 主进程(独占匹配 ^...node server/web-server.mjs$),
// 再 TERM 它唯一的子进程 zcode-cli。
const killOut = (() => {
  try {
    return execSync(
      `WPID=$(pgrep -f '^.*node server/web-server.mjs$' | head -1); ` +
      `if [ -n "$WPID" ] && pgrep -P "$WPID" >/dev/null; then kill -TERM $(pgrep -P "$WPID"); echo "killed children of $WPID"; else echo "no child found"; fi`,
      { shell: '/bin/bash' }).toString().trim();
  } catch (e) { return String(e.stdout || e.message).trim(); }
})();
console.log('     kill:', killOut);
await sleep(1500);
await ev(`window.__zcodeNet.verify()`);
// 期望序列: 进程死后探针应报 down(或先 busy 后 down) → degraded。
// busy 宽限最多 10 轮×3s ≈ 30s, 观察窗给足 60s; 期间绝不允许宣布「已连接」。
let sawConnectedDuringOutage = false, tDeg = -1;
for (let i=0;i<60;i++) {
  await sleep(1000);
  const st = await netState();
  if (st === 'connected') { sawConnectedDuringOutage = true; break; }
  if (st === 'degraded') { tDeg = (i+1)*1000; break; }
}
const state7 = await netState();
check('后端宕机时进入 degraded', tDeg >= 0, tDeg>=0?`${tDeg}ms — ${await netText()}`:`state=${state7} text=${await netText()}`);
check('宕机期间绝不宣布「已连接」', !sawConnectedDuringOutage, sawConnectedDuringOutage?'在宕机窗口宣布了已连接!':'');
if (tDeg >= 0) {
  check('degraded 时 ready=false', (await stats())?.ready === false);
}
await shot('degraded');
// 恢复: 重启 web 服务(其 main() 会拉起新的 app-server), 客户端走 session-not-found 重载
execSync('systemctl restart zcode-web.service');

console.log('\n=== 8. 服务端重启 → 会话不可恢复 → 自动重载 ===');
const cidBefore = (await stats()).cid;
execSync('systemctl restart zcode-web.service');
let reloaded = false;
for (let i=0;i<70;i++) {
  await sleep(1000);
  const st = await ev(`(()=>{ try { return window.__zcodeNet ? { cid: window.__zcodeNet.stats.cid, state: window.__zcodeNet.state } : null; } catch(e){ return null; } })()`);
  if (st && st.cid && st.cid !== cidBefore) { reloaded = true; console.log(`     新会话 cid=${st.cid} state=${st.state} (${i+1}s)`); break; }
}
check('服务端重启后自动重载并新建会话', reloaded, reloaded?'':'70s 内未重载');
const load2 = await waitApp(80);
check('重载后应用恢复可用', load2 > 0, load2>0?`${load2}s`:'超时');
const s2 = await stats();
check('重载后重新达成业务就绪', s2?.ready === true && s2?.health?.appServer === 'ok', JSON.stringify(s2?.health));
await shot('after-restart');

console.log('\n=== 结果 ===');
const bad = results.filter(r=>!r.ok);
console.log(`通过 ${results.length - bad.length}/${results.length}`);
if (bad.length) console.log('失败项:\n  - ' + bad.map(b=>b.name + (b.detail?` [${b.detail}]`:'')).join('\n  - '));
const fatal = jsErrors.filter(e=>!/ResizeObserver/.test(e));
console.log('JS 异常:', fatal.length ? fatal.slice(0,5) : 'none');
proc.kill('SIGKILL');
process.exit(bad.length ? 1 : 0);
