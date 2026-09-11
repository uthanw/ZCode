// server/services/index.js —— 37 个 channel 的 Node 端实现。
// 核心链路 (File/System/Setting/Terminal + ZCodeSession/ZCodeTask/ZCodeAgent + FileWatcher/ModelProvider)
// 真实现；其余给最小 stub，保证渲染器启动不 404。
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Emitter, toDisposable } = require('../lib/rpc');
const { buildZodeSessionService, buildZCodeTaskService, buildZCodeAgentService, AgentEventHub } = require('./agent-services');

// 37 channel names (与 renderer src-CdedQslh.js Ow 枚举一致)
const CHANNELS = {
  File: 'file', MediaPreview: 'media-preview', System: 'system', Terminal: 'terminal',
  Git: 'git', GitCheckpoint: 'git-checkpoint', Setting: 'setting', Credential: 'credential',
  CuaPermission: 'cua-permission', CuaPipSession: 'cua-pip-session', Broadcast: 'broadcast',
  ZCodeTask: 'zcode-task', WindowController: 'window-controller', ZCodeAgent: 'zcode-agent',
  ZCodeSession: 'zcode-session', FileWatcher: 'file-watcher', OAuth: 'oauth',
  ModelProvider: 'model-provider', UsageStats: 'usage-stats',
  CodingPlanSubscription: 'coding-plan-subscription', ClientScenes: 'client-scenes',
  Skills: 'skills', SkillSync: 'skill-sync', McpSync: 'mcp-sync', PluginSync: 'plugin-sync',
  Plugins: 'plugins', PluginManagement: 'plugin-management', Subagents: 'subagents',
  Commands: 'commands', Hooks: 'hooks', Memory: 'memory', OutputStyle: 'output-style',
  SettingsSync: 'settings-sync', Bots: 'bots', Feedback: 'feedback', RepoWiki: 'repo-wiki',
  PromptAttachmentTransfer: 'prompt-attachment-transfer', OffPeakTask: 'off-peak-task',
};

// ---------- helpers ----------
function entryOf(name, st, basePath) {
  const isSym = st.isSymbolicLink();
  return {
    name,
    path: path.join(basePath, name),
    type: isSym ? 'directory' : st.isDirectory() ? 'directory' : 'file',
    isSymbolicLink: isSym,
    size: st.isFile() ? st.size : undefined,
    mtimeMs: st.mtimeMs,
    mode: st.mode,
  };
}

// ---------- File ----------
function fileService({ logger, workspaceRoot }) {
  return {
    async stat({ path: p }) {
      if (typeof p !== 'string') throw new Error('stat: path required');
      const st = await fsp.lstat(p);
      const e = entryOf(path.basename(p), st, path.dirname(p));
      if (st.isFile()) e.content = undefined;
      return e;
    },
    async readdir({ path: p, includeHidden }) {
      if (typeof p !== 'string') throw new Error('readdir: path required');
      const names = await fsp.readdir(p);
      const out = [];
      for (const name of names) {
        if (!includeHidden && name.startsWith('.')) continue;
        try {
          const st = await fsp.lstat(path.join(p, name));
          out.push(entryOf(name, st, p));
        } catch { /* 权限/竞态跳过 */ }
      }
      return out;
    },
    async readFile({ path: p }) {
      const b = await fsp.readFile(p);
      return { dataBase64: b.toString('base64'), totalBytes: b.length };
    },
    async readMediaPreview({ path: p, maxBytes }) {
      const b = await fsp.readFile(p);
      const ext = path.extname(p).toLowerCase();
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf' };
      return { dataBase64: b.subarray(0, maxBytes ?? b.length).toString('base64'), mediaType: types[ext] ?? 'application/octet-stream', path: p, totalBytes: b.length };
    },
    async resolvePath({ path: p }) {
      return { path: path.resolve(p) };
    },
    async exists({ path: p }) { return { exists: fs.existsSync(p) }; },
    async mkdir({ path: p }) { await fsp.mkdir(p, { recursive: true }); return { path: p }; },
    async writeFile({ path: p, dataBase64 }) { await fsp.writeFile(p, Buffer.from(dataBase64, 'base64')); return { path: p }; },
    async remove({ path: p }) { await fsp.rm(p, { recursive: true, force: true }); return { path: p }; },
    async rename({ from, to }) { await fsp.rename(from, to); return { path: to }; },
    async createScratchWorkspace() {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zcode-scratch-'));
      return { workspacePath: dir };
    },
    async ensureConversationWorkspace({ workspacePath } = {}) {
      // 与 Electron 版 host 实现对齐: conversation workspace = ~/.zcode/workspace/default
      // (原版 ex() = join(HOME, '.zcode', 'workspace', 'default'))。
      // 绝不能返回项目 workspaceRoot —— 否则 conversation tab 与 project tab 路径相同，
      // 刷新后 tab restore 混乱，导致「所有对话不可见」。
      // 渲染器消费 **.path** 字段（`(await ensureConversationWorkspace()).path`）。
      const dir = typeof workspacePath === 'string' && workspacePath
        ? workspacePath
        : path.join(os.homedir(), '.zcode', 'workspace', 'default');
      try { await fsp.mkdir(dir, { recursive: true }); } catch (e) { logger.warn?.('ensureConversationWorkspace mkdir:', e.message); }
      return { path: dir, workspacePath: dir, workspacePurpose: 'conversation', created: true };
    },
    async saveFile() { return { success: false, error: 'not_supported' }; },
    async selectFile() { return { success: false, error: 'not_supported' }; },
    async selectDirectory() { return { success: false, error: 'not_supported' }; },
    // 渲染器 hooks (useTaskSessionFilePath 等) 批量探测文件存在性
    async checkFilesExist({ paths } = {}) {
      const list = Array.isArray(paths) ? paths : [];
      const results = {};
      await Promise.all(list.map(async (p) => {
        if (typeof p !== 'string') return;
        try { results[p] = (await fsp.stat(p)).isFile(); } catch { results[p] = false; }
      }));
      return { results };
    },
    // 工作区文件检索 (composer @ 提及 / 命令面板 files scope)
    // ⚠️ 契约: 返回裸数组 [{name, path, relativePath, type}] —— 渲染器 Dbe() 直接 .filter，
    // 包一层 {files:[...]} 会崩 section ("e.filter is not a function")。与原版 host 一致。
    // 过滤规则也对齐原版: 跳过 vcs/构建目录、隐藏目录、.env*、二进制扩展名。
    async listWorkspaceFiles({ rootPath, workspacePath } = {}) {
      const root = typeof rootPath === 'string' && rootPath ? rootPath
        : (typeof workspacePath === 'string' && workspacePath ? workspacePath : workspaceRoot);
      const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'bower_components', 'jspm_packages', '__pycache__', 'site-packages', 'venv', 'coverage', 'htmlcov', 'lcov-report', 'cmakefiles', 'pods', 'deriveddata', 'storybook-static', 'playwright-report', 'test-results', 'allure-results', 'allure-report', 'cdk.out', 'eggs', 'pip-wheel-metadata', 'wheels']);
      const SKIP_DIR_PREFIX = ['cmake-build-', 'bazel-'];
      const SKIP_DIR_SUFFIX = ['.egg-info', '.dist-info'];
      const SKIP_FILES = new Set(['coverage.out', 'lcov.info']);
      const BINARY_EXT = new Set(['.a', '.aar', '.beam', '.class', '.dll', '.dylib', '.ear', '.exe', '.gcda', '.gcno', '.gem', '.hi', '.idb', '.ilk', '.jar', '.lib', '.node', '.nupkg', '.o', '.obj', '.pdb', '.profdata', '.profraw', '.pyc', '.pyo', '.rlib', '.so', '.tsbuildinfo', '.war']);
      const shouldSkipDir = (name) => {
        const t = name.toLowerCase();
        return SKIP_DIRS.has(t) || SKIP_DIR_PREFIX.some((p) => t.startsWith(p)) || SKIP_DIR_SUFFIX.some((p) => t.endsWith(p));
      };
      const shouldSkipFile = (name) => {
        const t = name.toLowerCase();
        return t === '.env' || t.startsWith('.env.') || SKIP_FILES.has(t) || BINARY_EXT.has(path.extname(t));
      };
      const out = [];
      const stack = [root];
      while (stack.length > 0) {
        const dir = stack.pop();
        if (!dir) continue;
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          const rel = path.relative(root, full) || ent.name;
          const type = ent.isDirectory() ? 'directory' : (ent.isSymbolicLink() ? 'symlink' : 'file');
          // 原版规则: 隐藏目录内的一切都不列出
          const inHidden = rel.split(path.sep).slice(0, -1).some((p) => p.startsWith('.'));
          if (type === 'directory') {
            if (shouldSkipDir(ent.name)) continue;
            if (!ent.name.startsWith('.') && !inHidden) out.push({ name: ent.name, path: full, relativePath: rel, type });
            if (!ent.isSymbolicLink()) stack.push(full);
          } else {
            if (shouldSkipFile(ent.name) || inHidden) continue;
            out.push({ name: ent.name, path: full, relativePath: rel, type });
          }
          if (out.length >= 5000) break;
        }
        if (out.length >= 5000) break;
      }
      // 原版排序: 目录在前, 同类按 relativePath 字典序
      out.sort((a, b) => (a.type !== b.type
        ? (a.type === 'directory' ? -1 : 1)
        : String(a.relativePath).localeCompare(String(b.relativePath))));
      return out;
    },
    // 轻量文本读取 (设置页/命令文件预览)
    async readTextFile({ path: p, maxBytes } = {}) {
      if (typeof p !== 'string') throw new Error('readTextFile: path required');
      const b = await fsp.readFile(p);
      const sliced = Number.isFinite(maxBytes) && maxBytes > 0 ? b.subarray(0, maxBytes) : b;
      return { text: sliced.toString('utf8'), totalBytes: b.length, truncated: sliced.length < b.length };
    },
    // 二进制预览 (图片/音视频 attach 前的快速探测)
    async readBinaryPreview({ path: p, maxBytes } = {}) {
      if (typeof p !== 'string') throw new Error('readBinaryPreview: path required');
      const st = await fsp.stat(p);
      const len = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, st.size) : Math.min(st.size, 2 * 1024 * 1024);
      const fh = await fsp.open(p, 'r');
      try {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, 0);
        return { dataBase64: buf.subarray(0, bytesRead).toString('base64'), totalBytes: st.size, truncated: bytesRead < st.size };
      } finally { await fh.close(); }
    },
  };
}

// ---------- System ----------
function systemService() {
  return {
    async info() {
      return { homedir: os.homedir(), platform: process.platform, arch: process.arch, hostname: os.hostname(), release: os.release(), totalMem: os.totalmem(), freeMem: os.freemem(), cpus: os.cpus().length };
    },
    async listIntegratedTerminalShells() { return []; },
    async getSystemLocale() { return { locale: 'en-US' }; },
    async openExternal() { return { success: false, error: 'not_supported' }; },
    async revealInFileManager() { return { success: false }; },
    // nPt() IntranetProbe: r?.isIntranet ?? false
    async probeIntranet() { return { isIntranet: false }; },
  };
}

// ---------- Web IDE 持久化状态（首启标记 / display order 等） ----------
const WEB_STATE_FILE = () => path.join(os.homedir(), '.zcode', 'web-ide-state.json');
async function loadWebState() {
  try { return JSON.parse(await fsp.readFile(WEB_STATE_FILE(), 'utf8')) ?? {}; }
  catch { return {}; }
}
async function saveWebState(st) {
  try {
    await fsp.mkdir(path.dirname(WEB_STATE_FILE()), { recursive: true });
    await fsp.writeFile(WEB_STATE_FILE(), JSON.stringify(st, null, 2));
  } catch (e) { console.warn('[web-state] save failed:', e?.message ?? e); }
}

// ---------- Setting ----------
const SETTING_FILE = () => path.join(os.homedir(), '.zcode', 'web-ide-settings.json');
const DEFAULT_SETTINGS = {
  locale: 'en-US', theme: 'zai-dark', dataBaseDir: '', terminalInheritSystemProfile: true,
  terminalFontFamily: '', integratedTerminalShell: { mode: 'auto' }, httpProxy: '', httpProxyNoProxy: '',
  messageStreamShowReasoning: true, messageStreamShowTodos: false, toolGroupingChangesEnabled: false,
  toolGroupingExplainerEnabled: true, zcodeInteractionBehavior: 'queue', optimizeAgentExperienceEnabled: false,
  askUserQuestionAutoResolutionEnabled: true, nativeSearchEnhancementsEnabled: true, memoryEnabled: false,
};
function settingService({ logger }) {
  const load = async () => {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(await fsp.readFile(SETTING_FILE(), 'utf8')) }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  };
  const save = async (s) => {
    try { await fsp.mkdir(path.dirname(SETTING_FILE()), { recursive: true }); await fsp.writeFile(SETTING_FILE(), JSON.stringify(s, null, 2)); }
    catch (e) { logger.warn?.('settings save:', e.message); }
  };
  return {
    async get() { return load(); },
    async update(patch) { const s = await load(); Object.assign(s, patch); await save(s); return s; },
    async syncAppSettings() { return load(); },
    async updateDataBaseDir({ dir }) { const s = await load(); s.dataBaseDir = dir; await save(s); return s; },
  };
}

// ---------- Terminal（node-pty 真 PTY）----------
// 渲染器调用形状（styles bundle aDt()）：
//   create({cols,rows,cwd}) / write({id,data}) / resize({id,cols,rows}) / dispose({id})  —— 对象参数
//   onDynamicData(id) / onDynamicExit(id)                                              —— **位置参数（裸字符串）**
// 返回值：{id, shell, fontFamily?, fontSize?, theme?, fontFamilySource?, windowsPty?}
// data 事件负载：**裸字符串**（渲染器 FEt(e,shell) 直接对 e 调 .includes()）
// exit 事件负载：**裸数字**（渲染器记日志 exitCode:${t}）
function terminalService({ logger }) {
  let pty;
  try { pty = require('node-pty'); }
  catch (e) { logger?.warn?.('[terminal] node-pty 加载失败，回退直连 shell:', e.message); }
  const sessions = new Map();       // id -> {proc, dEm, xEm, exited}
  const dataEmitters = new Map();   // id -> Emitter（订阅先于 create 时保留，防丢帧）
  const exitEmitters = new Map();
  let nextId = 1;
  const dynId = (arg) => (typeof arg === 'string' ? arg : (arg?.id ?? arg?.sessionId));
  const emFor = (map, id) => {
    let em = map.get(id);
    if (!em) { em = new Emitter({ onDidRemoveLastListener: () => { if (!sessions.has(id)) map.delete(id); } }); map.set(id, em); }
    return em;
  };
  return {
    async create({ cwd, cols, rows } = {}) {
      const id = String(nextId++);
      const dEm = emFor(dataEmitters, id);
      const xEm = emFor(exitEmitters, id);
      const colsN = Math.max(2, Math.min(500, Number(cols) || 80));
      const rowsN = Math.max(2, Math.min(300, Number(rows) || 24));
      const cwdPath = (typeof cwd === 'string' && cwd.trim()) || os.homedir();
      try {
        let proc;
        if (pty) {
          const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : '/bin/bash';
          proc = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: colsN, rows: rowsN,
            cwd: cwdPath,
            env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
          });
        } else {
          // 回退：无 PTY 时直连 shell（无提示符/回显，仅保证不崩）
          const { spawn } = require('child_process');
          const shell = process.env.SHELL || '/bin/bash';
          proc = spawn(shell, ['-i'], { cwd: cwdPath, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
          proc.stdout.on('data', (b) => dEm.fire(b.toString('utf8')));
          proc.stderr.on('data', (b) => dEm.fire(b.toString('utf8')));
          proc.stdin.on('error', () => {});
          proc.on('exit', (code) => { xEm.fire(code); sessions.delete(id); });
          sessions.set(id, { proc, dEm, xEm, fallback: true });
          return { id, ok: true, shell };
        }
        proc.onData((d) => dEm.fire(d));
        proc.onExit(({ exitCode }) => {
          xEm.fire(exitCode);
          sessions.delete(id);
          if (dataEmitters.get(id)?.listeners?.size === 0) dataEmitters.delete(id);
          if (exitEmitters.get(id)?.listeners?.size === 0) exitEmitters.delete(id);
        });
        sessions.set(id, { proc, dEm, xEm });
        return { id, ok: true, shell: proc.file ?? (process.env.SHELL || '/bin/bash') };
      } catch (e) {
        logger?.warn?.('[terminal] spawn failed:', e.message);
        return { id, ok: false };
      }
    },
    async write({ id, data } = {}) {
      const s = sessions.get(id);
      if (!s) return { ok: false };
      try { s.fallback ? s.proc.stdin.write(data) : s.proc.write(data); return { ok: true }; }
      catch { return { ok: false }; }
    },
    async resize({ id, cols, rows } = {}) {
      const s = sessions.get(id);
      if (s && !s.fallback) { try { s.proc.resize(Math.max(2, Number(cols) || 80), Math.max(2, Number(rows) || 24)); } catch {} }
      return { ok: true };
    },
    async dispose({ id } = {}) {
      const s = sessions.get(id);
      if (s) {
        try { s.fallback ? s.proc.kill() : s.proc.kill(); } catch {}
        sessions.delete(id);
      }
      return { ok: true };
    },
    // 渲染器传**位置参数**（裸 id 字符串），不能只读 arg.id
    onDynamicData(arg) { return emFor(dataEmitters, dynId(arg)).event; },
    onDynamicExit(arg) { return emFor(exitEmitters, dynId(arg)).event; },
  };
}

// ---------- Git（简单封装 git CLI）----------
function gitService({ logger, workspaceRoot }) {
  const run = async (args, cwd) => new Promise((resolve) => {
    require('child_process').execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
  return {
    async getChanges({ workspacePath }) {
      const st = await run(['status', '--porcelain=v1', '-z'], workspacePath);
      if (!st.ok) return { changes: [], repo: false };
      const changes = st.stdout.split('\0').filter(Boolean).map((l) => {
        const status = l.slice(0, 2).trim();
        const file = l.slice(3);
        return { path: file, status, staged: l[0] !== ' ' && l[0] !== '?', untracked: l.includes('??') };
      });
      return { changes, repo: true };
    },
    async getIdentity({ workspacePath }) {
      const n = await run(['config', 'user.name'], workspacePath);
      const e = await run(['config', 'user.email'], workspacePath);
      return { name: n.stdout.trim() || '', email: e.stdout.trim() || '' };
    },
    async refresh({ workspacePath }) { return { ok: true }; },
    // .gitignore / .zcodeignore 规则查询（源控制树过滤未跟踪噪声）
    async getIgnoredPaths({ workspacePath, paths } = {}) {
      const list = Array.isArray(paths) ? paths : [];
      if (!list.length) return { ignored: [] };
      const cwd = typeof workspacePath === 'string' && workspacePath ? workspacePath : workspaceRoot;
      // check-ignore 多路径一次跑；退出码 0=有忽略 1=全没忽略
      const st = await run(['check-ignore', '--stdin', '-z'], cwd);
      // execFile 不支持 stdin 输入，退化成逐路径 check-ignore
      const ignored = [];
      for (const p of list) {
        if (typeof p !== 'string') continue;
        const r = await run(['check-ignore', '-q', p], cwd);
        if (r.ok) ignored.push(p); // check-ignore -q: 0 → 被忽略
      }
      void st;
      return { ignored };
    },
  };
}

// ---------- FileWatcher（fs.watch 递归监听）----------
// 渲染器契约 (styles bundle WorkspaceFileTree/GitAutoRefresh 逆向):
//   watch({path, recursive?}) -> {id}
//   unwatch({id}) -> void
//   onDynamicChange(id) -> ev {dirPath, ...}   ← 渲染器按 dirPath 重扫该目录
// Electron host 用 chokidar; web 版直接用 node fs.watch (Linux inotify, 支持 recursive)。
function fileWatcherService({ logger }) {
  const emitters = new Map(); // id -> { emitter, watchers: fs.FSWatcher[], disposed }
  let nextId = 1;
  const debounceTimers = new Map(); // id -> Map(dir -> timer)
  return {
    async watch(p) {
      const target = typeof p?.path === 'string' ? p.path : null;
      if (!target) throw new Error('watch: path required');
      const recursive = p?.recursive !== false; // 渲染器默认期望递归
      const id = String(nextId++);
      const em = new Emitter();
      const entry = { emitter: em, watchers: [], disposed: false };
      emitters.set(id, entry);
      // 事件合并: 同一目录 200ms 内的多次变更合并为一次 (inotify 重命名风暴会打爆渲染器)
      const pend = new Map();
      const fireDir = (dir) => {
        let t = pend.get(dir);
        if (t) return;
        t = setTimeout(() => {
          pend.delete(dir);
          if (!entry.disposed) em.fire({ dirPath: dir, path: dir, kind: 'changed' });
        }, 200);
        pend.set(dir, t);
      };
      const attach = (dirPath) => {
        try {
          // 注意: fs.promises.watch 是 async-iterator 接口 (非 FSWatcher) — 用同步 callback 版 fs.watch
          const w = fs.watch(dirPath, { recursive: recursive && process.platform === 'linux' }, (evt, filename) => {
            if (entry.disposed) return;
            // filename 可能是相对子路径 (递归模式) — 目录取其父目录
            const rel = typeof filename === 'string' ? filename : '';
            const abs = rel ? path.join(dirPath, rel) : dirPath;
            fireDir(path.dirname(abs) || dirPath);
          });
          if (entry.disposed) { try { w.close(); } catch {} return; }
          w.on('error', (e) => { logger.warn?.('[file-watcher] watch error:', dirPath, e.message); });
          entry.watchers.push(w);
        } catch (e) {
          logger.warn?.('[file-watcher] 无法监听目录:', dirPath, e.message);
        }
      };
      try {
        const st = await fsp.stat(target);
        attach(st.isDirectory() ? target : path.dirname(target));
      } catch (e) {
        // 目标不存在: 轮询等待其出现 (Electron chokidar 语义), 每 2s 探测, 出现后挂监听
        const probe = setInterval(async () => {
          if (entry.disposed) { clearInterval(probe); return; }
          try {
            const st2 = await fsp.stat(target);
            clearInterval(probe);
            attach(st2.isDirectory() ? target : path.dirname(target));
            fireDir(st2.isDirectory() ? target : path.dirname(target));
          } catch { /* 仍不存在 */ }
        }, 2000);
        entry.watchers.push({ close: () => clearInterval(probe) });
      }
      return { id };
    },
    async unwatch({ id }) {
      const w = emitters.get(String(id));
      if (w) {
        w.disposed = true;
        for (const fs of w.watchers) { try { fs.close(); } catch {} }
        emitters.delete(String(id));
      }
      return { ok: true };
    },
    onDynamicChange(arg) {
      const id = typeof arg === 'string' ? arg : arg?.id;
      const w = emitters.get(String(id));
      return w ? w.emitter.event : new Emitter().event;
    },
    // 兼容旧轮询接口 (若有其他调用方)
    async create(p) { return this.watch(p); },
    async dispose({ id }) { return this.unwatch({ id }); },
  };
}

// ---------- ModelProvider（读 app-server 的 workspace/readState）----------
function modelProviderService({ appServer, defaultWorkspace, configPath, logger }) {
  const { buildRegistryFromConfig } = require('./v4-protocol.js');
  let cachedRegistry = null; let cachedAt = 0;
  const REGISTRY_TTL_MS = 30 * 1000;

  // ---------- ~/.zcode/cli/config.json 增删改（provider 持久化的落盘层） ----------
  async function readConfig() { try { return JSON.parse(await fsp.readFile(configPath, 'utf8')); } catch { return {}; } }
  async function writeConfig(cfg) {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2));
  }
  // store 形状 → config 形状（renderer Zod rf/Xd 逆向；config 是 zcode CLI 的 provider 存储）
  function storeToConfigProvider(p) {
    const kind = p.kind === 'anthropic' ? 'anthropic' : p.kind === 'openai' ? 'openai' : 'openai-compatible';
    const cfgP = {
      kind,
      ...(p.name ? { name: p.name } : {}),
      options: {
        ...(p.endpoints?.baseURL ? { baseURL: p.endpoints.baseURL } : {}),
        ...(typeof p.apiKey === 'string' && p.apiKey ? { apiKey: p.apiKey } : {}),
      },
      models: {},
    };
    for (const m of Array.isArray(p.models) ? p.models : []) {
      if (!m?.id) continue;
      cfgP.models[m.id] = {
        ...(Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
      };
    }
    return cfgP;
  }
  async function configProviderEntries() {
    const cfg = await readConfig();
    const out = new Map();
    for (const [pid, p] of Object.entries(cfg.provider ?? {})) {
      out.set(pid, {
        ...(typeof p?.options?.apiKey === 'string' && p.options.apiKey ? { apiKey: p.options.apiKey } : {}),
        ...(typeof p?.options?.baseURL === 'string' && p.options.baseURL ? { baseURL: p.options.baseURL } : {}),
      });
    }
    return out;
  }

  // 保存/删除后：重建 registry（新 revision）→ 推给 app-server → 广播给所有浏览器。
  async function pushRegistryUpdate() {
    cachedAt = 0; // 缓存失效
    const reg = await readRegistry();
    try {
      const st = await appServer.request('workspace/updateProviderRegistry', { workspace: defaultWorkspace, registry: reg }, { timeoutMs: 30000 });
      logger?.info?.(`[model-provider] registry 已应用 revision=${reg.revision} providers=${reg.providers.length} status=${st?.status}`);
    } catch (e) { logger?.warn?.('[model-provider] registry 应用失败:', e?.message ?? e); }
    registryEmitter.fire({
      snapshot: { providers: reg.providers, revision: reg.revision },
      revision: reg.revision,
      workspaceKey: defaultWorkspace.workspaceKey,
    });
    return reg;
  }

  async function readRegistry() {
    const now = Date.now();
    if (cachedRegistry && now - cachedAt < REGISTRY_TTL_MS) return cachedRegistry;
    try { cachedRegistry = await buildRegistryFromConfig(configPath); cachedAt = now; }
    catch { cachedRegistry = cachedRegistry ?? { revision: 'web-empty', generatedAt: now, providers: [] }; }
    return cachedRegistry;
  }

  const registryEmitter = new Emitter();
  // app-server 注册表应用状态变化 → 通知渲染器（带 snapshot 形状）
  appServer.onNotification(async (method, params) => {
    if (method !== 'state.updated') return;
    const patch = params?.patch;
    if (!patch) return;
    if (patch.modelCatalog !== undefined || patch.appliedProviderRevision !== undefined || patch.model !== undefined) {
      cachedAt = 0; // 使缓存失效，下次读取重建
      try {
        const reg = await readRegistry();
        registryEmitter.fire({
          snapshot: { providers: reg.providers, revision: reg.revision },
          revision: reg.revision,
          workspaceKey: params?.workspace?.workspaceKey ?? defaultWorkspace.workspaceKey,
        });
      } catch { /* 通知失败不影响主流程 */ }
    }
  });
  return {
    onDidChangeProviderRegistry: registryEmitter.event,
    // v4-draft-readiness 门禁：渲染器 BT() 直接遍历 providers 判定 ready；
    // kme() 会把本返回值原样作为 registry 传给 zcodeSessionService.updateProviderRegistry ——
    // app-server 的 Zod 校验要求 generatedAt 为 number，不能剔除。
    async getProviderRegistrySnapshot({ workspacePath, workspaceIdentity } = {}) {
      const reg = await readRegistry();
      return { providers: reg.providers, revision: reg.revision, generatedAt: reg.generatedAt };
    },
    // 注意：渲染器把 getAll() 的返回值**直接当数组**用（modelProviders.find(...)），
    // 必须返回 provider 数组本身，不能包成 {providers, available} 对象。
    //
    // 形状契约（渲染器 Zod schema Xd/Qd/rf + of()/yf()/BT() 检查逆向）：
    // provider store 条目必须满足：
    //  * id / name: 字符串（catalog 键名是 providerId/label —— 必须映射）
    //  * apiKey: 字符串（of() 里 e.apiKey.trim()）
    //  * apiKeyRequired: false → of() 跳过 key 检查
    //  * models[]: 每个条目 id 字符串（yf() 里 e.id.trim()）、kinds 数组、
    //    modalities:{input:[],output:[]}（Xd 必填）、contextWindow 正整数
    //    catalog 的 supportsImages/supportsPdf/supportsVideo → 映射进 modalities
    //
    // 持久化关键：app-server catalog 里的 apiKey 是 apiKeyRef（不含明文）、baseURL 不下发，
    // 必须用 config.json 的 options.{apiKey,baseURL} 回填，否则：
    //  * apiKey 空 → of() 认定不可用 → 每次刷新重弹登录页（gEe/qee 门禁）
    //  * endpoints.baseURL 空 / paths 缺失 → Pf() 返回 '' → of() 仍判定不可用（本次实测发现）
    // Pf(e,kind) 契约：!baseURL && !paths → ''；paths[kind]===undefined → ''；
    //   标准路径 anthropic=/v1/messages openai=/responses openai-compatible=/chat/completions
    catalogToStoreProvider(p, cfgEntries) {
      const kind = p.kind === 'anthropic' ? 'anthropic' : p.kind === 'gemini' ? 'openai' : 'openai-compatible';
      const pid = p.id ?? p.providerId;
      const cfg = cfgEntries?.get?.(pid) ?? {};
      const apiFormat = kind === 'anthropic' ? 'anthropic-messages' : 'openai-chat-completions';
      const defaultKind = kind === 'anthropic' ? 'anthropic' : 'openai-compatible';
      const input = ['text'];
      if (p.supportsImages !== false && p.models?.some?.((m) => m.supportsImages)) input.push('image');
      return {
        id: pid,
        name: p.name ?? p.label ?? pid,
        kind,
        apiFormat,
        defaultKind,
        source: p.source ?? 'workspace',
        apiKey: cfg.apiKey ?? (typeof p.apiKey === 'string' ? p.apiKey : ''),
        apiKeyRequired: p.apiKeyRequired === true,
        logoUrl: p.logoUrl,
        enabled: p.enabled !== false,
        endpoints: {
          baseURL: cfg.baseURL ?? p.baseURL ?? '',
          // Pf() 要求 paths[apiFormat 对应 kind] 必须存在；同时补齐其他标准路径便于 UI 切换
          paths: { anthropic: '/v1/messages', openai: '/responses', 'openai-compatible': '/chat/completions' },
        },
        models: (Array.isArray(p.models) ? p.models : []).map((m) => ({
          id: m.id ?? m.modelId,
          name: m.name ?? m.label,
          kinds: [kind],
          modalities: { input, output: ['text'] },
          contextWindow: Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : 1000000,
          maxOutputTokens: m.maxOutputTokens,
          reasoning: m.reasoning,
          supportsImages: m.supportsImages,
          supportsTools: m.supportsTools,
        })),
      };
    },
    async getAll({ workspacePath, workspaceIdentity } = {}) {
      const ws = workspacePath ? { workspacePath, workspaceKey: workspacePath } : defaultWorkspace;
      const [cfgEntries, raw] = await Promise.all([
        configProviderEntries().catch(() => new Map()),
        appServer.request('workspace/readState', { workspace: ws })
          .then((st) => st.modelCatalog?.providers ?? [])
          .catch(() => []),
      ]);
      return raw.map((p) => this.catalogToStoreProvider(p, cfgEntries));
    },
    async getAllCached(args) { return this.getAll(args); },
    // 渲染器 saveProvider: Sqe() → modelProviderService.save(provider)（单个位置参数）
    async save(provider) {
      if (!provider || typeof provider !== 'object' || !provider.id) throw new Error('save: provider.id required');
      const cfg = await readConfig();
      if (!cfg.provider || typeof cfg.provider !== 'object') cfg.provider = {};
      cfg.provider[provider.id] = storeToConfigProvider(provider);
      // model.main 若未设置则指向该 provider 的第一个模型，避免重启后无默认模型
      if (!cfg.model?.main && provider.models?.[0]?.id) cfg.model = { ...(cfg.model ?? {}), main: `${provider.id}/${provider.models[0].id}` };
      await writeConfig(cfg);
      await pushRegistryUpdate();
      return { ok: true };
    },
    // 渲染器 deleteProvider: gBt() → e.delete(providerId)（位置参数）
    async delete(providerId) {
      const cfg = await readConfig();
      if (cfg.provider && Object.prototype.hasOwnProperty.call(cfg.provider, providerId)) {
        delete cfg.provider[providerId];
        await writeConfig(cfg);
        await pushRegistryUpdate();
      }
      return { ok: true };
    },
    // 展示顺序：xI(yI) 直接以 getDisplayOrder() 的返回值作为全局 displayOrder 状态
    async getDisplayOrder() {
      const st = await loadWebState();
      return st.displayOrder ?? { providerIds: [], updatedAt: 0 };
    },
    // saveDisplayOrder({providerIds:[...], updatedAt}) —— 持久化到 web state
    async saveDisplayOrder(order) {
      const st = await loadWebState();
      st.displayOrder = { providerIds: order?.providerIds ?? [], updatedAt: order?.updatedAt ?? Date.now() };
      await saveWebState(st);
      return { ok: true };
    },
    async getEndpointSuggestions() { return { anthropic: [], openai: [], gemini: [] }; },
    async getModelsByEndpoint() { return []; },
    async testModelConnectivity(p) {
      return { ok: false, error: 'not_supported', ...(p?.providerId ? { providerId: p.providerId } : {}) };
    },
    async refreshCodingPlanApiKey() { return { ok: false, error: 'not_supported' }; },
    async resolveWorkspaceModelSelection({ workspacePath, workspaceIdentity } = {}) {
      const ws = workspacePath ? { workspacePath, workspaceKey: workspacePath } : defaultWorkspace;
      try {
        const st = await appServer.request('workspace/readState', { workspace: ws });
        return { settings: st.settings, selection: st.settings?.model?.current ?? null };
      } catch { return { settings: null, selection: null }; }
    },
  };
}

// ---------- Broadcast（多窗口广播：单 web 客户端直接 no-op）----------
function broadcastService() {
  const msgEmitter = new Emitter();
  return {
    onMessage: msgEmitter.event,
    // 渲染器 nx()/IntlProvider 等会调 broadcastService.send({channel,payload}) 广播
    // 跨窗口设置变更 —— Web 单页内直接回环广播（所有订阅者含发送方自身，
    // 渲染器对此有幂等处理）。
    async send(msg) {
      try { if (msg && typeof msg === 'object') msgEmitter.fire(msg); } catch (e) { /* 广播失败不阻塞 */ }
      return { ok: true };
    },
    async releaseClaim() { return { ok: true }; },
    async claim() { return { claimed: true, generation: 1 }; },
  };
}

// ---------- Credential / OAuth（本地存储） ----------
// 渲染器 Root 远程 workspace 凭据流: credentialService.save(key, value) / delete(key) / load(key)
// —— 全部是位置参数（lqt/Ust 里 t.credentialService.save(n.key,n.value)），不能写成 ({key,value})。
function credentialService() {
  const FILE = () => path.join(os.homedir(), '.zcode', 'web-ide-credentials.json');
  const loadAll = async () => { try { return JSON.parse(await fsp.readFile(FILE(), 'utf8')); } catch { return {}; } };
  const saveAll = async (d) => { await fsp.mkdir(path.dirname(FILE()), { recursive: true }); await fsp.writeFile(FILE(), JSON.stringify(d, null, 2)); };
  const normArgs = (a, b) => (a && typeof a === 'object' && !Array.isArray(a) ? [a.key, a.value] : [a, b]);
  return {
    async save(a, b) {
      const [key, value] = normArgs(a, b);
      if (typeof key !== 'string') throw new Error('credential.save: key required');
      const d = await loadAll(); d[key] = value; await saveAll(d);
      return { ok: true };
    },
    async delete(a) {
      const [key] = normArgs(a, undefined);
      if (typeof key !== 'string') throw new Error('credential.delete: key required');
      const d = await loadAll(); delete d[key]; await saveAll(d);
      return { ok: true };
    },
    async load(a) {
      const [key] = normArgs(a, undefined);
      const d = await loadAll();
      return (typeof key === 'string') ? (d[key] ?? null) : null;
    },
  };
}
function oauthService() {
  return {
    // PGt() v(): l(await e.getProviders()) —— 数组，空列表 = 无 OAuth 登录方式可选
    async getProviders() { return []; },
    async getActiveProvider() { return null; },
    async handleCallback() { return { ok: false }; },
    async logout() { return { ok: true }; },
    async pollPendingOAuth() { return null; },
    async restoreCachedSessionState() { return null; },
  };
}

// ---------- SettingsSync（首启 onboarding 持久化） ----------
// 渲染器 PKt(): getFirstRunPromptState() → {handled:boolean}；handled=true 则不再弹首启导入框。
// detect() 返回 {agents:[]} → 渲染器判 "discovery empty" 自动 markFirstRunPromptHandled 并收起。
function settingsSyncService() {
  return {
    async getFirstRunPromptState() {
      const st = await loadWebState();
      return { handled: st.firstRunPromptHandled === true };
    },
    async markFirstRunPromptHandled() {
      const st = await loadWebState();
      st.firstRunPromptHandled = true;
      await saveWebState(st);
      return { ok: true };
    },
    async detect() {
      // 服务器上没有 Claude Code/Cursor 等桌面端外部 agent 可导入 —— 返回空发现。
      return { agents: [] };
    },
    async importSelected() {
      // detect 为空时不会被调；实现为 no-op 以防第三方路径触达。
      return { taskResults: [] };
    },
    async sync() { return { ok: true }; },
  };
}

// ---------- WindowController ----------
// 渲染器侧消费路径（styles bundle $ye/ag）:
//  - ag()/$ye registry: subscribeControllerV4({topic:'controller/workspaces'|'controller/tasks-index',
//    visibility}) → {ack:{subscriptionId}}; 帧走 onDynamicControllerFrame()（无参、全局单流）。
//  - 帧形状: {subscriptionId, logEpoch, seq, fromSeq, toSeq, topic, payload}
//      snapshot: {kind:'snapshot', snapshot:{tasks:[{address, meta, membership, sourceAvailability, liveStatus, activity?}]}}
//                controller/workspaces 的 snapshot: {workspaces:[{workspacePath, sourceAvailability, connectionState}]}
//      deltas:   {kind:'deltas', deltas:[{op:'task.upserted', task}|{op:'task.removed', address}]}
//    Aue() gap 检查: fromSeq 必须等于已收到的 seq，否则渲染器会 resync —— 快照帧无此约束。
//  - listTaskList(q): q={kind:'timeline'|'active'|..., workspaceScopes:[{workspacePath,workspaceIdentity?}],
//    sortBy?, search?, limit?} → {items, total, hasMore}; items 需含 taskId/workspacePath/
//    title/createdAt/updatedAt + 可选 status/mode/model。
// app-server 没有 controller 方法（桌面 host 职责），由本服务合成。
function windowControllerService({ appServer, defaultWorkspace, logger, hub, services }) {
  let nextSubId = 1;
  const frameEmitter = new Emitter();             // 所有 controller 订阅共用一条帧流
  const subscriptions = new Map();                // subscriptionId -> {topic, logEpoch, seq, key}
  const logEpoch = `webctrl-${Date.now().toString(36)}`;
  const wsRoot = defaultWorkspace.workspacePath;

  const metaOf = (sid) => services?.[CHANNELS.ZCodeTask]?._taskMetaOf?.(sid) ?? {};

  function liveStatusOf(sess) {
    if (sess.status === 'running' || sess.phase === 'running' || sess.phase === 'prewarming') return 'running';
    if (sess.status === 'error' || sess.phase === 'error') return 'error';
    if (sess.phase === 'completedSuccess' || sess.phase === 'completedInterrupted') return 'completed';
    return 'idle';
  }

  // session/list 不带 workspace 是重查询（app-server 实测 ~10s），页面刷新会并发 6+ 次
  // listTaskList/快照帧 → 必须短 TTL 缓存 + 在途去重，否则把 app-server 打挂（30s 超时风暴）。
  let sessionsCache = { at: 0, promise: null, data: null };
  const SESSIONS_TTL_MS = 5000;
  async function listSessionsRaw() {
    const now = Date.now();
    if (sessionsCache.data && now - sessionsCache.at < SESSIONS_TTL_MS) return sessionsCache.data;
    if (sessionsCache.promise) return sessionsCache.promise;
    sessionsCache.promise = (async () => {
      try {
        // 不带 workspace 参数 → 返回所有 workspace 的 session（每个带真实 workspace.workspacePath）。
        // 侧边栏「项目/对话」分区依赖 task.workspacePath 与查询 scope 匹配，必须用真实路径。
        const res = await appServer.request('session/list', { includeArchived: true, limit: 500 }, { timeoutMs: 60000 });
        sessionsCache.data = res.sessions ?? [];
        sessionsCache.at = Date.now();
        return sessionsCache.data;
      } catch (e) {
        logger.warn?.('[windowController] session/list failed:', e.message);
        // 失败时返回上次成功的数据（如有），避免任务列表整体消失
        return sessionsCache.data ?? [];
      } finally { sessionsCache.promise = null; }
    })();
    return sessionsCache.promise;
  }

  // session 的真实工作区路径（「不在项目中工作」的会话挂在 ~/.zcode/workspace/default）
  function sessionWorkspacePath(s) {
    const p = s?.workspace?.workspacePath;
    return (typeof p === 'string' && p) ? p : wsRoot;
  }

  function sessionToControllerTask(sess) {
    const m = metaOf(sess.sessionId);
    const archived = Boolean(sess.archivedAt) || Boolean(m.archived);
    const phase = sess.phase ?? (sess.status === 'running' ? 'running' : 'completedSuccess');
    return {
      address: { workspacePath: sessionWorkspacePath(sess), taskId: sess.sessionId },
      meta: {
        taskId: sess.sessionId,
        traceId: m.traceId ?? `zcode-${sess.sessionId}`,
        title: m.title ?? sess.title ?? 'Session',
        ...(m.titleOverridden ? { titleOverridden: true } : {}),
        workspacePath: sessionWorkspacePath(sess),
        createdAt: sess.createdAt ?? m.createdAt ?? Date.now(),
        updatedAt: sess.updatedAt ?? m.updatedAt ?? Date.now(),
        mode: sess.mode ?? 'build',
        ...(sess.model ? { model: `${sess.model.providerId}/${sess.model.modelId}` } : {}),
      },
      membership: { pinned: Boolean(m.pinned), archived, active: !archived },
      sourceAvailability: 'online',
      liveStatus: liveStatusOf(sess),
      activity: {
        phase,
        lastActivityAt: sess.updatedAt ?? Date.now(),
        hasBackgroundWork: false,
      },
    };
  }

  async function fireSnapshotFrame(sub) {
    const seq = (sub.seq = (sub.seq ?? 0) + 1);
    let payload;
    if (sub.topic === 'controller/workspaces') {
      payload = { kind: 'snapshot', snapshot: { protocolVersion: 1, logEpoch, workspaces: [{ workspacePath: wsRoot, sourceAvailability: 'online', connectionState: 'online' }] } };
    } else {
      const sessions = await listSessionsRaw();
      payload = { kind: 'snapshot', snapshot: { protocolVersion: 1, logEpoch, tasks: sessions.map(sessionToControllerTask) } };
    }
    // 帧形状与渲染器 Ql strict schema 一致: snapshot 必须 fromSeq===0 且 snapshot.logEpoch===logEpoch
    frameEmitter.fire({ subscriptionId: sub.subscriptionId, logEpoch, fromSeq: 0, toSeq: seq, sentAt: Date.now(), topic: sub.topic, payload });
  }

  let deltaFlushTimer = null;
  async function fireDeltaFrames(reason, extra) {
    // 任务变化 → 给每个活跃 tasks-index 订阅推一帧快照（快照自带全量，无需处理 gap/顺序）。
    // 快照对渲染器是完全安全的（s.clear() 后重建）。300ms 防抖合并突发 deltas。
    if (deltaFlushTimer) return; // 已有 pending flush
    deltaFlushTimer = setTimeout(() => {
      deltaFlushTimer = null;
      for (const sub of [...subscriptions.values()]) {
        if (sub.topic === 'controller/tasks-index') { try { fireSnapshotFrame(sub).catch(() => {}); } catch (e) { logger.warn?.('[windowController] snapshot frame error:', e.message); } }
      }
      void reason; void extra;
    }, 300);
  }

  if (hub) {
    hub.onTaskListChanged((ev) => {
      // 任务变化 → 立刻失效 session 缓存，保证下一帧快照反映最新列表
      sessionsCache.at = 0;
      fireDeltaFrames(ev?.reason, ev).catch(() => {});
    });
    // app-server sessions-index 增量 = 会话真实进入 session/list 的时刻（v4 createSession
    // 之后 sendText 才持久化）—— 此时重推 controller 快照，保证时间线即时可见
    hub.onSessionsIndexFrame?.((frame) => {
      const payload = frame?.frame?.payload ?? frame?.payload;
      if (payload?.kind === 'deltas' || payload?.kind === 'snapshot') {
        sessionsCache.at = 0;
        fireDeltaFrames('sessions_index', payload).catch(() => {});
      }
    });
  }

  async function queryTaskList(q) {
    const scopes = Array.isArray(q?.workspaceScopes) ? q.workspaceScopes : [{ workspacePath: wsRoot }];
    const sessions = await listSessionsRaw();
    const kind = q?.kind ?? 'timeline';
    const search = (q?.search ?? '').trim().toLowerCase();
    let items = sessions.map((s) => {
      const m = metaOf(s.sessionId);
      return {
        taskId: s.sessionId,
        traceId: m.traceId ?? `zcode-${s.sessionId}`,
        title: m.title ?? s.title ?? 'Session',
        ...(m.titleOverridden ? { titleOverridden: true } : {}),
        workspacePath: sessionWorkspacePath(s),
        createdAt: s.createdAt ?? Date.now(),
        updatedAt: s.updatedAt ?? Date.now(),
        mode: s.mode ?? 'build',
        ...(s.model ? { model: `${s.model.providerId}/${s.model.modelId}` } : {}),
        status: s.archivedAt ? 'archived' : (liveStatusOf(s) === 'idle' ? 'idle' : liveStatusOf(s)),
        archivedAt: s.archivedAt ?? undefined,
        // 渲染器 W4() 按 kind 整组打标（kind:'pinned' 的结果全部视为置顶），
        // 所以 pinned/archived kind 必须在服务端过滤，否则所有任务都进「已置顶」
        ...(m.pinned ? { pinned: true } : {}),
        ...((m.archived || s.archivedAt) ? { archived: true } : {}),
      };
    });
    // 按查询 scope 过滤：scope 匹配 task 的真实 workspacePath（无 scope 时回退全部/当前 wsRoot）
    const scopePaths = scopes.map((sc) => (typeof sc === 'string' ? sc : sc?.workspacePath)).filter(Boolean);
    if (scopePaths.length > 0) items = items.filter((t) => scopePaths.includes(t.workspacePath));
    if (kind === 'pinned') items = items.filter((t) => t.pinned);
    if (kind === 'archived') items = items.filter((t) => t.archived);
    if (kind === 'active' || kind === 'timeline') items = items.filter((t) => !t.archived && !t.pinned);
    if (search) items = items.filter((t) => `${t.title ?? ''}`.toLowerCase().includes(search));
    const sortBy = q?.sortBy ?? 'updated';
    items.sort((a, b) => (sortBy === 'created' ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt));
    const total = items.length;
    const limit = Number.isFinite(q?.limit) && q?.limit > 0 ? q.limit : undefined;
    const hasMore = limit !== undefined && items.length > limit;
    return { items: limit !== undefined ? items.slice(0, limit) : items, total, hasMore };
  }

  return {
    async getState() { return { isMaximized: false, isFullScreen: false, bounds: null }; },
    async maximize() {}, async unmaximize() {}, async minimize() {}, async close() {},
    async setBounds() {}, async focus() {}, async setFullScreen() {},
    // useGlobalTaskList (ag): {items,total,hasMore}
    async listTaskList(q) { return queryTaskList(q); },
    // 渲染器启动能力探测 (偶发单次调用, 缺失仅 warn): 带版本的列表快照
    async getTaskListSnapshot(q) {
      const r = await queryTaskList(q);
      const etag = `t${r.total}-${Date.now()}`;
      return { snapshot: r, etag, notModified: false };
    },
    async listControllerWorkspaces() { return { workspaces: [{ workspacePath: wsRoot, sourceAvailability: 'online', connectionState: 'online' }] }; },
    async listControllerTasks(q) { const r = await queryTaskList({ ...q, kind: q?.kind ?? 'timeline' }); return { tasks: r.items.map((t) => sessionToControllerTask({ sessionId: t.taskId, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, mode: t.mode, archivedAt: t.archivedAt })), total: r.total }; },
    // $ye registry: subscribe → {ack:{subscriptionId, mode:'snapshot', logEpoch}} + 初始快照帧
    async subscribeControllerV4(p) {
      const topic = p?.topic ?? 'controller/tasks-index';
      const sid = `wctrl-${nextSubId++}`;
      const sub = { subscriptionId: sid, topic, logEpoch, seq: 0, key: wsRoot };
      subscriptions.set(sid, sub);
      // ack 之后再推初始快照（渲染器在 ack resolved 后才开始消费帧）
      setImmediate(() => { fireSnapshotFrame(sub).catch((e) => logger.warn?.('[windowController] initial snapshot error:', e.message)); });
      return { ack: { subscriptionId: sid, mode: 'snapshot', logEpoch } };
    },
    async unsubscribeControllerV4({ subscriptionId } = {}) { subscriptions.delete(subscriptionId); return { subscriptionId: subscriptionId ?? '' }; },
    async resyncControllerV4({ subscriptionId } = {}) {
      const sub = subscriptions.get(subscriptionId);
      if (sub) fireSnapshotFrame(sub).catch(() => {});
      return { ack: { subscriptionId: subscriptionId ?? '', mode: 'snapshot', logEpoch } };
    },
    onDynamicControllerFrame() { return frameEmitter.event; },
  };
}

// ---------- 其余 stub（返回空对象/数组；事件 no-op）----------
function stubService(name, methods) {
  const svc = {};
  const respond = (fn) => async (arg) => (fn ? fn(arg) : {});
  for (const m of methods) svc[m] = respond();
  return svc;
}

function buildAllChannels({ appServer, workspaceRoot, logger, configPath }) {
  const defaultWorkspace = { workspacePath: workspaceRoot, workspaceKey: workspaceRoot };
  const normWorkspace = (p) => (p?.workspacePath ? { workspacePath: p.workspacePath, workspaceKey: p.workspacePath, ...(p.workspaceIdentity ? { workspaceIdentity: p.workspaceIdentity } : {}) } : defaultWorkspace);
  const services = {
    [CHANNELS.File]: fileService({ logger, workspaceRoot }),
    [CHANNELS.System]: systemService(),
    [CHANNELS.Setting]: settingService({ logger }),
    [CHANNELS.Terminal]: terminalService({ logger }),
    [CHANNELS.Git]: gitService({ logger, workspaceRoot }),
    [CHANNELS.FileWatcher]: fileWatcherService({ logger }),
    [CHANNELS.MediaPreview]: { async prepare() { return { kind: 'inline', dataBase64: '', mediaType: '', size: 0 }; } },
    [CHANNELS.GitCheckpoint]: { async listCheckpoints() { return { checkpoints: [] }; }, async create() { return { ok: false }; }, async diff() { return { diff: '' }; }, async restore() { return { ok: false }; } },
    [CHANNELS.Credential]: credentialService(),
    [CHANNELS.CuaPermission]: { async listPermissions() { return { permissions: [] }; }, async respond() { return { ok: true }; }, onDynamicCuaPermissionObservation: () => new Emitter().event },
    [CHANNELS.CuaPipSession]: { async getStatus() { return { enabled: false }; } },
    [CHANNELS.Broadcast]: broadcastService(),
    [CHANNELS.OAuth]: oauthService(),
    [CHANNELS.ModelProvider]: modelProviderService({ appServer, defaultWorkspace, configPath, logger }),
    [CHANNELS.UsageStats]: {
      async getEntitlementSnapshot() { return { entitled: false }; },
      async getUsage() { return { usage: {} }; },
      // 原版聚合本地/远端 usage 快照; web 版无订阅数据 → 空快照
      async getAppUsageSnapshot() { return { snapshots: [], entitlement: null }; },
    },
    [CHANNELS.CodingPlanSubscription]: {
      async getEnterprisePricing() { return null; },
      async getStatus() { return { active: false }; },
      // 渲染器直接 (await ...getEnterprisePendingOrders()).find(...) —— 必须返回数组
      async getEnterprisePendingOrders() { return []; },
      // TTe() 缓存后交 Sy(n,locale,[...]) 做 n?.[key] 对象取值 —— null 安全
      async getBillingDiscount() { return null; },
      async getStaticProducts() { return []; },
      async getStartPlanPreview() { return null; },
      async getManualClaimPlanPreviews() { return []; },
      async getStaticTeamProducts() { return []; },
    },
    // nB(): (await list()) 的 t.code!==0 抛错 —— code:0 + data:[] = 空推荐
    [CHANNELS.ClientScenes]: { async getActiveScene() { return { scene: 'default' }; }, async list() { return { code: 0, msg: '', data: [] }; } },
    [CHANNELS.Skills]: { async list() { return { skills: [] }; }, async get() { return null; } },
    [CHANNELS.SkillSync]: { async sync() { return { ok: true }; } },
    [CHANNELS.McpSync]: {
      async sync() { return { ok: true }; },
      async list() { return { servers: [] }; },
      // 渲染器 mergeServerStatusSnapshots(e.statuses,...) —— statuses 必须是数组
      async listWorkspaceMcpServerStatuses() { return { statuses: [] }; },
    },
    [CHANNELS.PluginSync]: { async sync() { return { ok: true }; } },
    [CHANNELS.Plugins]: { async list() { return { plugins: [] }; } },
    [CHANNELS.PluginManagement]: {
      async getPluginReferenceCatalog() { return { plugins: [] }; },
      async cancelPluginOperation() { return { ok: true }; },
      async resolveSuggestedPluginReference() { return null; },
      async setPluginEnabled() { return { ok: true }; },
      // [plugins] overview: [list,overview] 解构 e.plugins/e.diagnostics + t.marketplaces/
      // t.availablePlugins/t.installedPlugins/t.restorableBuiltins/t.diagnostics —— app-server 直连
      async listPlugins(p) {
        try { return await appServer.request('plugins/list', { workspace: normWorkspace(p) }, { timeoutMs: 30000 }); }
        catch { return { plugins: [], diagnostics: [] }; }
      },
      async getPluginsOverview(p) {
        try { return await appServer.request('plugins/overview', { workspace: normWorkspace(p) }, { timeoutMs: 60000 }); }
        catch { return { plugins: [], marketplaces: [], availablePlugins: [], installedPlugins: [], restorableBuiltins: [], diagnostics: [] }; }
      },
      // 市场管理操作也走 app-server（渲染器插件市场面板的「新建/刷新市场」按钮）
      async installPlugin(p) { return appServer.request('plugins/install', { workspace: normWorkspace(p), pluginName: p.pluginName, marketplace: p.marketplace }, { timeoutMs: 120000 }); },
      async addPluginMarketplace(p) { return appServer.request('plugins/marketplace/add', { workspace: normWorkspace(p), source: p.source }, { timeoutMs: 120000 }); },
      async updatePluginMarketplace(p) { return appServer.request('plugins/marketplace/update', { workspace: normWorkspace(p), ...(p.marketplace ? { marketplace: p.marketplace } : {}) }, { timeoutMs: 180000 }); },
      onDynamicPluginOperationProgress: () => new Emitter().event,
    },
    [CHANNELS.Subagents]: { async list() { return { subagents: [] }; } },
    [CHANNELS.Commands]: { async list() { return { commands: [] }; }, async updateCommandFile() { return { ok: true }; }, async writeCommandFile() { return { ok: true }; } },
    [CHANNELS.Hooks]: { async listHooks() { return { hooks: [] }; }, async loadHooks() { return { hooks: [] }; } },
    [CHANNELS.Memory]: { async loadMemory() { return { memory: null }; }, async saveMemory() { return { ok: true }; } },
    [CHANNELS.OutputStyle]: { async list() { return { styles: [] }; }, async getActive() { return null; } },
    [CHANNELS.SettingsSync]: settingsSyncService(),
    [CHANNELS.Bots]: { async syncAppRuntimePreferences() { return { ok: true }; } },
    [CHANNELS.Feedback]: {
      async create() { return { ticketId: null, ok: false }; },
      async uploadAttachmentData() { return { ok: false }; },
      async cancelCreate() { return { ok: true }; },
      async cancelUpload() { return { ok: true }; },
      async comment() { return { ok: false }; },
    },
    // WikiReferenceSidePane: e.pages.filter(e=>e!==null) —— pages 必须是数组
    [CHANNELS.RepoWiki]: {
      async get() { return null; },
      async readPages() { return { pages: [] }; },
      async listPages() { return { pages: [] }; },
      async search() { return { results: [] }; },
      // 原版读本地 wiki/draft/task 摘要文件; web 版无本地 wiki 产物 → 各字段 null
      async readSummary() { return { wiki: null, draft: null, task: null }; },
    },
    [CHANNELS.PromptAttachmentTransfer]: { async begin() { return { ok: false }; }, async chunk() { return { ok: false }; }, async commit() { return { ok: false }; } },
    [CHANNELS.OffPeakTask]: { async list() { return { tasks: [] }; } },
  };

  // 核心 agent 三件套 —— 对接 app-server（共享同一个 AgentEventHub）
  const sharedHub = new AgentEventHub(appServer, logger);
  Object.assign(services, {
    [CHANNELS.ZCodeSession]: buildZodeSessionService({ appServer, defaultWorkspace, logger, hub: sharedHub }),
    [CHANNELS.ZCodeTask]: buildZCodeTaskService({ appServer, defaultWorkspace, logger, services, hub: sharedHub }),
    [CHANNELS.ZCodeAgent]: buildZCodeAgentService({ appServer, defaultWorkspace: defaultWorkspace.workspacePath, logger, services, hub: sharedHub }),
  });
  services[CHANNELS.WindowController] = windowControllerService({ appServer, defaultWorkspace, logger, hub: sharedHub, services });

  return services;
}

module.exports = { CHANNELS, buildAllChannels };
