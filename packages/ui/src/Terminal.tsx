import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { TID_TERMINAL, TID_TERMINAL_CLOSE_BUTTON } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { logger } from "@/logger.js";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs.js";
import { TerminalExtraKeysBar } from "@/terminal/TerminalExtraKeysBar.js";
import { getPathLeaf } from "@/lib/path.js";
import { TerminalTabTrigger } from "@/terminal/TerminalTabTrigger.js";
import { TerminalSession } from "@/terminal/TerminalSession.js";
import {
  closeTerminalSession,
  createTerminalSession,
  createWorkspaceTerminalState,
  ensureWorkspaceTerminalState,
  exitTerminalSession,
  formatTerminalTabTitle,
  getNextTerminalSessionIndex,
  getTerminalSessionCloseAction,
  persistTerminalPanelState,
  restoreWorkspaceTerminalState,
  type TerminalPanelState,
  type TerminalSessionDescriptor,
} from "@/terminal/terminalPanelState.js";

export function Terminal({
  services,
  cwd,
  workspaceIdentity,
  openWorkspaceKeys,
  isVisible,
  isPanelResizing = false,
  isWindowsDesktop = false,
  onClose,
  onOpenBrowserUrl,
}: {
  services: IServiceAccessor;
  cwd?: string;
  workspaceIdentity?: string;
  openWorkspaceKeys?: string[];
  isVisible: boolean;
  isPanelResizing?: boolean;
  isWindowsDesktop?: boolean;
  onClose: () => void;
  onOpenBrowserUrl: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const workspaceKey = workspaceIdentity?.trim() || cwd || "__default__";
  const [panelState, setPanelState] = useState<TerminalPanelState>(() => {
    const { session, workspace } = createWorkspaceTerminalState({
      workspaceKey,
      services,
      cwd,
    });
    return {
      sessions: {
        [session.id]: session,
      },
      workspaces: {
        [workspaceKey]: workspace,
      },
    };
  });
  const closePanelAfterExitWorkspaceRef = useRef<string | null>(null);
  const terminalSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    // 业务逻辑：终端会话按 workspace identity 隔离保存，切换 workspace 时只切换可见 tab，
    // 不卸载旧 workspace 的 xterm/PTY，避免长时间运行的命令因为 React 生命周期变化被杀掉。
    // PTY exit 会删除最后一个 session；面板下次重新打开时也通过这里懒创建新终端。
    // 刷新页面时先尝试按 localStorage 恢复会话（PTY 在客户端断开后仍存活于服务端），
    // 恢复出的 session 带 serverId，TerminalSession 会重连而不是新建。
    setPanelState((current) => {
      // 刷新恢复：localStorage 里的 session 带 serverId 说明服务端 PTY 还活着。
      // 当前 state 里同一 workspace 的 session 都没 serverId（本次刚建的空壳）时，
      // 直接用恢复出的会话整组替换，避免同一个 workspace 同时存在两批 tab。
      const currentWorkspace = current.workspaces[workspaceKey];
      const currentHasLive = Boolean(
        currentWorkspace &&
          currentWorkspace.sessionIds.some((id) => Boolean(current.sessions[id]?.serverId)),
      );

      const restored = restoreWorkspaceTerminalState({ workspaceKey, services, cwd });
      const restoredWorkspace = restored?.workspaces[workspaceKey];
      const restoredHasLive = Boolean(
        restored && Object.values(restored.sessions).some((session) => Boolean(session.serverId)),
      );

      if (restored && restoredWorkspace && restoredHasLive && !currentHasLive) {
        // 恢复出的会话整组替换当前空壳会话。必须把被替换掉的空壳 session 从
        // sessions 表里删掉：TabsContent 是 forceMount 的，只从 sessionIds 摘除
        // 不会让它们卸载，刚 create 出来的 PTY 会变成隐藏孤儿进程。
        const restoredIds = new Set(restoredWorkspace.sessionIds);
        const prunedSessions: Record<string, TerminalSessionDescriptor> = {};
        for (const [id, session] of Object.entries(current.sessions)) {
          if (session.workspaceKey !== workspaceKey || restoredIds.has(id)) {
            prunedSessions[id] = session;
          }
        }
        return {
          sessions: {
            ...prunedSessions,
            ...restored.sessions,
          },
          workspaces: {
            ...current.workspaces,
            [workspaceKey]: restoredWorkspace,
          },
        };
      }

      return ensureWorkspaceTerminalState(current, {
        workspaceKey,
        services,
        cwd,
      });
    });
  }, [cwd, isVisible, services, workspaceKey]);

  useEffect(() => {
    // 终端会话状态（含服务端 PTY id 映射）持久化到 localStorage：
    // 刷新/重开页面后按 workspace 恢复 tab 列表并重连同一个 PTY。
    persistTerminalPanelState(panelState);
  }, [panelState]);

  useEffect(() => {
    const exitedWorkspaceKey = closePanelAfterExitWorkspaceRef.current;
    if (!exitedWorkspaceKey) {
      return;
    }

    closePanelAfterExitWorkspaceRef.current = null;
    if (exitedWorkspaceKey === workspaceKey) {
      onClose();
    }
  }, [onClose, panelState, workspaceKey]);

  useEffect(() => {
    if (!openWorkspaceKeys) {
      return;
    }

    // 终端现在会跨 workspace 切换保活，但 workspace tab 被真正关闭后，
    // 对应的隐藏终端不能继续占着 PTY 进程；这里按仍打开的 workspace key 做回收。
    const retainedWorkspaceKeys = new Set(openWorkspaceKeys);
    retainedWorkspaceKeys.add(workspaceKey);
    setPanelState((current) => {
      const removedWorkspaceKeys = Object.keys(current.workspaces).filter(
        (key) => !retainedWorkspaceKeys.has(key),
      );
      if (removedWorkspaceKeys.length === 0) {
        return current;
      }

      const nextWorkspaces = { ...current.workspaces };
      const nextSessions = { ...current.sessions };
      for (const removedWorkspaceKey of removedWorkspaceKeys) {
        const workspace = nextWorkspaces[removedWorkspaceKey];
        delete nextWorkspaces[removedWorkspaceKey];
        for (const sessionId of workspace?.sessionIds ?? []) {
          delete nextSessions[sessionId];
        }
      }

      return {
        sessions: nextSessions,
        workspaces: nextWorkspaces,
      };
    });
  }, [openWorkspaceKeys, workspaceKey]);

  const handleShellLabelChange = useCallback((sessionId: string, shellLabel: string | null) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      if (!session || session.shellLabel === shellLabel) {
        return current;
      }

      return {
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...session,
            shellLabel,
          },
        },
      };
    });
  }, []);

  const handleCreateSession = useCallback(() => {
    setPanelState((current) => {
      const ensured = ensureWorkspaceTerminalState(current, {
        workspaceKey,
        services,
        cwd,
      });
      const workspace = ensured.workspaces[workspaceKey];
      if (!workspace) {
        return ensured;
      }

      const session = createTerminalSession({
        workspaceKey,
        services,
        cwd,
        index: getNextTerminalSessionIndex(ensured, workspaceKey),
      });
      logger.info("[Terminal] create terminal tab", {
        cwd,
        terminalTabId: session.id,
        workspaceKey,
      });

      return {
        sessions: {
          ...ensured.sessions,
          [session.id]: session,
        },
        workspaces: {
          ...ensured.workspaces,
          [workspaceKey]: {
            sessionIds: [...workspace.sessionIds, session.id],
            activeSessionId: session.id,
          },
        },
      };
    });
  }, [cwd, services, workspaceKey]);

  const handleCloseSession = useCallback(
    (sessionId: string) => {
      const closeAction = getTerminalSessionCloseAction(panelState, sessionId);
      if (closeAction === "close-panel") {
        // 旧 UI 在只剩一个 tab 时直接隐藏关闭按钮，用户无法从 tab 完成关闭。
        // 最后一个 tab 的关闭语义是收起整个面板并保活 session，与右上角关闭面板按钮保持一致。
        logger.info("[Terminal] close terminal panel from last tab", {
          terminalTabId: sessionId,
          workspaceKey,
        });
        onClose();
        return;
      }

      if (closeAction !== "close-session") {
        return;
      }

      setPanelState((current) => {
        const session = current.sessions[sessionId];
        const next = closeTerminalSession(current, sessionId);
        if (!session || next === current) {
          return current;
        }

        logger.info("[Terminal] close terminal tab", {
          terminalTabId: sessionId,
          workspaceKey: session.workspaceKey,
        });
        return next;
      });
    },
    [onClose, panelState, workspaceKey],
  );

  const handleSessionExit = useCallback(
    (sessionId: string, exitCode: number) => {
      setPanelState((current) => {
        const exitedWorkspaceKey = current.sessions[sessionId]?.workspaceKey;
        const result = exitTerminalSession(current, sessionId, workspaceKey);
        if (result.action === "none") {
          return current;
        }

        // 不能只在 xterm 中写“进程已退出”、让 descriptor 留在 tab registry。
        // PTY exit 是 session 生命周期终点，必须同步删除 tab；只有当前 workspace 的最后一个 tab 才关闭面板。
        logger.info("[Terminal] auto close exited terminal tab", {
          action: result.action,
          exitCode,
          terminalTabId: sessionId,
          workspaceKey: exitedWorkspaceKey,
        });
        if (result.action === "close-panel") {
          closePanelAfterExitWorkspaceRef.current = exitedWorkspaceKey ?? null;
        }
        return result.state;
      });
    },
    [workspaceKey],
  );

  const handleActivateSession = useCallback((sessionId: string) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      if (!session) {
        return current;
      }

      const workspace = current.workspaces[session.workspaceKey];
      if (!workspace || workspace.activeSessionId === sessionId) {
        return current;
      }

      return {
        ...current,
        workspaces: {
          ...current.workspaces,
          [session.workspaceKey]: {
            ...workspace,
            activeSessionId: sessionId,
          },
        },
      };
    });
  }, []);

  // 拿到（新建或重连成功的）服务端 PTY id 后写入 descriptor，
  // 随后 persist effect 落 localStorage，刷新页面时才能重连同一个 PTY。
  const handleServerIdAcquired = useCallback((sessionId: string, serverId: string) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      if (!session || session.serverId === serverId) {
        return current;
      }
      return {
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: { ...session, serverId },
        },
      };
    });
  }, []);

  const workspace = panelState.workspaces[workspaceKey];
  const currentSessions =
    workspace?.sessionIds
      .map((sessionId) => panelState.sessions[sessionId])
      .filter((session): session is TerminalSessionDescriptor => Boolean(session)) ?? [];
  const activeSession =
    currentSessions.find((session) => session.id === workspace?.activeSessionId) ??
    currentSessions[0] ??
    null;
  const allSessions = Object.values(panelState.sessions);

  // 修复说明：关闭面板只收起 UI，不 dispose tab。真正关闭某个终端由 tab 上的关闭按钮负责，
  // 这样 workspace/task 切换或面板收起都不会中断正在运行的命令。
  return (
    <section
      ref={terminalSectionRef}
      data-testid={TID_TERMINAL}
      className="flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-background p-3 pb-2"
    >
      <Tabs
        value={activeSession?.id ?? ""}
        onValueChange={handleActivateSession}
        className="h-full min-h-0 gap-2"
      >
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <div className="truncate text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "terminal.title" })}
            </div>
            {activeSession?.shellLabel ? (
              <div className="shrink-0 text-ui-base text-foreground-subtle">
                {activeSession.shellLabel}
              </div>
            ) : null}
          </div>

          <div className="min-w-0 flex-1 overflow-x-auto !scrollbar-hide">
            <TabsList className="flex !h-7 w-max justify-start gap-1 rounded-none bg-transparent p-0">
              {currentSessions.map((session) => {
                const projectName =
                  getPathLeaf(session.cwd ?? "") || intl.formatMessage({ id: "terminal.title" });
                const title = formatTerminalTabTitle(projectName, session.index);
                return (
                  <TerminalTabTrigger
                    key={session.id}
                    session={session}
                    title={title}
                    closeLabel={intl.formatMessage({ id: "terminal.closeTab" }, { title })}
                    isActive={session.id === activeSession?.id}
                    onClose={handleCloseSession}
                  />
                );
              })}
            </TabsList>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {!isOfficeMode && (
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                onClick={handleCreateSession}
                title={intl.formatMessage({ id: "terminal.new" })}
                aria-label={intl.formatMessage({ id: "terminal.new" })}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
            <Button
              type="button"
              size="icon-md"
              variant="ghost"
              onClick={onClose}
              data-testid={TID_TERMINAL_CLOSE_BUTTON}
              title={intl.formatMessage({ id: "terminal.close" })}
              aria-label={intl.formatMessage({ id: "terminal.close" })}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {allSessions.map((session) => (
            <TabsContent
              key={session.id}
              value={session.id}
              forceMount
              className="h-full min-h-0 flex-1 data-[state=inactive]:hidden"
            >
              <TerminalSession
                sessionId={session.id}
                services={session.services}
                cwd={session.cwd}
                resumeServerId={session.serverId}
                onServerIdAcquired={handleServerIdAcquired}
                isVisible={
                  isVisible &&
                  session.workspaceKey === workspaceKey &&
                  session.id === activeSession?.id
                }
                isPanelResizing={isPanelResizing}
                isWindowsDesktop={isWindowsDesktop}
                onShellLabelChange={handleShellLabelChange}
                onExit={handleSessionExit}
                onOpenBrowserUrl={onOpenBrowserUrl}
              />
            </TabsContent>
          ))}
        </div>
      </Tabs>

      {/* 小屏/触屏时的 Termux 式补全按键栏（软键盘没有 Esc/Ctrl/方向键） */}
      <TerminalExtraKeysBar getContainer={() => terminalSectionRef.current} />
    </section>
  );
}
