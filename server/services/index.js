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
    // 渲染器 Bet() 逆向: checkFilesExist({paths}) -> [{path, exists}]
    // 用于上下文引用去重前的存在性批量校验（缺失文件引用直接过滤掉）
    async checkFilesExist({ paths } = {}) {
      const list = Array.isArray(paths) ? paths : [];
      const out = [];
      for (const p of list) {
        if (typeof p !== 'string') { out.push({ path: String(p), exists: false }); continue; }
        try { await fsp.stat(p); out.push({ path: p, exists: true }); }
        catch { out.push({ path: p, exists: false }); }
      }
      return out;
    },
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
  const cwdOf = (p) => (typeof p === 'string' && p ? p : workspaceRoot);
  const gitErr = (e, args) => new Error(`git ${args[0]} 失败: ${(e.stderr || e.stdout || '').trim().slice(0, 400)}`);
  // 相对工作区根的路径 (渲染器 workspaceRelativePath / repoRelativePath)
  const relOf = (ws, abs) => {
    if (!abs) return '';
    let p = String(abs).replace(/\\/g, '/');
    const w = String(ws).replace(/\/+$/, '');
    if (w && p.startsWith(w + '/')) p = p.slice(w.length + 1);
    return p;
  };
  const kindOf = (added, removed) => (added > 0 && removed === 0 ? 'added' : removed > 0 && added === 0 ? 'deleted' : 'modified');
  // numstat 行 → {path, added, removed}; 重命名 (a => b) 取 b
  const parseNumstat = (out) => {
    const arr = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const m = line.match(/^(\d+|\t|\-)(\t|\s+)(\d+|\-)[\t\s]+(.+)$/);
      if (!m) continue;
      let p = m[4].trim();
      const ren = p.match(/^(.+) => (.+)$/);
      if (ren) p = ren[2].replace(/^"|"$/g, '');
      arr.push({ path: p, added: m[1] === '-' ? 0 : parseInt(m[1], 10) || 0, removed: m[3] === '-' ? 0 : parseInt(m[3], 10) || 0 });
    }
    return arr;
  };
  // 单文件 diff 文本 (patch)。
  // 注意: porcelain/numstat 输出相对 repo 根, 而 workspacePath 可能是 repo 子目录 —
  // pathspec 相对 cwd 解析, 故统一用 repoRoot 作为 cwd。
  const repoRootOf = async (ws) => {
    const r = await run(['rev-parse', '--show-toplevel'], ws);
    return r.ok ? r.stdout.trim() : ws;
  };
  const diffText = async (root, sourceId, filePath) => {
    if (sourceId === 'staged') return run(['diff', '--cached', '--', filePath], root);
    if (sourceId === 'branch') return run(['diff', '@{u}...', '--', filePath], root);
    return run(['diff', '--', filePath], root);
  };
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
    // ---- GitPane 数据源 (useGitRepository.refresh) ----
    // 形状逆向自渲染器: {summary, identity, unstagedChanges, stagedChanges, branchComparison}
    async refresh({ workspacePath, includeIdentity, includeBranchComparison } = {}) {
      const ws = cwdOf(workspacePath);
      const emptySummary = (w) => ({
        workspacePath: w, repoRoot: w, workspaceInRepoPath: '.', autoRefreshWatchPaths: [],
        branchName: null, trackingBranchName: null, headRefType: 'branch', ahead: 0, behind: 0,
        isDirty: false, isGitAvailable: false, isRepository: false,
      });
      const repoRoot = await run(['rev-parse', '--show-toplevel'], ws);
      if (!repoRoot.ok) return {
        summary: emptySummary(ws),
        identity: null, unstagedChanges: [], stagedChanges: [], branchComparison: null,
      };
      const [porcelain, branch, tracking, inRepo] = await Promise.all([
        run(['status', '--porcelain=v1', '-z', '-b'], ws),
        run(['rev-parse', '--abbrev-ref', 'HEAD'], ws),
        run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], ws),
        run(['rev-parse', '--show-prefix'], ws),
      ]);
      const branchName = branch.stdout.trim() || null;
      const trackingBranchName = tracking.ok ? tracking.stdout.trim() || null : null;
      let ahead = 0, behind = 0;
      if (trackingBranchName) {
        const ab = await run(['rev-list', '--left-right', '--count', `${trackingBranchName}...HEAD`], ws);
        if (ab.ok) {
          const mm = ab.stdout.trim().match(/^(\d+)\s+(\d+)$/);
          if (mm) { behind = parseInt(mm[1], 10) || 0; ahead = parseInt(mm[2], 10) || 0; }
        }
      }
      // porcelain 分行 (含 -b 头行)
      const lines = porcelain.ok ? porcelain.stdout.split('\0').filter((l, idx) => idx === 0 || l) : [];
      const bodyLines = lines.slice(1);
      const isDirty = bodyLines.some((l) => l && !/^\?\? /.test(l));
      const root0 = repoRoot.stdout.trim();
      const summary = {
        workspacePath: ws, repoRoot: root0, workspaceInRepoPath: inRepo.stdout.trim() || '.',
        // autoRefreshWatchPaths: 渲染器 gyt hook 据此 watch 目录, 文件变更自动 refresh。
        // 注意: 填实际路径 (曾试 [repoRoot, repoRoot/.git] 和 [workspacePath]) 均导致
        // 渲染器 watch → GitPane 刷新链路失稳 (Ctrl+K 无响应、偶发 trim undefined 崩溃),
        // 留空数组保稳定, 面板有手动「刷新」按钮兜底。
        autoRefreshWatchPaths: [],
        ahead, behind, isDirty, isGitAvailable: true, isRepository: true,
      };
      // 变更列表 + 行数统计 (numstat: staged 用 --cached, unstaged 两者差集)
      const [stagedStat, unstagedStat] = await Promise.all([
        run(['diff', '--cached', '--numstat'], ws),
        run(['diff', '--numstat'], ws),
      ]);
      const stagedNum = parseNumstat(stagedStat.stdout);
      const unstagedNum = parseNumstat(unstagedStat.stdout);
      const numBy = (arr) => new Map(arr.map((e) => [e.path, e]));
      const stagedMap = numBy(stagedNum);
      const unstagedMap = numBy(unstagedNum);
      const mkChange = (p, section, isStaged, isUntracked, isConflicted, added, removed) => {
        const rel = relOf(ws, p);
        return {
          path: p, stagePath: p, repoRelativePath: rel, workspaceRelativePath: rel,
          kind: kindOf(added, removed), section, added, removed,
          isStaged, isUntracked, isConflicted,
          diff: { path: p, availability: 'unavailable', patch: null, beforeContent: null, afterContent: null, summary: null },
        };
      };
      const unstagedChanges = [], stagedChanges = [];
      for (const l of bodyLines) {
        if (!l || l.length < 4) continue;
        const xy = l.slice(0, 2);
        const p = l.slice(3);
        const u = unstagedMap.get(p);
        const st = stagedMap.get(p);
        const isUntracked = xy === '??';
        const isConflicted = /([ADU]{2})/.test(xy) && xy[0] !== xy[1] && xy !== '??';
        if (isUntracked) {
          unstagedChanges.push(mkChange(p, 'untracked', false, true, false, 0, 0));
        } else {
          // staged 部分 (X 非 ' ')
          if (xy[0] !== ' ') stagedChanges.push(mkChange(p, 'staged', true, false, false, st?.added ?? 0, st?.removed ?? 0));
          // unstaged 部分 (Y 非 ' ')
          if (xy[1] !== ' ') unstagedChanges.push(mkChange(p, 'unstaged', false, false, isConflicted, u?.added ?? 0, u?.removed ?? 0));
        }
      }
      // identity
      let identity = null;
      if (includeIdentity) {
        const [un, ue, unSrc, ueSrc] = await Promise.all([
          run(['config', 'user.name'], ws), run(['config', 'user.email'], ws),
          run(['config', '--show-origin', 'user.name'], ws), run(['config', '--show-origin', 'user.email'], ws),
        ]);
        const srcOf = (t) => { const m = String(t).match(/file:(\S+)/); return m ? m[1] : null; };
        identity = {
          userName: un.stdout.trim() || null, userEmail: ue.stdout.trim() || null,
          nameSource: srcOf(unSrc.stdout), emailSource: srcOf(ueSrc.stdout), scopeLabel: null,
        };
      }
      // branchComparison (与上游差异)
      let branchComparison = null;
      if (includeBranchComparison && trackingBranchName) {
        const cmpStat = await run(['diff', '--numstat', `${trackingBranchName}...HEAD`], ws);
        branchComparison = {
          baseRef: trackingBranchName, headRef: branchName, comparisonLabel: `${trackingBranchName}...${branchName}`,
          changes: parseNumstat(cmpStat.stdout).map((e) => {
            const rel = relOf(ws, e.path);
            return {
              path: e.path, stagePath: e.path, repoRelativePath: rel, workspaceRelativePath: rel,
              kind: kindOf(e.added, e.removed), section: 'branch', added: e.added, removed: e.removed,
              isStaged: false, isUntracked: false, isConflicted: false,
              diff: { path: e.path, availability: 'unavailable', patch: null, beforeContent: null, afterContent: null, summary: null },
            };
          }),
        };
      }
      return { summary, identity, unstagedChanges, stagedChanges, branchComparison };
    },
    // 文件展开 diff: {availability, patch, beforeContent, afterContent}
    async getDiff({ workspacePath, path: filePath, sourceId } = {}) {
      const ws = cwdOf(workspacePath);
      if (!filePath) return { availability: 'unavailable', patch: null, beforeContent: null, afterContent: null, summary: null };
      const root = await repoRootOf(ws);
      const d = await diffText(root, sourceId, filePath);
      if (!d.ok || !d.stdout.trim()) {
        // untracked 文件: 展示全文内容
        if (sourceId !== 'staged') {
          try {
            const content = await require('fs').promises.readFile(require('path').join(root, filePath), 'utf8');
            return { availability: 'patch', patch: null, beforeContent: null, afterContent: content, summary: null };
          } catch { /* fallthrough */ }
        }
        return { availability: 'unavailable', patch: null, beforeContent: null, afterContent: null, summary: null };
      }
      return { availability: 'patch', patch: d.stdout, beforeContent: null, afterContent: null, summary: null };
    },
    // ---- Git 操作 (actionMenu / branchSwitcher) ----
    async stagePaths({ workspacePath, paths } = {}) {
      const ws = cwdOf(workspacePath);
      const root = await repoRootOf(ws);
      const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p);
      if (!list.length) return { ok: true, staged: [] };
      const r = await run(['add', '--', ...list], root);
      if (!r.ok) throw gitErr(r, ['add']);
      return { ok: true, staged: list };
    },
    async commit({ workspacePath, message, paths, stagedOnly } = {}) {
      const ws = cwdOf(workspacePath);
      const msg = typeof message === 'string' && message.trim() ? message : null;
      if (!msg) throw new Error('commit 需要非空提交信息');
      if (Array.isArray(paths) && paths.length && stagedOnly === false) {
        // 按路径提交 (未暂存改动也包含): 先 stage 再 commit
        const root2 = await repoRootOf(ws);
        const add = await run(['add', '--', ...paths.filter((p) => typeof p === 'string' && p)], root2);
        if (!add.ok) throw gitErr(add, ['add']);
      }
      const c = await run(['commit', '-m', msg], ws);
      if (!c.ok) {
        const e = new Error((c.stderr || c.stdout || '').trim().slice(0, 400));
        e.detail = (c.stderr || '').split('\n')[0];
        throw e;
      }
      const h = await run(['rev-parse', 'HEAD'], ws);
      return { ok: true, hash: h.stdout.trim(), message: msg };
    },
    async push({ workspacePath } = {}) {
      const ws = cwdOf(workspacePath);
      const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'], ws);
      if (!branch.ok) throw new Error('非 Git 仓库');
      const p = await run(['push'], ws);
      if (!p.ok) {
        const e = new Error((p.stderr || p.stdout || '').trim().slice(0, 400));
        e.detail = (p.stderr || '').split('\n')[0];
        throw e;
      }
      return { ok: true, branchName: branch.stdout.trim(), message: '推送成功' };
    },
    async getLocalBranches({ workspacePath } = {}) {
      const ws = cwdOf(workspacePath);
      const cur = await run(['rev-parse', '--abbrev-ref', 'HEAD'], ws);
      if (!cur.ok) return { branches: [], currentBranchName: null, headRefType: 'branch' };
      const currentBranchName = cur.stdout.trim();
      const list = await run(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], ws);
      const branches = list.ok ? list.stdout.trim().split('\n').filter(Boolean)
        .map((name) => ({ name, isCurrent: name === currentBranchName })) : [];
      return { branches, currentBranchName, headRefType: 'branch' };
    },
    async switchBranch({ workspacePath, targetBranchName } = {}) {
      const ws = cwdOf(workspacePath);
      const name = typeof targetBranchName === 'string' ? targetBranchName.trim() : '';
      if (!name) throw new Error('switchBranch 需要目标分支名');
      const c = await run(['checkout', name], ws);
      if (!c.ok) throw new Error((c.stderr || c.stdout || '').trim().slice(0, 400));
      const cur = await run(['rev-parse', '--abbrev-ref', 'HEAD'], ws);
      const bn = cur.stdout.trim();
      return {
        ok: true, action: 'switch', branchName: bn, didChange: true, created: false,
        summary: { branchName: bn, headRefType: 'branch' },
        issues: [], detail: null, message: `已切换到 ${bn}`,
      };
    },
    async createBranchAndSwitch({ workspacePath, branchName } = {}) {
      const ws = cwdOf(workspacePath);
      const name = typeof branchName === 'string' ? branchName.trim() : '';
      if (!name) throw new Error('createBranchAndSwitch 需要分支名');
      const c = await run(['checkout', '-b', name], ws);
      if (!c.ok) throw new Error((c.stderr || c.stdout || '').trim().slice(0, 400));
      return {
        ok: true, action: 'create', branchName: name, didChange: true, created: true,
        summary: { branchName: name, headRefType: 'branch' },
        issues: [], detail: null, message: `已创建并切换到 ${name}`,
      };
    },
    async getCommitGraph({ workspacePath, maxCount, skip } = {}) {
      const ws = cwdOf(workspacePath);
      const limit = Math.max(1, Math.min(500, parseInt(maxCount, 10) || 50));
      const offset = Math.max(0, parseInt(skip, 10) || 0);
      const out = await run([
        'log', `--max-count=${limit + 1}`, `--skip=${offset}`,
        '--format=%H%x09%an%x09%at%x09%s%x09%P%x09%D',
      ], ws);
      if (!out.ok) return { commits: [], hasMore: false };
      const rows = out.stdout.trim().split('\n').filter(Boolean);
      const hasMore = rows.length > limit;
      const commits = rows.slice(0, limit).map((line) => {
        const [hash, authorName, at, subject, parents, refsRaw] = line.split('\t');
        const refs = (refsRaw || '').split(',').map((r) => r.trim()).filter(Boolean).map((r) => {
          const isHead = r === 'HEAD' || r.startsWith('HEAD ->');
          return { kind: isHead ? 'head' : r.startsWith('tag:') ? 'tag' : 'head', name: r.replace(/^HEAD ->\s*/, '') };
        });
        return {
          hash, authorName, subject: subject || '', authoredAtMs: (parseInt(at, 10) || 0) * 1000,
          parents: (parents || '').split(' ').filter(Boolean), refs,
        };
      });
      return { commits, hasMore };
    },
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

// ---------- UsageStats（本地模型调用统计 — 解析 rollout JSONL）----------
// 渲染器契约 (styles bundle _Vt/zBt/s7/lVt + AppUsage*Chart chunk 逆向):
//   getAppUsageSnapshot({range:'7d'|'30d'|'all', timeZone}) -> snapshot
//   snapshot = {
//     range, generatedAt,
//     summary: { totalTokens, peakDayTokens, longestSessionMs, currentStreakDays, longestStreakDays },
//     heatmap: { weeks: [{ days: [null|{date, totalTokens, turnCount, toolCallCount}] }] },
//     dailyModelUsage: [{ date, models: [{ modelId, totalTokens }] }],
//     models: [{ modelId, totalTokens }],
//   }
// 数据源: ~/.zcode/cli/rollout/model-io-sess_*.jsonl — 每行一次模型调用
//   { startedAt, model.modelId, response.usage.totalTokens, response.toolCalls.length,
//     durationMs, sessionId }
// Electron 原版读本地 sqlite; web 版直接扫 rollout 文件 (与服务同机, 数据一致)。
function usageStatsService({ logger }) {
  const ROLLOUT_DIR = path.join(os.homedir(), '.zcode', 'cli', 'rollout');
  let cache = null; let cachedAt = 0; let cacheMtime = 0;
  const TTL_MS = 30 * 1000;

  function localDateKey(isoMs, timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoMs));
    } catch { return new Date(isoMs).toISOString().slice(0, 10); }
  }

  /** 读全部调用记录 (带 30s 缓存; 目录 mtime 变化即失效) */
  function loadCalls() {
    const now = Date.now();
    let dirMtime = 0;
    try {
      dirMtime = fs.statSync(ROLLOUT_DIR).mtimeMs;
      // 30s 内且目录未变 → 复用 (文件内容追加不改目录 mtime — 再抽查一个文件大小和):
      if (cache && now - cachedAt < TTL_MS && dirMtime === cacheMtime) return cache;
    } catch { return []; }
    const calls = [];
    try {
      for (const name of fs.readdirSync(ROLLOUT_DIR)) {
        if (!/^model-io-sess_.*\.jsonl$/.test(name)) continue;
        let txt;
        try { txt = fs.readFileSync(path.join(ROLLOUT_DIR, name), 'utf8'); } catch { continue; }
        for (const line of txt.split('\n')) {
          if (!line.trim()) continue;
          let r;
          try { r = JSON.parse(line); } catch { continue; }
          const ts = r.startedAt ? Date.parse(r.startedAt) : NaN;
          const total = Number(r?.response?.usage?.totalTokens);
          if (!Number.isFinite(ts)) continue;
          calls.push({
            at: ts,
            modelId: typeof r?.model?.modelId === 'string' ? r.model.modelId : 'unknown',
            totalTokens: Number.isFinite(total) ? total : 0,
            toolCalls: Array.isArray(r?.response?.toolCalls) ? r.response.toolCalls.length : 0,
            durationMs: Number(r.durationMs) || 0,
            sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
          });
        }
      }
    } catch (e) {
      logger.warn?.('[usage-stats] 读取 rollout 失败:', e.message);
    }
    calls.sort((a, b) => a.at - b.at);
    cache = calls; cachedAt = now; cacheMtime = dirMtime;
    return calls;
  }

  return {
    async getEntitlementSnapshot() { return { entitled: false }; },
    async getUsage() { return { usage: {} }; },
    async getAppUsageSnapshot({ range, timeZone } = {}) {
      const calls = loadCalls();
      const now = Date.now();
      const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : null;
      const from = rangeDays ? now - rangeDays * 86400000 : 0;
      const scoped = calls.filter(c => c.at >= from);

      // 按天聚合 (全部历史算 streak; range 只裁剪图表数据)
      const byDayAll = new Map();
      const byDayScoped = new Map();
      const sessionMs = new Map();
      const modelTotals = new Map();
      const dailyModels = new Map();
      for (const c of calls) {
        const dk = localDateKey(c.at, timeZone);
        let d = byDayAll.get(dk);
        if (!d) { d = { date: dk, totalTokens: 0, turnCount: 0, toolCallCount: 0 }; byDayAll.set(dk, d); }
        d.totalTokens += c.totalTokens; d.turnCount += 1; d.toolCallCount += c.toolCalls;
        if (c.sessionId) sessionMs.set(c.sessionId, (sessionMs.get(c.sessionId) ?? 0) + c.durationMs);
        const mt = modelTotals.get(c.modelId) ?? 0;
        modelTotals.set(c.modelId, mt + c.totalTokens);
        if (c.at >= from) {
          let s = byDayScoped.get(dk);
          if (!s) { s = { date: dk, totalTokens: 0, turnCount: 0, toolCallCount: 0 }; byDayScoped.set(dk, s); }
          s.totalTokens += c.totalTokens; s.turnCount += 1; s.toolCallCount += c.toolCalls;
          let dm = dailyModels.get(dk);
          if (!dm) { dm = new Map(); dailyModels.set(dk, dm); }
          dm.set(c.modelId, (dm.get(c.modelId) ?? 0) + c.totalTokens);
        }
      }

      // streaks: 有使用的连续天数 (以本地日期)
      const dayKeys = [...byDayAll.keys()].sort();
      const todayKey = localDateKey(now, timeZone);
      let longestStreak = 0, run = 0, prev = null;
      for (const k of dayKeys) {
        if (prev !== null) {
          const gap = (Date.parse(k + 'T00:00:00Z') - Date.parse(prev + 'T00:00:00Z')) / 86400000;
          run = gap === 1 ? run + 1 : 1;
        } else run = 1;
        if (run > longestStreak) longestStreak = run;
        prev = k;
      }
      let currentStreak = 0;
      if (dayKeys.length) {
        // 从今天 (或最近的可用日) 往回数
        let cursor = dayKeys[dayKeys.length - 1] === todayKey ? todayKey : dayKeys[dayKeys.length - 1];
        for (let i = dayKeys.length - 1; i >= 0; i--) {
          if (dayKeys[i] === cursor) { currentStreak += 1; cursor = localDateKey(Date.parse(cursor + 'T00:00:00Z') - 86400000, timeZone); }
          else break;
        }
      }
      const longestSessionMs = Math.max(0, ...(sessionMs.size ? [...sessionMs.values()] : [0]));
      const scopedDays = [...byDayScoped.values()];
      const peakDayTokens = Math.max(0, ...(scopedDays.length ? scopedDays.map(d => d.totalTokens) : [0]));
      const totalTokens = scopedDays.reduce((s, d) => s + d.totalTokens, 0);

      // heatmap: 渲染器 tVt 会把 weeks 按周重排, 只需提供按天 cell;
      // 7 天一组塞进 weeks[].days (不足 7 天的尾周允许短数组 — tVt flatMap 兼容)
      const ordered = [...byDayScoped.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      const weeks = [];
      for (let i = 0; i < ordered.length; i += 7) weeks.push({ days: ordered.slice(i, i + 7) });

      const dailyModelUsage = [...dailyModels.entries()].sort(([a], [b]) => a < b ? -1 : 1)
        .map(([date, models]) => ({ date, models: [...models.entries()].map(([modelId, totalTokens]) => ({ modelId, totalTokens })) }));
      const models = [...modelTotals.entries()].map(([modelId, totalTokens]) => ({ modelId, totalTokens }))
        .sort((a, b) => b.totalTokens - a.totalTokens);

      return {
        range: range ?? 'all',
        generatedAt: now,
        summary: { totalTokens, peakDayTokens, longestSessionMs, currentStreakDays: currentStreak, longestStreakDays: longestStreak },
        heatmap: { weeks },
        dailyModelUsage,
        models,
      };
    },
  };
}


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
    [CHANNELS.UsageStats]: usageStatsService({ logger }),
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
    // ---------- Skills（设置页技能 tab + 各处 skill 徽标） ----------
    // 渲染器 skills tab: N.list({workspacePath, workspaceIdentity, provider})
    //   → {skills:[{id,name,description,path,scope,enabled}], capability, diagnostics:[]}
    //   N.setEnabled / N.deleteSkill —— app-server 只提供 skills/referenceCatalog(只读),
    //   启停/删除用 web state 本地标记, list 时把 disabled 标记叠加到 catalog 结果上。
    [CHANNELS.Skills]: (() => {
      let cache = null; let cacheAt = 0;
      const catalog = async (p) => {
        const ws = p?.workspacePath ? { workspacePath: p.workspacePath, workspaceKey: p.workspacePath } : defaultWorkspace;
        if (!cache || Date.now() - cacheAt > 30000) {
          try {
            cache = await appServer.request('skills/referenceCatalog', { workspace: ws }, { timeoutMs: 30000 });
            cacheAt = Date.now();
          } catch { cache = cache ?? { skills: [] }; }
        }
        return cache;
      };
      const disabledSet = async () => {
        const st = await loadWebState();
        return new Set(Array.isArray(st.skillsDisabled) ? st.skillsDisabled : []);
      };
      return {
        async list(p) {
          const cat = await catalog(p);
          const off = await disabledSet();
          const skills = (cat?.skills ?? []).map((s) => ({ ...s, enabled: s.enabled !== false && !off.has(s.id) }));
          return { skills, capability: cat?.capability ?? { supported: true }, diagnostics: [] };
        },
        async get(p) {
          const cat = await catalog(p);
          return (cat?.skills ?? []).find((s) => s.id === (p?.skillId ?? p?.id)) ?? null;
        },
        async setEnabled(p) {
          const off = await disabledSet();
          const id = p?.skillId;
          if (typeof id === 'string' && id) {
            if (p?.enabled === false) off.add(id); else off.delete(id);
            const st = await loadWebState();
            st.skillsDisabled = [...off];
            await saveWebState(st);
          }
          return { ok: true };
        },
        async deleteSkill(p) {
          // 真删用户 skill 文件风险高 —— 与禁用同等对待 (catalog 里标记为 disabled)
          return this.setEnabled({ ...p, enabled: false });
        },
      };
    })(),
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
    // ---------- Subagents（设置页子智能体 tab） ----------
    // 渲染器: H.list({workspacePath,workspaceIdentity,provider}) → eHt(e) =
    // [...e.agents.filter(a=>a.source!=='plugin'), ...e.pluginAgents] + e.capability
    //   H.setEnabled({agentId,enabled}) / H.updateAgent / H.createAgent / H.deleteAgent
    // built-in 两个 (general-purpose, Explore) + workspace .zcode/agents/*.md 扫描;
    // app-server 无 subagents RPC —— 服务端合成, 写操作落 web state 标记。
    [CHANNELS.Subagents]: (() => {
      const BUILTINS = [
        { id: 'builtin:general-purpose', name: 'general-purpose', description: '通用子智能体, 适合需要多步骤、搜索与工具调用的复杂任务', scope: 'built-in', source: 'built-in', readOnly: true, enabled: true },
        { id: 'builtin:explore', name: 'Explore', description: '只读探索子智能体, 用于代码库调研与信息收集', scope: 'built-in', source: 'built-in', readOnly: true, enabled: true },
      ];
      let wsCache = null; let wsCacheAt = 0; let wsCacheDir = '';
      const scanWorkspaceAgents = async (workspacePath) => {
        if (!workspacePath) return [];
        if (wsCacheDir === workspacePath && Date.now() - wsCacheAt < 30000) return wsCache;
        const out = [];
        try {
          const dir = path.join(workspacePath, '.zcode', 'agents');
          const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const ent of ents) {
            if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
            const id = `workspace:${ent.name}`;
            let description = '';
            try {
              const raw = await fsp.readFile(path.join(dir, ent.name), 'utf8');
              const m = raw.match(/^---[\s\S]*?description:\s*(.+)$/m);
              if (m) description = m[1].trim().replace(/^["']|["']$/g, '');
            } catch {}
            out.push({ id, name: ent.name.replace(/\.md$/, ''), description, path: path.join(dir, ent.name), scope: 'workspace', source: 'user', readOnly: false, enabled: true });
          }
        } catch {}
        wsCache = out; wsCacheAt = Date.now(); wsCacheDir = workspacePath;
        return out;
      };
      const disabledSet = async () => {
        const st = await loadWebState();
        return new Set(Array.isArray(st.subagentsDisabled) ? st.subagentsDisabled : []);
      };
      const allAgents = async (p) => {
        const off = await disabledSet();
        const wsAgents = await scanWorkspaceAgents(p?.workspacePath);
        return [...BUILTINS, ...wsAgents].map((a) => ({ ...a, enabled: a.enabled !== false && !off.has(a.id) }));
      };
      return {
        async list(p) {
          const agents = await allAgents(p);
          return { agents, pluginAgents: [], capability: { supported: true } };
        },
        async getAgent(p) {
          const agents = await allAgents(p);
          return agents.find((a) => a.id === (p?.agentId ?? p?.id)) ?? null;
        },
        async setEnabled(p) {
          const off = await disabledSet();
          const id = p?.agentId;
          if (typeof id === 'string' && id) {
            if (p?.enabled === false) off.add(id); else off.delete(id);
            const st = await loadWebState();
            st.subagentsDisabled = [...off];
            await saveWebState(st);
          }
          return { ok: true };
        },
        async deleteAgent(p) {
          // workspace 级用户 agent: 直接删 .md 文件; built-in 仅做禁用标记
          const agents = await allAgents(p);
          const a = agents.find((x) => x.id === p?.agentId);
          if (a?.path?.endsWith('.md') && a.source === 'user') {
            try { await fsp.unlink(a.path); wsCacheAt = 0; return { ok: true }; } catch {}
          }
          return this.setEnabled({ ...p, enabled: false });
        },
        async updateAgent() { return { ok: true }; },
        async createAgent() { return { ok: true }; },
        async setBuiltInModelOverride() { return { ok: true }; },
      };
    })(),
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
      // 渲染器 WikiReferenceSidePane 会订阅; web 版无 wiki 生成, 事件永不触发
      onDidChangeRepoWiki() {
        return new (require('../lib/rpc.js').Emitter)().event;
      },
    },
    [CHANNELS.PromptAttachmentTransfer]: { async begin() { return { ok: false }; }, async chunk() { return { ok: false }; }, async commit() { return { ok: false }; } },
    // 渲染器 offPeakStore: Promise.all([grayConfig, list, getCodingPlanSupport])
    // → codingPlanActive===true || supported===true 才启用错峰面板; web 版无套餐 → 不支持
    [CHANNELS.OffPeakTask]: {
      async list() { return { tasks: [] }; },
      async getGrayConfig() { return { enabled: false, codingPlanActive: false }; },
      async getCodingPlanSupport() { return { supported: false }; },
      async getTakeNumberAvailability() { return null; },
      async getNewTaskBannerDismissed() { return true; },
      async setNewTaskBannerDismissed() { return { ok: true }; },
      async cancelPendingCreateDraft() { return { ok: true }; },
    },
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
