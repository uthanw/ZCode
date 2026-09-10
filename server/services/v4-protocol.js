// server/services/v4-protocol.js
// V4 conversation/controller protocol —— 把渲染器的 *V4 channel 方法代理到 app-server 的
// v4/* JSON-RPC 方法，并把 v4/conversation/frame 等 wire 帧通知原样转发给渲染器。
//
// 实测确认（见 /tmp/test-reg-full.mjs）:
//  - subscribe 前必须 workspace/updateProviderRegistry 同步 provider（apiKey:{source:'inline',value}）
//  - 会话必须用 v4/command {type:'createSession'} 创建（session/create 建的会话 v4 命令会 FOREIGN KEY 失败）
//  - v4/command params = envelope 本身 {commandId, clientId, sessionId, baseRevision?, baseLogEpoch?, type, payload, issuedAt}
//  - 帧通知 params = wire 帧 {wireVersion, kind:'complete'|'fragment'|'fault', deliveryKind, logicalFrameId,
//    logicalFrameOrdinal, topic, subscriptionId, frame?{topic,subscriptionId,sentAt,fromSeq,toSeq,payload}}
//    渲染器端 Hl 装配器消费 wire 帧 —— 服务端必须原样转发，不要解包。
'use strict';
const crypto = require('node:crypto');
const { Emitter } = require('../lib/rpc.js');

const PROTOCOL_VERSION = 3;

function workspaceKey(ws) {
  const k = (ws?.workspaceIdentity?.trim() || ws?.workspacePath) ?? '';
  return typeof k === 'string' ? k : '';
}
function buildWorkspaceRef(ws) {
  return {
    workspacePath: ws?.workspacePath,
    ...(ws?.workspaceIdentity ? { workspaceIdentity: ws.workspaceIdentity } : {}),
    ...(ws?.remoteSessionId ? { remoteSessionId: ws.remoteSessionId } : {}),
    workspaceKey: workspaceKey(ws),
  };
}

/**
 * Provider registry snapshot —— 从 zcode CLI config.json 构造。
 * host 原版从渲染器 ModelProvider service (credential store + 静态目录) 构造;
 * web 版直接读 config.json 中用户配置的 provider（含 API key）。
 */
async function buildRegistryFromConfig(configPath, fs) {
  const fsp = fs ?? require('node:fs/promises');
  let cfg; let raw = '';
  try { raw = await fsp.readFile(configPath, 'utf8'); cfg = JSON.parse(raw); }
  catch { cfg = {}; }
  const providers = Object.entries(cfg.provider ?? {}).map(([pid, p]) => ({
    providerId: pid,
    kind: p.kind,
    ...(p.name ? { label: p.name } : {}),
    ...(p.options?.apiKey ? { apiKey: { source: 'inline', value: p.options.apiKey } } : {}),
    ...(p.options?.baseURL ? { baseURL: p.options.baseURL } : {}),
    models: Object.keys(p.models ?? {}).map(mid => ({ modelId: mid })),
  }));
  // revision 由内容哈希决定：config 未变 → revision 不变，渲染器 kme() 不会误判为“注册表更新”而反复重推。
  const revision = `web-${crypto.createHash('sha256').update(raw || '{}').digest('hex').slice(0, 16)}`;
  return { revision, generatedAt: Date.now(), providers };
}

class V4FrameHub {
  constructor(logger, defaultWorkspacePath) {
    this.logger = logger;
    this.defaultWorkspacePath = defaultWorkspacePath ?? '';
    this.convEmitters = new Map();   // workspaceKey -> Emitter (conversation/* topics, wire 帧原样)
    this.indexEmitters = new Map();  // workspaceKey -> Emitter (sessions-index/*)
    this.configEmitters = new Map(); // workspaceKey -> Emitter (workspace-config/*)
    this.telemetryEmitters = new Map();
    this.cuaEmitter = new Emitter();
  }
  _get(map, key) {
    let em = map.get(key);
    if (!em) { em = new Emitter(); map.set(key, em); }
    return em;
  }
  conv(key) { return this._get(this.convEmitters, key); }
  index(key) { return this._get(this.indexEmitters, key); }
  config(key) { return this._get(this.configEmitters, key); }
  telemetry(key) { return this._get(this.telemetryEmitters, key); }
  cua() { return this.cuaEmitter; }

  /** app-server notification 入口 —— wire 帧不带 workspace 字段, 单工作区部署直接广播到默认 key。*/
  dispatch(method, params) {
    try {
      if (method === 'v4/conversation/frame') {
        const topic = params?.topic;
        const wsKey = workspaceKey(params?.workspace ?? {}) || this.defaultWorkspacePath;
        if (typeof topic === 'string' && topic.startsWith('sessions-index/')) return this.index(wsKey).fire(params);
        if (typeof topic === 'string' && topic.startsWith('workspace-config/')) return this.config(wsKey).fire(params);
        return this.conv(wsKey).fire(params);
      }
      if (method === 'v4/telemetry/event') {
        return this.telemetry(workspaceKey(params?.workspace ?? { workspacePath: params?.workspaceKey }) || this.defaultWorkspacePath).fire(params);
      }
      if (method === 'v4/cua/permission-observation') return this.cua().fire(params);
    } catch (e) { this.logger?.warn?.('[v4] frame dispatch error:', e.message); }
  }
}

/**
 * 构建 zcode-agent channel 上的 V4 方法集。
 * ctx: { appServer, frameHub, logger, configPath, workspacePath, hub?, services? }
 */
function buildV4Methods({ appServer, frameHub, logger, configPath, workspacePath, hub }) {
  const A = (method, params) => appServer.request(method, params);
  /** 每 workspace 一次的 registry 同步 + connectionId */
  const connections = new Map(); // workspaceKey -> {connectionId, registrySynced}
  const connectionFor = (ws) => {
    const key = workspaceKey(ws);
    let c = connections.get(key);
    if (!c) { c = { connectionId: `agent-${crypto.randomUUID()}`, registrySynced: false }; connections.set(key, c); }
    return c;
  };
  /** registry 同步（幂等; 一次连接一次即可, 但 revision 变化时可重推）*/
  const ensureRegistry = async (ws) => {
    const c = connectionFor(ws);
    if (c.registrySynced) return;
    try {
      const registry = await buildRegistryFromConfig(configPath);
      await A('workspace/updateProviderRegistry', { workspace: buildWorkspaceRef(ws), registry });
      c.registrySynced = true;
      logger?.info?.('[v4] provider registry synced:', registry.providers.length, 'providers');
    } catch (e) {
      logger?.warn?.('[v4] provider registry sync failed:', e.message);
    }
  };

  return {
    // ---- 连接握手 ----
    async helloConversationV4() {
      const c = connectionFor({ workspacePath });
      return {
        kind: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        connectionId: c.connectionId,
        clientMode: 'desktop-continuous',
        deliveryProfile: 'continuous',
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: 'none',
          workspaceHookReview: true,
        },
        auth: {},
      };
    },
    async initializeConversationV4(m) {
      if (m?.kind !== 'clientHello' || m?.protocolVersion !== PROTOCOL_VERSION) {
        const err = new Error('fault.connection.clientHelloRejected'); err.code = -32602; throw err;
      }
      return {};
    },
    async setConnectionFlowStateV4(m) {
      const c = connectionFor({ workspacePath });
      return A('v4/connection/flow', { connectionId: c.connectionId, state: m?.state });
    },

    // ---- conversation ----
    async subscribeConversationV4(m) {
      if (!m?.sessionId) throw new Error('sessionId required');
      await ensureRegistry(m);
      const c = connectionFor(m);
      return A('v4/conversation/subscribe', {
        topic: `conversation/${m.sessionId}`,
        connectionId: c.connectionId,
        clientMode: 'desktop-continuous',
        workspace: buildWorkspaceRef(m),
        ...(m.base !== undefined ? { base: m.base } : {}),
        ...(m.visibility !== undefined ? { visibility: m.visibility } : {}),
      });
    },
    async unsubscribeConversationV4(m) {
      const c = connectionFor(m);
      return A('v4/conversation/unsubscribe', {
        topic: `conversation/${m.sessionId}`,
        subscriptionId: m?.subscriptionId,
        connectionId: c.connectionId,
      });
    },
    async resyncConversationV4(m) {
      const c = connectionFor(m);
      return A('v4/conversation/resync', {
        topic: `conversation/${m.sessionId}`,
        subscriptionId: m?.subscriptionId,
        connectionId: c.connectionId,
        ...(m?.forceSnapshot !== undefined ? { forceSnapshot: m.forceSnapshot } : {}),
      });
    },
    async conversationRowsRangeV4(m) {
      return A('v4/conversation/rowsRange', {
        sessionId: m.sessionId,
        clientMode: 'desktop-continuous',
        ...(m.beforeRowId !== undefined ? { beforeRowId: m.beforeRowId } : {}),
        limit: m.limit,
      });
    },
    async conversationPlansV4(m) { return A('v4/conversation/plans', { sessionId: m.sessionId }); },
    async conversationFileChangesV4(m) {
      return A('v4/conversation/fileChanges', {
        sessionId: m.sessionId, target: m.target,
        baseRevision: m.baseRevision, baseLogEpoch: m.baseLogEpoch,
      });
    },
    async conversationFileRewindPreviewV4(m) {
      return A('v4/conversation/fileRewindPreview', {
        sessionId: m.sessionId, target: m.target,
        baseRevision: m.baseRevision, baseLogEpoch: m.baseLogEpoch,
      });
    },
    async sendConversationCommandV4(m) {
      // m: {workspacePath, workspaceIdentity?, remoteSessionId?, envelope}
      // v4/command params = envelope 本身
      await ensureRegistry(m);
      const res = await A('v4/command', m?.envelope);
      // 任务(≡会话)发生变化 → 通知渲染器任务列表实时刷新:
      //  - createSession → task_created;其余会话级命令(sendText/rename/compact/goal...) →
      //    task_meta_changed(不带 taskMeta/taskId 时渲染器会整表刷新, 安全)
      try {
        const type = m?.envelope?.type;
        const cmdSessionId = res?.sessionId ?? res?.result?.sessionId ?? m?.envelope?.sessionId ?? null;
        const wsKey = workspaceKey(m) || workspacePath;
        if (type === 'createSession' && (res?.status === 'accepted' || res?.status === 'ok')) {
          hub?.fireTaskListChanged(wsKey, 'task_created', cmdSessionId ? { taskId: cmdSessionId } : undefined);
        } else if (['sendText', 'renameSession', 'setSessionTitle', 'compactSession', 'goalCommand', 'resolveInteraction', 'steerTurn', 'interruptConversation', 'setSessionMode', 'setSessionModel'].includes(type)
                   && (res?.status === 'accepted' || res?.status === 'ok')) {
          hub?.fireTaskListChanged(wsKey, 'task_meta_changed', cmdSessionId ? { taskId: cmdSessionId } : undefined);
        }
      } catch (e) { logger?.warn?.('[v4] fireTaskListChanged error:', e.message); }
      return res;
    },
    async queryConversationCommandsV4(m) {
      return A('v4/commands/query', { commands: m?.commands });
    },
    async resolveRuntimeModelForV4(m) {
      // 渲染器在 sendText 前用它解析默认 runtimeModel; web 端交由 app-server 默认模型, 返回 undefined
      return undefined;
    },

    // ---- attachments ----
    async attachmentBeginV4(m) {
      const c = connectionFor(m);
      return A('v4/attachment/begin', {
        connectionId: c.connectionId, uploadId: m.uploadId, sessionId: m.sessionId,
        fileName: m.fileName, mime: m.mime, totalBytes: m.totalBytes, totalChunks: m.totalChunks, checksum: m.checksum,
      });
    },
    async attachmentChunkV4(m) {
      const c = connectionFor(m);
      return A('v4/attachment/chunk', {
        connectionId: c.connectionId, uploadId: m.uploadId, sessionId: m.sessionId,
        chunkIndex: m.chunkIndex, dataBase64: m.dataBase64, checksum: m.checksum,
      });
    },
    async attachmentCommitV4(m) {
      const c = connectionFor(m);
      return A('v4/attachment/commit', { connectionId: c.connectionId, uploadId: m.uploadId, sessionId: m.sessionId });
    },
    async attachmentAbortV4(m) {
      const c = connectionFor(m);
      return A('v4/attachment/abort', { connectionId: c.connectionId, uploadId: m.uploadId, sessionId: m.sessionId });
    },
    async attachmentReadV4(m) {
      const c = connectionFor(m);
      return A('v4/attachment/read', {
        connectionId: c.connectionId, sessionId: m.sessionId, ref: m.ref,
        ...(m.target ? { target: m.target } : {}),
        ...(m.attachmentIndex !== undefined ? { attachmentIndex: m.attachmentIndex } : {}),
        offset: m.offset, limit: m.limit,
      });
    },
    async attachmentPreviewSourceV4(m) {
      const c = connectionFor(m);
      return A('v4/attachment/previewSource', {
        connectionId: c.connectionId, sessionId: m.sessionId, ref: m.ref,
        ...(m.target ? { target: m.target } : {}),
        ...(m.attachmentIndex !== undefined ? { attachmentIndex: m.attachmentIndex } : {}),
      });
    },

    // ---- sessions index ----
    // 关键发现: app-server 没有 v4/controller/subscribe, 但 v4/conversation/subscribe
    // 会按 topic 前缀路由 —— topic 为 `sessions-index/<workspaceKey>` 时由 indexPublisher
    // 生成真实快照/增量帧 (v4/conversation/frame 通知), 服务端原样转发即可。
    // 实测: ack={subscriptionId,mode:'snapshot',logEpoch}; 初始帧 deliveryKind 'initial'。
    async subscribeSessionsIndexV4(m) {
      const c = connectionFor(m);
      const key = workspaceKey(m) || workspacePath;
      return A('v4/conversation/subscribe', {
        topic: `sessions-index/${key}`,
        connectionId: c.connectionId,
        clientMode: 'desktop-continuous',
        ...(m?.workspacePath || m?.workspaceIdentity ? { workspace: buildWorkspaceRef(m) } : {}),
        ...(m?.base !== undefined ? { base: m.base } : {}),
        ...(m?.visibility !== undefined ? { visibility: m.visibility } : {}),
      });
    },
    async unsubscribeSessionsIndexV4(m) {
      const c = connectionFor(m);
      const key = workspaceKey(m) || workspacePath;
      try {
        return await A('v4/conversation/unsubscribe', {
          topic: `sessions-index/${key}`,
          subscriptionId: m?.subscriptionId,
          connectionId: c.connectionId,
        });
      } catch (e) { if (/Method not found/.test(e.message ?? '')) return {}; throw e; }
    },
    async resyncSessionsIndexV4(m) {
      const c = connectionFor(m);
      const key = workspaceKey(m) || workspacePath;
      try {
        return await A('v4/conversation/resync', {
          topic: `sessions-index/${key}`,
          subscriptionId: m?.subscriptionId,
          connectionId: c.connectionId,
          ...(m?.base !== undefined ? { base: m.base } : {}),
          ...(m?.forceSnapshot !== undefined ? { forceSnapshot: m.forceSnapshot } : {}),
        });
      } catch (e) { if (/Method not found/.test(e.message ?? '')) return {}; throw e; }
    },

    // ---- usage ----
    async usageStatsV4(m) { return A('v4/usage/stats', m ?? {}); },
    async conversationUsageV4(m) { return A('v4/conversation/usage', m ?? {}); },

    // ---- 动态事件 ----
    onDynamicConversationFrame(arg) { return frameHub.conv(workspaceKey(arg ?? {})).event; },
    onDynamicSessionsIndexFrame(arg) { return frameHub.index(workspaceKey(arg ?? {})).event; },
    onDynamicWorkspaceConfigFrame(arg) { return frameHub.config(workspaceKey(arg ?? {})).event; },
    onDynamicConversationTelemetryFact(arg) { return frameHub.telemetry(workspaceKey(arg ?? {})).event; },
    onDynamicCuaPermissionObservation() { return frameHub.cua().event; },
  };
}

module.exports = { buildV4Methods, V4FrameHub, buildRegistryFromConfig, helloShape: null, workspaceKey, buildWorkspaceRef, PROTOCOL_VERSION };
