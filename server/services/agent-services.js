// server/services/agent-services.js —— ZCodeSession / ZCodeTask / ZCodeAgent 三个 channel
// 对接 zcode.cjs app-server（ZCode Protocol over stdio JSON）。
'use strict';
const { Emitter } = require('../lib/rpc');

// ---------- 共享：app-server 事件分发 ----------
// app-server 的通知流 (state.updated / v4/telemetry / conversation frames ...) 按 workspaceKey
// 转发给渲染器的动态事件。桌面版是 per-session Emitter + seq 补齐；web 版做简化版：
// 每条通知原样 fire 到对应 session/workspace 的事件流。
class AgentEventHub {
  constructor(appServer, logger) {
    this.appServer = appServer;
    this.logger = logger;
    this.sessionEmitters = new Map();   // sessionId -> Emitter
    this.workspaceEmitters = new Map(); // workspaceKey -> Emitter
    this.subscribed = new Set();        // 已 session/subscribe 的 sessionId
    this.taskListChangedListeners = new Set();
    this.sessionsIndexFrameListeners = new Set();
    appServer.onNotification((method, params) => this.onNotify(method, params));
    // server -> client 请求（requestRuntimePreferences / requestPermission 等）自动应答
    appServer.onRequest(async (method, params) => {
      try { return await this.handleServerRequest(method, params); }
      catch (e) { this.logger.warn?.('server request handler error:', method, e.message); return {}; }
    });
  }

  sessionEmitter(sessionId) {
    let em = this.sessionEmitters.get(sessionId);
    if (!em) { em = new Emitter({ onDidRemoveLastListener: () => this.sessionEmitters.delete(sessionId) }); this.sessionEmitters.set(sessionId, em); }
    return em;
  }

  workspaceEmitter(workspaceKey) {
    let em = this.workspaceEmitters.get(workspaceKey);
    if (!em) { em = new Emitter({ onDidRemoveLastListener: () => this.workspaceEmitters.delete(workspaceKey) }); this.workspaceEmitters.set(workspaceKey, em); }
    return em;
  }

  /**
   * 通知渲染器任务列表发生变化。渲染器 (useWorkspaceTaskLists / useGroupedTaskView) 监听
   * zcodeTaskService.onDynamicWorkspaceEvent({workspacePath}) 上的
   * {type:'workspace_task_list_changed', reason, workspacePath} 事件:
   *  - reason ∈ {task_created, task_meta_changed, task_deleted} 或不识别的 reason 且事件
   *    不带 taskMeta/taskId → 触发整表刷新 (manualRefreshSerial bump → listTasks 重拉)
   *  - reason ∈ {task_archived, task_unarchived, task_pinned, task_unpinned} → 增量处理
   * 注意 workspacePath 必须与渲染器 scope 的 workspacePath 一致（au() 匹配用）。
   */
  fireTaskListChanged(workspaceKey, reason, extra) {
    if (!workspaceKey) return;
    const ev = {
      type: 'workspace_task_list_changed',
      reason,
      workspacePath: workspaceKey,
      ...(extra ?? {}),
    };
    try { this.workspaceEmitter(workspaceKey).fire(ev); } catch (e) { this.logger.warn?.('fireTaskListChanged error:', e.message); }
    // windowController 等内部组件的回调（合成 controller 帧用）
    for (const cb of [...this.taskListChangedListeners]) {
      try { cb(ev); } catch (e) { this.logger.warn?.('taskListChanged listener error:', e.message); }
    }
  }

  /** 内部订阅任务列表变化（windowController 合成 controller 帧用）。返回取消函数。*/
  onTaskListChanged(cb) {
    this.taskListChangedListeners.add(cb);
    return () => this.taskListChangedListeners.delete(cb);
  }

  /**
   * app-server sessions-index 帧回调（V4FrameHub 调用）。sessions-index 增量是
   * 会话真实可见时刻（v4 createSession 的会话 sendText 之后才进 session/list 与索引），
   * windowController 据此重推 controller 快照帧。
   */
  notifySessionsIndexFrame(frame) {
    for (const cb of [...this.sessionsIndexFrameListeners]) {
      try { cb(frame); } catch (e) { this.logger.warn?.('sessionsIndexFrame listener error:', e.message); }
    }
  }

  onSessionsIndexFrame(cb) {
    this.sessionsIndexFrameListeners.add(cb);
    return () => this.sessionsIndexFrameListeners.delete(cb);
  }

  async ensureSubscribed(sessionId) {
    if (this.subscribed.has(sessionId)) return;
    this.subscribed.add(sessionId);
    try { await this.appServer.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }); }
    catch (e) { this.subscribed.delete(sessionId); this.logger.warn?.('subscribe failed:', e.message); }
  }

  onNotify(method, params) {
    if (!params || typeof params !== 'object') return;
    // 服务端 -> 客户端请求（requestRuntimePreferences 等）：自动应答
    const sid = params.sessionId;
    const wsKey = params.workspace?.workspaceKey;
    // 桌面版渲染器消费的事件类型：
    if (method === 'state.updated') {
      if (sid) this.sessionEmitter(sid).fire({ type: 'state.updated', ...params });
      if (wsKey) this.workspaceEmitter(wsKey).fire({ type: 'state.updated', ...params });
      return;
    }
    if (method === 'conversation/frame') {
      if (sid) this.sessionEmitter(sid).fire({ type: 'conversation.frame', ...params });
      return;
    }
    // v4/conversation/frame 由 V4FrameHub 处理（zcode-agent channel），此处跳过
    if (method === 'computer-use/operation-event') {
      if (sid) this.sessionEmitter(sid).fire({ type: 'computer-use.operation-event', ...params });
      return;
    }
    // 其余事件（telemetry/process/*）不转发，减少噪音
  }

  /** app-server 的 server->client request 处理（在 AppServerClient 层做）*/
  async handleServerRequest(method, params) {
    // session/create / session/send 期间 app-server 会阻塞等待此应答，字段缺一不可
    if (method === 'session/requestRuntimePreferences') {
      return { askUserQuestionAutoResolutionEnabled: true, nativeSearchEnhancementsEnabled: true, memoryEnabled: false };
    }
    // interaction/requestPermission 等一律批准（单人自用服务）
    if (method === 'interaction/requestPermission' || method === 'interaction/requestUserInput') {
      return { decisions: (params?.requests ?? []).map((r) => ({ requestId: r.requestId, decision: 'allow' })) };
    }
    return {};
  }
}

function normWs(p) {
  return { workspacePath: p?.workspacePath, workspaceIdentity: p?.workspaceIdentity, workspaceKey: p?.workspacePath };
}

// ---------- ZCodeSession channel ----------
function buildZodeSessionService({ appServer, defaultWorkspace, logger, hub }) {
  hub = hub ?? new AgentEventHub(appServer, logger);
  const svc = {
    _hub: hub,
    async createSession(p) {
      const params = {
        workspace: normWs(p) , model: p.model,
        ...(p.thoughtLevel !== undefined ? { thoughtLevel: p.thoughtLevel } : {}),
        ...(p.persistence !== undefined ? { persistence: p.persistence } : {}),
        ...(p.mode !== undefined ? { mode: p.mode } : {}),
      };
      const res = await appServer.request('session/create', params, { timeoutMs: 60000 });
      const sid = res.session.sessionId;
      await hub.ensureSubscribed(sid);
      return res;
    },
    async closeSession(p) { return appServer.request('session/close', { sessionId: p.sessionId, ...(p.expectedPersistence ? { expectedPersistence: p.expectedPersistence } : {}) }); },
    async closeDeferredDraftSession(p) { return appServer.request('session/close', { sessionId: p.sessionId, expectedPersistence: 'deferred' }); },
    async readSession(p) {
      return appServer.request('session/read', {
        sessionId: p.sessionId,
        ...(p.deliveryKind !== undefined ? { deliveryKind: p.deliveryKind } : {}),
        ...(p.messageLimit !== undefined ? { messageLimit: p.messageLimit } : {}),
        ...(p.afterSeq !== undefined ? { afterSeq: p.afterSeq } : {}),
      }, { timeoutMs: 30000 });
    },
    async readWorkspaceState(p) {
      return appServer.request('workspace/readState', { workspace: normWs(p) }, { timeoutMs: 30000 });
    },
    async setModel(p) {
      return appServer.request('session/setModel', { sessionId: p.sessionId, model: p.model, ...(p.runtimeModel ? { runtimeModel: p.runtimeModel } : {}) });
    },
    // 渲染器 Sf()/kme() 保存 provider 后把 registry 推给 agent 运行时：
    // remoteZCodeSessionService.updateProviderRegistry({workspacePath, registry, includeWorkspaceState, runtimePolicy})
    // 返回必须含 {status, appliedProviderRevision, providerCount, ...workspaceState}
    async updateProviderRegistry(p) {
      const params = {
        workspace: normWs(p),
        registry: p.registry,
        ...(p.includeWorkspaceState !== undefined ? { includeWorkspaceState: p.includeWorkspaceState } : {}),
        ...(p.runtimePolicy ? { runtimePolicy: p.runtimePolicy } : {}),
      };
      return appServer.request('workspace/updateProviderRegistry', params, { timeoutMs: 30000 });
    },
    async setThoughtLevel(p) { return appServer.request('session/setThoughtLevel', { sessionId: p.sessionId, thoughtLevel: p.thoughtLevel }); },
    async setWorkspaceDefaultModel(p) {
      const st = await appServer.request('workspace/setDefaultModel', { workspace: normWs(p), model: p.model }, { timeoutMs: 30000 });
      return st;
    },
    async setWorkspaceDefaultThoughtLevel(p) {
      return appServer.request('workspace/setDefaultThoughtLevel', { workspace: normWs(p), thoughtLevel: p.thoughtLevel }, { timeoutMs: 30000 });
    },
    async respondProviderRuntimeHeaders(p) { return { ok: true }; },
    async resolveRuntimeModelForView(p) { return null; },
    // v4-pane 预热会话: 失败/返回 null 时渲染器 "回落仅携带 config" —— null 即安全值
    async resolveRuntimeModelForV4(p) { return null; },
    // 事件：onDynamicSessionEvent({sessionId})
    onDynamicSessionEvent(arg) {
      const sid = arg?.sessionId;
      if (!sid) return new Emitter().event;
      const em = hub.sessionEmitter(sid);
      hub.ensureSubscribed(sid);
      return em.event;
    },
  };
  return svc;
}

// ---------- ZCodeTask channel ----------
// 桌面版把 task 存本地 sqlite 索引。web 版用 app-server 的 session/list + workspace 状态生成
// 任务视图；任务 ≡ 会话（taskId === sessionId），与桌面版一致（taskId 就是 session id）。
function buildZCodeTaskService({ appServer, defaultWorkspace, logger, services, hub }) {
  const taskMetaCache = new Map(); // sessionId -> meta fields (title, createdAt...)

  async function listSessions(p) {
    try {
      const res = await appServer.request('session/list', {
        workspace: normWs(p),
        includeArchived: true,
        limit: 500, // app-server 默认 50，会截断长会话列表
      }, { timeoutMs: 30000 });
      return res.sessions ?? [];
    } catch (e) { logger.warn?.('session/list failed:', e.message); return []; }
  }

  function sessionToTaskIndex(sess, workspacePath) {
    const sid = sess.sessionId;
    const meta = taskMetaCache.get(sid) ?? {};
    return {
      taskId: sid,
      traceId: meta.traceId ?? `zcode-${sid}`,
      title: meta.title ?? sess.title ?? 'Session',
      titleOverridden: Boolean(meta.titleOverridden),
      workspacePath,
      workspacePurpose: 'project',
      createdAt: sess.createdAt ?? meta.createdAt ?? Date.now(),
      updatedAt: sess.updatedAt ?? meta.updatedAt ?? Date.now(),
      mode: sess.mode ?? 'build',
      model: sess.model ? `${sess.model.providerId}/${sess.model.modelId}` : undefined,
      status: sess.archivedAt ? 'archived' : (sess.status ?? 'idle'),
      unreadAt: meta.unreadAt,
    };
  }

  const svc = {
    /** windowControllerService 用: 读取任务元数据缓存（title/pinned/archived/...） */
    _taskMetaOf(taskId) { return taskMetaCache.get(taskId) ?? {}; },
    async listTasks(p) {
      const sessions = await listSessions(p);
      return sessions.filter((s) => !s.archivedAt).map((s) => sessionToTaskIndex(s, p?.workspacePath));
    },
    async listArchivedTasks(p) {
      const sessions = await listSessions(p);
      return sessions.filter((s) => s.archivedAt).map((s) => sessionToTaskIndex(s, p?.workspacePath));
    },
    async listPinnedTasks(p) {
      const sessions = await listSessions(p);
      return sessions.filter((s) => taskMetaCache.get(s.sessionId)?.pinned).map((s) => sessionToTaskIndex(s, p?.workspacePath));
    },
    async listPinnedTaskIds() {
      const out = [];
      for (const [sid, m] of taskMetaCache) if (m.pinned) out.push(sid);
      return out;
    },
    async listDeletedTaskIds() { return []; },
    async listGroupedTaskViewStructure() { return { groups: [], members: [], topLevelOrders: [] }; },
    async createTaskGroup(p) { return { groupId: `grp-${Date.now()}`, ...p }; },
    async renameTaskGroup() { return { ok: true }; },
    async deleteTaskGroup() { return { ok: true }; },
    async renameTask(p) {
      const m = taskMetaCache.get(p.taskId) ?? {};
      m.title = p.title; m.titleOverridden = true;
      taskMetaCache.set(p.taskId, m);
      hub?.fireTaskListChanged(p?.workspacePath ?? defaultWorkspace.workspacePath, 'task_meta_changed', { taskId: p.taskId, taskMeta: { title: p.title, titleOverridden: true } });
      return { ok: true };
    },
    async archiveTask(p) {
      try { await appServer.request('session/close', { sessionId: p.taskId }); } catch {}
      const m = taskMetaCache.get(p.taskId) ?? {}; m.archived = true; taskMetaCache.set(p.taskId, m);
      hub?.fireTaskListChanged(p?.workspacePath ?? defaultWorkspace.workspacePath, 'task_archived', { taskId: p.taskId });
      return { ok: true };
    },
    async unarchiveTask(p) {
      const m = taskMetaCache.get(p.taskId) ?? {}; m.archived = false; taskMetaCache.set(p.taskId, m);
      hub?.fireTaskListChanged(p?.workspacePath ?? defaultWorkspace.workspacePath, 'task_unarchived', { taskId: p.taskId });
      return { ok: true };
    },
    async deleteTask(p) {
      try { await appServer.request('session/close', { sessionId: p.taskId }); } catch {}
      hub?.fireTaskListChanged(p?.workspacePath ?? defaultWorkspace.workspacePath, 'task_deleted', { taskId: p.taskId });
      return { ok: true };
    },
    async setTaskPinned(p) {
      const m = taskMetaCache.get(p.taskId) ?? {}; m.pinned = true; taskMetaCache.set(p.taskId, m);
      hub?.fireTaskListChanged(p?.workspacePath ?? defaultWorkspace.workspacePath, 'task_pinned', { taskId: p.taskId });
      return { ok: true };
    },
    async setTaskUnread(p) { const m = taskMetaCache.get(p.taskId) ?? {}; m.unreadAt = Date.now(); taskMetaCache.set(p.taskId, m); return { ok: true }; },
    async setTaskUnpinned(p) {
      const m = taskMetaCache.get(p.taskId) ?? {}; m.pinned = false; taskMetaCache.set(p.taskId, m);
      hub?.fireTaskListChanged(p?.workspacePath ?? defaultWorkspace.workspacePath, 'task_unpinned', { taskId: p.taskId });
      return { ok: true };
    },
    async applyGroupedTaskViewOrder() { return { ok: true }; },
    async updateTaskGroupColor() { return { ok: true }; },
    async setWorkspacePreferredModel(p) {
      return appServer.request('workspace/setDefaultModel', { workspace: normWs(p), model: p.model }, { timeoutMs: 30000 });
    },
    async restartWorkspaceProcess() { return { ok: true }; },
    async releaseWorkspacePreparation() { return { ok: true }; },
    // useWorkspaceProviderConfigFile: r.path / r.exists —— provider 配置文件位置（我们的 provider 统一存 CLI config）
    async getWorkspaceProviderConfigFile(p) {
      const cfgPath = require('node:path').join(require('node:os').homedir(), '.zcode/cli/config.json');
      let exists = false;
      try { exists = (await require('node:fs/promises').stat(cfgPath)).isFile(); } catch {}
      return { path: cfgPath, exists, ...(p?.workspacePath ? { workspacePath: p.workspacePath } : {}) };
    },
    // useTaskSessionFilePath / useTaskNativeSessionLogFile: {path, exists} —— 无本地快照文件，返回不存在即可
    async getTaskSessionFilePath() { return { path: null, exists: false }; },
    async getTaskNativeSessionLogFile() { return { path: null, exists: false }; },
    // 注意：事件方法不能是 async —— fromService 的动态事件路径会把返回值当订阅函数调用，
    // async 函数返回 Promise，曾导致 "channel.listen(...) is not a function"。
    onDynamicWorkspaceEvent(arg) {
      const key = arg?.workspacePath;
      if (!key) return new Emitter().event;
      return services['zcode-session']._hub.workspaceEmitter(key).event;
    },
  };
  return svc;
}

// ---------- ZCodeAgent channel ----------
function buildZCodeAgentService({ appServer, defaultWorkspace, logger, configPath, services, hub }) {
  const restartEmitter = new Emitter();
  // V4 conversation/controller 协议 —— 桥接渲染器 *V4 方法与 app-server v4/* 方法
  const { buildV4Methods, V4FrameHub } = require('./v4-protocol');
  const frameHub = new V4FrameHub(logger, defaultWorkspace);
  // app-server 的 v4 wire 帧通知 → frameHub → 渲染器 onDynamic* 事件
  appServer.onNotification((method, params) => {
    if (method === 'v4/conversation/frame' || method === 'v4/telemetry/event' || method === 'v4/cua/permission-observation') {
      frameHub.dispatch(method, params);
      // sessions-index 增量/快照 = 会话真实可见时刻 → hub 转给 windowController 重推快照
      if (method === 'v4/conversation/frame' && typeof params?.topic === 'string' && params.topic.startsWith('sessions-index/')) {
        hub?.notifySessionsIndexFrame?.(params);
      }
    }
  });
  const v4 = buildV4Methods({
    appServer, frameHub, logger, hub,
    configPath: configPath ?? require('node:path').join(require('node:os').homedir(), '.zcode/cli/config.json'),
    workspacePath: defaultWorkspace,
  });
  return {
    ...v4,
    async sendPrompt(p) {
      const params = {
        sessionId: p.sessionId,
        inputId: p.inputId ?? `inp_${Date.now()}`,
        ...(p.queryId ? { queryId: p.queryId } : {}),
        content: p.content,
        ...(p.attachments ? { attachments: p.attachments } : {}),
        ...(p.runtimeModel ? { runtimeModel: p.runtimeModel } : {}),
        ...(p.expectedRevision !== undefined ? { expectedRevision: p.expectedRevision } : {}),
      };
      return appServer.request('session/send', params, { timeoutMs: 3 * 60 * 1000 });
    },
    async listPlugins(p) {
      try { return await appServer.request('plugins/list', { workspace: normWs(p) }, { timeoutMs: 30000 }); }
      catch { return { plugins: [] }; }
    },
    async getPluginsOverview(p) {
      try { return await appServer.request('plugins/overview', { workspace: normWs(p) }, { timeoutMs: 60000 }); }
      catch (e) { logger?.warn?.('[zcode-agent] plugins/overview failed:', e.message); return { plugins: [], marketplaces: [], availablePlugins: [], installedPlugins: [], restorableBuiltins: [], diagnostics: [] }; }
    },
    async getPluginReferenceCatalog(p) {
      try { return await appServer.request('plugins/referenceCatalog', { workspace: normWs(p) }, { timeoutMs: 30000 }); }
      catch { return { plugins: [] }; }
    },
    async getSkillReferenceCatalog(p) {
      try { return await appServer.request('skills/referenceCatalog', { workspace: normWs(p) }, { timeoutMs: 30000 }); }
      catch { return { skills: [] }; }
    },
    async installPlugin(p) { return appServer.request('plugins/install', { workspace: normWs(p), pluginName: p.pluginName, marketplace: p.marketplace }, { timeoutMs: 120000 }); },
    async addPluginMarketplace(p) { return appServer.request('plugins/marketplace/add', { workspace: normWs(p), source: p.source }, { timeoutMs: 120000 }); },
    // 市场刷新要从 github/cdn 拉目录，慢源首次可达 60s+ —— 给足超时，避免渲染器端一直转圈
    async updatePluginMarketplace(p) { return appServer.request('plugins/marketplace/update', { workspace: normWs(p), ...(p.marketplace ? { marketplace: p.marketplace } : {}) }, { timeoutMs: 180000 }); },
    onAgentRuntimeRestarted: restartEmitter.event,
    // onDynamicCuaPermissionObservation 已由 v4 提供
  };
}

module.exports = { buildZodeSessionService, buildZCodeTaskService, buildZCodeAgentService, AgentEventHub };
