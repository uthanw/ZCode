import type { IServiceAccessor } from "@zcode/services";
import { createUuid } from "@zcode/shared";

export interface TerminalSessionDescriptor {
  id: string;
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
  index: number;
  shellLabel: string | null;
  /**
   * 服务端 PTY id。与客户端 UUID 分开维护：PTY 在页面刷新/客户端断开后仍然存活，
   * 刷新后按这个 id 调 terminalService.has/readScrollback 重连并回放缓冲。
   */
  serverId?: string;
}

export interface TerminalWorkspaceState {
  sessionIds: string[];
  activeSessionId: string;
}

export interface TerminalPanelState {
  sessions: Record<string, TerminalSessionDescriptor>;
  workspaces: Record<string, TerminalWorkspaceState>;
}

export function createTerminalSession(params: {
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
  index: number;
}): TerminalSessionDescriptor {
  return {
    id: createUuid(),
    workspaceKey: params.workspaceKey,
    services: params.services,
    cwd: params.cwd,
    index: params.index,
    shellLabel: null,
  };
}

export function createWorkspaceTerminalState(params: {
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
}): {
  session: TerminalSessionDescriptor;
  workspace: TerminalWorkspaceState;
} {
  const session = createTerminalSession({
    workspaceKey: params.workspaceKey,
    services: params.services,
    cwd: params.cwd,
    index: 1,
  });

  return {
    session,
    workspace: {
      sessionIds: [session.id],
      activeSessionId: session.id,
    },
  };
}

export function getNextTerminalSessionIndex(
  state: TerminalPanelState,
  workspaceKey: string,
): number {
  const workspace = state.workspaces[workspaceKey];
  const usedIndices = new Set(
    workspace?.sessionIds
      .map((sessionId) => state.sessions[sessionId]?.index)
      .filter((index): index is number => typeof index === "number") ?? [],
  );

  // 把 nextIndex 作为只增不减的派生状态保存，会让关闭编号 2 后再新建错误地得到 3。
  // 编号事实已经存在于 session descriptor 中，创建时从现存 session 推导最小空位，避免两份状态漂移。
  for (let index = 1; ; index += 1) {
    if (!usedIndices.has(index)) {
      return index;
    }
  }
}

export function formatTerminalTabTitle(projectName: string, index: number): string {
  return index === 1 ? projectName : `${projectName} ${index}`;
}

type TerminalSessionCloseAction = "none" | "close-panel" | "close-session";

interface TerminalSessionExitResult {
  state: TerminalPanelState;
  action: TerminalSessionCloseAction;
}

/**
 * 手动关闭终端 tab（× 按钮）：任何情况下都是真关闭——删除 session，workspace
 * 里最后一个 tab 关闭时连 workspace 记录一并删除。PTY 由 TerminalSession 卸载
 * 清理 dispose，持久化随之消失，刷新后不会再恢复该会话。
 * 与 PTY 自然退出（exitTerminalSession）的「真删」语义对齐；「只收起面板并保活」
 * 仅属于右上角的面板收起按钮。
 */
export function closeTerminalSession(
  state: TerminalPanelState,
  sessionId: string,
): TerminalPanelState {
  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace?.sessionIds.includes(sessionId)) {
    return state;
  }

  const closingIndex = workspace.sessionIds.indexOf(sessionId);
  const nextSessionIds = workspace.sessionIds.filter((id) => id !== sessionId);
  const { [sessionId]: _closedSession, ...nextSessions } = state.sessions;

  if (!nextSessionIds.length) {
    const { [session.workspaceKey]: _closedWorkspace, ...nextWorkspaces } = state.workspaces;
    return { sessions: nextSessions, workspaces: nextWorkspaces };
  }

  // nextSessionIds 非空由上方守卫保证；取首项兜底类型收窄。
  const fallbackSessionId = (nextSessionIds[Math.max(0, closingIndex - 1)] ??
    nextSessionIds[0]) as string;
  return {
    sessions: nextSessions,
    workspaces: {
      ...state.workspaces,
      [session.workspaceKey]: {
        sessionIds: nextSessionIds,
        activeSessionId:
          workspace.activeSessionId === sessionId ? fallbackSessionId : workspace.activeSessionId,
      },
    },
  };
}

export function exitTerminalSession(
  state: TerminalPanelState,
  sessionId: string,
  activeWorkspaceKey: string,
): TerminalSessionExitResult {
  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace?.sessionIds.includes(sessionId)) {
    return { state, action: "none" };
  }

  if (workspace.sessionIds.length > 1) {
    return {
      state: closeTerminalSession(state, sessionId),
      action: "close-session",
    };
  }

  // PTY 自身已经退出时，最后一个 tab 不能像手动关闭那样只收起面板并保活。
  // 这里同时删除 session/workspace 记录；重新打开该 workspace 时再由 ensure 懒创建新 PTY。
  const { [sessionId]: _exitedSession, ...nextSessions } = state.sessions;
  const { [session.workspaceKey]: _exitedWorkspace, ...nextWorkspaces } = state.workspaces;
  return {
    state: {
      sessions: nextSessions,
      workspaces: nextWorkspaces,
    },
    action: session.workspaceKey === activeWorkspaceKey ? "close-panel" : "close-session",
  };
}

export function ensureWorkspaceTerminalState(
  state: TerminalPanelState,
  params: {
    workspaceKey: string;
    services: IServiceAccessor;
    cwd?: string;
  },
): TerminalPanelState {
  const existingWorkspace = state.workspaces[params.workspaceKey];
  if (existingWorkspace?.sessionIds.some((sessionId) => state.sessions[sessionId])) {
    return state;
  }

  const { session, workspace } = createWorkspaceTerminalState(params);
  return {
    sessions: {
      ...state.sessions,
      [session.id]: session,
    },
    workspaces: {
      ...state.workspaces,
      [params.workspaceKey]: workspace,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  会话持久化：刷新/重开后按 workspace 恢复 tab 并重连服务端 PTY        */
/* ------------------------------------------------------------------ */

export interface PersistedTerminalSession {
  id: string;
  serverId?: string;
  index: number;
  cwd?: string;
  shellLabel?: string | null;
}

export interface PersistedTerminalWorkspace {
  activeSessionId: string;
  sessions: PersistedTerminalSession[];
}

const TERMINAL_SESSIONS_STORAGE_KEY = "zcode.web.terminal.sessions.v1";
const TERMINAL_SESSIONS_MAX_WORKSPACES = 20;

export function loadPersistedTerminalWorkspaces(): Record<string, PersistedTerminalWorkspace> {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(TERMINAL_SESSIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, PersistedTerminalWorkspace>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 从 localStorage 恢复指定 workspace 的终端 tab；没有可恢复内容时返回 null。 */
export function restoreWorkspaceTerminalState(params: {
  workspaceKey: string;
  services: IServiceAccessor;
  cwd?: string;
}): TerminalPanelState | null {
  const persisted = loadPersistedTerminalWorkspaces()[params.workspaceKey];
  if (!persisted?.sessions?.length) return null;

  const sessions: Record<string, TerminalSessionDescriptor> = {};
  const sessionIds: string[] = [];
  for (const entry of persisted.sessions) {
    if (!entry?.id || typeof entry.index !== "number") continue;
    sessions[entry.id] = {
      id: entry.id,
      workspaceKey: params.workspaceKey,
      services: params.services,
      cwd: entry.cwd ?? params.cwd,
      index: entry.index,
      shellLabel: entry.shellLabel ?? null,
      serverId: entry.serverId,
    };
    sessionIds.push(entry.id);
  }
  if (!sessionIds.length) return null;
  // 会话列表非空由上方守卫保证；取首项兜底 activeSessionId 的类型收窄。
  const firstSessionId = sessionIds[0] as string;

  const activeSessionId =
    persisted.activeSessionId && sessions[persisted.activeSessionId]
      ? persisted.activeSessionId
      : firstSessionId;

  return {
    sessions,
    workspaces: {
      [params.workspaceKey]: {
        sessionIds,
        activeSessionId,
      },
    },
  };
}

/** panelState 变化时调用：把会话描述符（含服务端 PTY id 映射）写入 localStorage。 */
export function persistTerminalPanelState(state: TerminalPanelState): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const payload: Record<string, PersistedTerminalWorkspace> = {};
    for (const [workspaceKey, workspace] of Object.entries(state.workspaces)) {
      const sessions = workspace.sessionIds
        .map((sessionId) => state.sessions[sessionId])
        .filter((session): session is TerminalSessionDescriptor => Boolean(session))
        .map((session) => ({
          id: session.id,
          // 只持久化已经拿到服务端 PTY id 的会话：空壳 session 重建后
          // 会自己 create 出新 PTY，记录它反而会在恢复时连到已死的 id。
          serverId: session.serverId,
          index: session.index,
          cwd: session.cwd,
          shellLabel: session.shellLabel,
        }));
      if (!sessions.length) continue;
      payload[workspaceKey] = {
        activeSessionId: workspace.activeSessionId,
        sessions,
      };
    }

    const workspaceKeys = Object.keys(payload).slice(-TERMINAL_SESSIONS_MAX_WORKSPACES);
    const trimmed: Record<string, PersistedTerminalWorkspace> = {};
    for (const key of workspaceKeys) {
      const entry = payload[key];
      if (entry) {
        trimmed[key] = entry;
      }
    }
    window.localStorage.setItem(TERMINAL_SESSIONS_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // 持久化失败只影响刷新恢复（配额/隐私模式等），不干扰终端运行。
  }
}
