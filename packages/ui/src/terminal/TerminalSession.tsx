/* eslint-disable max-lines -- persistentKey 常驻与普通 effect 两条生命周期路径的差异（registry entry、恢复回放、cleanup 归属）必须与 resize 调度放在同一组件内对照维护，共享装配已下沉 terminalSessionWiring。 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { ClipboardPaste, Copy } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import type { ITheme, IWindowsPty } from "@xterm/xterm";
import type { IServiceAccessor } from "@zcode/services";
import type { IDisposable } from "@zcode/rpc";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { installTerminalTouchScroll } from "@/terminal/terminalTouchScroll.js";
import {
  applyTerminalProfile,
  attachTerminalKeyHandler,
  createTerminalInputFallbackState,
  fitTerminalForCreate,
  observeTerminalResize,
  observeTerminalTheme,
  openTerminalInstance,
  registerTerminalHttpLinkProvider,
  tryFitTerminal,
  wireTerminalProcessing,
  type TerminalInputFallbackState,
  type TerminalResizeRequestStats,
  type TerminalSize,
} from "@/terminal/terminalSessionWiring.js";
import { normalizePowerShellReadlineRedraw } from "@/terminal/terminalDataTransform.js";
import {
  sidePaneTerminalSessionRegistry,
  type SidePaneTerminalSessionEntry,
} from "@/terminal/sidePaneTerminalSessionRegistry.js";

const TERMINAL_RESIZE_DRAG_THROTTLE_MS = 300;

type TerminalResizeReason = "drag" | "final" | "visible" | "init" | "observer";

export function TerminalSession({
  sessionId,
  services,
  cwd,
  isVisible,
  isPanelResizing = false,
  isWindowsDesktop = false,
  onShellLabelChange,
  onExit,
  onOpenBrowserUrl,
  persistentKey,
  workspaceKey,
  resumeServerId,
  onServerIdAcquired,
}: {
  sessionId: string;
  services: IServiceAccessor;
  cwd?: string;
  isVisible: boolean;
  isPanelResizing?: boolean;
  isWindowsDesktop?: boolean;
  onShellLabelChange: (sessionId: string, shellLabel: string | null) => void;
  onExit?: (sessionId: string, exitCode: number) => void;
  onOpenBrowserUrl: (url: string) => void;
  /**
   * 刷新恢复用：localStorage 里记录的服务端 PTY id。传入时先 has() 探活，
   * 存活则订阅同一个 PTY 并回放服务端缓冲（长跑任务的输出不丢），
   * 不存活/探活失败则回退到新建，行为与首次打开一致。
   */
  resumeServerId?: string;
  /** 拿到（新建或重连成功的）服务端 PTY id 后回调，供面板状态持久化。 */
  onServerIdAcquired?: (sessionId: string, serverId: string) => void;
  /**
   * 跨组件生命周期的会话复用 key（仅 side pane terminal 用）。
   * 传入后 xterm 实例 + PTY 所有权上移到 sidePaneTerminalSessionRegistry 模块级单例，
   * 组件卸载只 detach DOM、不 dispose；重挂按 key 复用，scrollback 历史跨 workspace 保活。
   * 不传（下侧 terminal）走原 effect 路径。
   */
  persistentKey?: string;
  /**
   * workspace 身份隔离 key（= workspaceIdentity?.trim() || workspacePath）。
   * 仅 persistentKey 路径用：写入 registry entry.workspaceKey，
   * 供 workspace tab 真正关闭时按 workspaceKey 批量回收 PTY（对称下侧 openWorkspaceKeys 回收）。
   * 不传时 fallback 到 cwd。下侧 terminal 不传 persistentKey，此值不生效。
   */
  workspaceKey?: string;
}) {
  const { intl } = useZCodeIntl();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | undefined>(undefined);
  const isVisibleRef = useRef(isVisible);
  const resizeRAFRef = useRef(0);
  const resizeThrottleTimerRef = useRef<number | null>(null);
  const isPanelResizingRef = useRef(isPanelResizing);
  const resizeRequestStatsRef = useRef<TerminalResizeRequestStats>({
    fit: 0,
    queued: 0,
    sent: 0,
    skipped: 0,
  });
  const lastSentTerminalSizeRef = useRef<TerminalSize | null>(null);
  const pendingTerminalSizeRef = useRef<TerminalSize | null>(null);
  const resizeInFlightRef = useRef(false);
  const focusRAFRef = useRef(0);
  const exitedMessageRef = useRef("");
  const exitHandlerRef = useRef(onExit);
  const openBrowserUrlRef = useRef(onOpenBrowserUrl);
  // refresh 恢复目标只在挂载时定格：create 路径拿到 id 后 onServerIdAcquired 会把
  // resumeServerId 从 undefined 变成新 id，若进 effect deps 会触发整个 effect 重跑，
  // cleanup 会把刚创建的 PTY dispose 掉。挂载时读一次 ref 即可。
  const resumeServerIdRef = useRef(resumeServerId);
  const terminalProfileThemeRef = useRef<ITheme | undefined>(undefined);
  const inputFallbackStateRef = useRef<TerminalInputFallbackState>(
    createTerminalInputFallbackState(),
  );

  exitedMessageRef.current = intl.formatMessage({ id: "terminal.exited" });
  exitHandlerRef.current = onExit;
  openBrowserUrlRef.current = onOpenBrowserUrl;

  const flushTerminalServiceResize = useCallback(() => {
    if (resizeInFlightRef.current) {
      return;
    }

    const terminalId = terminalIdRef.current;
    const pendingSize = pendingTerminalSizeRef.current;
    if (!terminalId || !pendingSize) {
      return;
    }

    pendingTerminalSizeRef.current = null;
    resizeInFlightRef.current = true;
    resizeRequestStatsRef.current.sent += 1;

    const startedAt = performance.now();
    void services.terminalService
      .resize({
        id: terminalId,
        cols: pendingSize.cols,
        rows: pendingSize.rows,
      })
      .then(() => {
        logger.debug("[Terminal] resize sent", {
          cols: pendingSize.cols,
          durationMs: Math.round(performance.now() - startedAt),
          fitCount: resizeRequestStatsRef.current.fit,
          queuedCount: resizeRequestStatsRef.current.queued,
          rows: pendingSize.rows,
          sentCount: resizeRequestStatsRef.current.sent,
          skippedCount: resizeRequestStatsRef.current.skipped,
          terminalId,
          terminalTabId: sessionId,
        });
      })
      .catch((error) => {
        logger.warn("[Terminal] resize failed:", error);
      })
      .finally(() => {
        resizeInFlightRef.current = false;
        if (pendingTerminalSizeRef.current) {
          flushTerminalServiceResize();
        }
      });
  }, [services.terminalService, sessionId]);

  const queueTerminalServiceResize = useCallback(
    (size: TerminalSize) => {
      const lastSentSize = lastSentTerminalSizeRef.current;
      const pendingSize = pendingTerminalSizeRef.current;
      if (
        (lastSentSize?.cols === size.cols && lastSentSize.rows === size.rows && !pendingSize) ||
        (pendingSize?.cols === size.cols && pendingSize.rows === size.rows)
      ) {
        resizeRequestStatsRef.current.skipped += 1;
        return;
      }

      pendingTerminalSizeRef.current = size;
      lastSentTerminalSizeRef.current = size;
      resizeRequestStatsRef.current.queued += 1;
      flushTerminalServiceResize();
    },
    [flushTerminalServiceResize],
  );

  const clearResizeThrottleTimer = useCallback(() => {
    if (resizeThrottleTimerRef.current) {
      window.clearTimeout(resizeThrottleTimerRef.current);
      resizeThrottleTimerRef.current = null;
    }
  }, []);

  const requestFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (resizeRAFRef.current) {
        cancelAnimationFrame(resizeRAFRef.current);
      }

      resizeRAFRef.current = requestAnimationFrame(() => {
        resizeRAFRef.current = 0;
        const el = containerRef.current;
        const term = termRef.current;
        const fitAddon = fitAddonRef.current;
        if (
          !isVisibleRef.current ||
          !el ||
          !term ||
          !fitAddon ||
          el.clientWidth <= 0 ||
          el.clientHeight <= 0
        ) {
          return;
        }

        try {
          resizeRequestStatsRef.current.fit += 1;
          fitAddon.fit();
        } catch (error) {
          logger.warn("[Terminal] fit failed:", error);
          return;
        }

        logger.debug("[Terminal] fit requested resize", {
          cols: term.cols,
          reason,
          resizing: isPanelResizingRef.current,
          rows: term.rows,
          terminalId: terminalIdRef.current,
          terminalTabId: sessionId,
        });
        queueTerminalServiceResize({ cols: term.cols, rows: term.rows });
      });
    },
    [queueTerminalServiceResize, sessionId],
  );

  const scheduleFitAndResize = useCallback(
    (reason: TerminalResizeReason = "observer") => {
      if (!isPanelResizingRef.current || reason === "final") {
        clearResizeThrottleTimer();
        requestFitAndResize(reason);
        return;
      }

      if (resizeThrottleTimerRef.current) {
        return;
      }

      // 拖动终端高度时 ResizeObserver 会按布局帧连续触发。
      // xterm fit + PTY resize 是同步布局和跨进程请求组合，拖拽中只按常量低频预览，松手后再 flush 最终尺寸。
      resizeThrottleTimerRef.current = window.setTimeout(() => {
        resizeThrottleTimerRef.current = null;
        requestFitAndResize("drag");
      }, TERMINAL_RESIZE_DRAG_THROTTLE_MS);
    },
    [clearResizeThrottleTimer, requestFitAndResize],
  );

  const requestFocus = useCallback(() => {
    if (focusRAFRef.current) {
      cancelAnimationFrame(focusRAFRef.current);
    }

    focusRAFRef.current = requestAnimationFrame(() => {
      focusRAFRef.current = 0;
      const term = termRef.current;
      if (!isVisibleRef.current || !term) {
        return;
      }

      // 打开/新建/切换终端时 React 只更新了可见 tab，焦点仍停在按钮或输入框。
      // xterm 的 textarea 会在 open 后创建，所以要等下一帧确认当前 session 仍可见再聚焦。
      term.focus();
      logger.debug("[Terminal] focused visible terminal", {
        terminalId: terminalIdRef.current,
        terminalTabId: sessionId,
      });
    });
  }, [sessionId]);

  useEffect(() => {
    isVisibleRef.current = isVisible;
    if (isVisible) {
      scheduleFitAndResize("visible");
      requestFocus();
    }
  }, [isVisible, requestFocus, scheduleFitAndResize]);

  useEffect(() => {
    // 移动端触摸滚动兜底只需装一次（内部幂等去重）；工作区终端与 side pane
    // 终端都经本组件挂载，在这里统一接管。
    return installTerminalTouchScroll();
  }, []);

  useEffect(() => {
    const wasResizing = isPanelResizingRef.current;
    isPanelResizingRef.current = isPanelResizing;
    if (wasResizing && !isPanelResizing && isVisibleRef.current) {
      scheduleFitAndResize("final");
    }
  }, [isPanelResizing, scheduleFitAndResize]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const openUrl = (url: string) => openBrowserUrlRef.current(url);

    // ===== persistentKey 路径：side pane terminal 跨 workspace 会话保活 =====
    // xterm 实例 + PTY 所有权上移到 sidePaneTerminalSessionRegistry 模块级单例，
    // 组件卸载只 detach DOM、不 dispose；重挂按 persistentKey 复用，scrollback 跨 workspace 保活。
    // 与普通路径的差异全部集中在「资源生命周期」：装配逻辑（按键处理/订阅/IME 兜底）
    // 共享 terminalSessionWiring，订阅挂到 registryDisposers 随 entry 常驻。
    if (persistentKey) {
      terminalProfileThemeRef.current = undefined;
      const existingEntry = sidePaneTerminalSessionRegistry.get(persistentKey);

      // --- 复用快路径：切回 workspace / 重挂，entry 已在 registry ---
      if (existingEntry) {
        termRef.current = existingEntry.term;
        fitAddonRef.current = existingEntry.fitAddon;
        terminalIdRef.current = existingEntry.terminalId || undefined;
        el.appendChild(existingEntry.hostEl);
        // 从 entry.profileTheme 读：重挂后组件局部 ref 已重置为 undefined，
        // profile theme 只存在于 registry entry，必须从 entry 取（否则丢用户配置的终端颜色）。
        const reuseThemeObserver = observeTerminalTheme(
          existingEntry.term,
          () => existingEntry.profileTheme,
        );
        const reuseResizeObserver = observeTerminalResize(
          el,
          () => {
            scheduleFitAndResize("observer");
          },
          () => isVisibleRef.current,
        );
        tryFitTerminal(existingEntry.fitAddon, resizeRequestStatsRef, "persistent reuse");
        if (isVisibleRef.current) {
          requestFocus();
        }
        logger.debug("[Terminal] persistent reuse", {
          terminalTabId: sessionId,
          persistentKey,
        });
        return () => {
          reuseThemeObserver.dispose();
          reuseResizeObserver.dispose();
          sidePaneTerminalSessionRegistry.detachDom(persistentKey);
          // 不 dispose：term/PTY/订阅都留在 registry 供下次复用
          termRef.current = null;
          fitAddonRef.current = null;
        };
      }

      // --- 首次创建：常驻 hostEl，term open 到 hostEl，资源进 registry ---
      const hostEl = document.createElement("div");
      hostEl.className = "terminal-xterm-shell h-full min-h-0 w-full overflow-hidden";
      el.appendChild(hostEl);

      let ptyCancelled = false;
      const registryDisposers: IDisposable[] = [];
      const localDisposers: IDisposable[] = [];

      const { term, fitAddon } = openTerminalInstance(hostEl, openUrl);
      termRef.current = term;
      fitAddonRef.current = fitAddon;

      const initialTerminalSize = fitTerminalForCreate({
        term,
        fitAddon,
        host: hostEl,
        isVisible: () => isVisibleRef.current,
        stats: resizeRequestStatsRef,
        lastSentSize: lastSentTerminalSizeRef,
        sessionId,
        persistent: true,
      });
      if (isVisibleRef.current) {
        requestFocus();
      }

      attachTerminalKeyHandler(term, inputFallbackStateRef);
      // 从 entry.profileTheme 读：profile theme 所有权在 registry entry，跨重挂常驻；
      // 组件局部 terminalProfileThemeRef 在重挂后会丢失 profile theme，不能作为 observer 数据源。
      const themeObserver = observeTerminalTheme(term, () => entry.profileTheme);
      localDisposers.push(themeObserver);

      // 进 registry：linkProvider（detached 时保留无害）
      registryDisposers.push(registerTerminalHttpLinkProvider(term, openUrl));

      // entry 先占位存入 registry（terminalId 异步填），重挂/回收据此判断
      const entry: SidePaneTerminalSessionEntry = {
        key: persistentKey,
        term,
        fitAddon,
        terminalId: "",
        cwd: cwd ?? "",
        // workspaceKey 用于 workspace tab 真正关闭时按 workspace 批量回收（对称下侧 openWorkspaceKeys）。
        workspaceKey: workspaceKey ?? cwd ?? "",
        hostEl,
        dispose: () => {}, // 紧接着补全
      };
      entry.dispose = () => {
        ptyCancelled = true;
        for (const d of registryDisposers) {
          try {
            d.dispose();
          } catch (error) {
            logger.warn("[Terminal] persistent dispose disposer failed:", error);
          }
        }
        if (entry.terminalId) {
          void services.terminalService.dispose({ id: entry.terminalId });
        }
        try {
          term.dispose();
        } catch (error) {
          logger.warn("[Terminal] persistent term.dispose failed:", error);
        }
      };
      sidePaneTerminalSessionRegistry.register(persistentKey, entry);

      // 创建 PTY（异步）
      const initialCreateSize = initialTerminalSize ?? { cols: term.cols, rows: term.rows };
      void services.terminalService
        .create({ cols: initialCreateSize.cols, rows: initialCreateSize.rows, cwd })
        .then((result) => {
          if (ptyCancelled) {
            // cleanup 已发生：杀掉这个孤儿 PTY，不进 entry
            void services.terminalService.dispose({ id: result.id });
            return;
          }
          entry.terminalId = result.id;
          terminalIdRef.current = result.id;
          // id ready 后立即 flush 创建期间排队的 resize（pendingTerminalSizeRef）。
          // 否则 scheduleFitAndResize("init") 会因 pendingSize 去重跳过，PTY 停在错误 cols/rows。
          flushTerminalServiceResize();
          // profile theme 所有权上移到 registry entry，跨组件生命周期复用不丢
          // （原仅写组件局部 ref，重挂后新组件 ref=undefined → 复用 observer 用 undefined 合并 → 丢失）。
          entry.profileTheme = applyTerminalProfile(term, {
            profile: result,
            terminalId: result.id,
            sessionId,
            cwd,
            onShellLabelChange,
          });
          scheduleFitAndResize("init");
          if (isVisibleRef.current) {
            requestFocus();
          }

          // PTY 订阅装配（进 registryDisposers，随 entry 常驻）：detached 时 data 订阅
          // 仍累积 scrollback；onData/IME 兜底不随 detach 取消，重挂后输入交互照常。
          wireTerminalProcessing({
            term,
            service: services.terminalService,
            id: result.id,
            shell: result.shell,
            sessionId,
            isWindowsDesktop,
            disposables: registryDisposers,
            fallbackState: inputFallbackStateRef,
            getExitHandler: () => exitHandlerRef.current,
            getExitedMessage: () => exitedMessageRef.current,
            // 订阅随 entry 常驻：不检查单次 effect 的 ptyCancelled（detach 后变 true
            // 会让 IME 兜底永久失效）；release 时 entry.dispose 才是真生命周期终点。
            isTornDown: () => false,
          });
        })
        .catch((error) => {
          if (ptyCancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          logger.error("[Terminal] persistent create failed:", error);
          term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
          // PTY 创建失败必须释放 registry 中本次占位的 entry。
          // entry 在上方以 terminalId="" 占位先 register，再异步 terminalService.create()。
          // 若失败不释放，terminalId="" 的僵尸 entry 会留在 registry，重挂/切 workspace 时命中
          // 复用快路径，直接复用已启动失败的 xterm，且永不重新 terminalService.create()，
          // 该终端永久无法连接 PTY。
          //
          // ownership 校验（稳妥方案）：只有 registry 当前 entry 仍是本次创建的 entry 时才释放。
          // 极端时序：create reject 触发前，组件可能已卸载（cleanup 已 release 半成品，见下方 !entry.terminalId
          // 分支）并重挂、registry 已被新一次创建的 entry 覆盖。此时无脑 release 会误删新 entry。
          // 闭包 entry 引用比较 registry 当前值：每次创建都是新 entry 对象，引用比较天然区分代际。
          const currentEntry = sidePaneTerminalSessionRegistry.get(persistentKey);
          if (currentEntry === entry) {
            sidePaneTerminalSessionRegistry.release(persistentKey);
          }
        });

      // 组件局部：resize observer
      localDisposers.push(
        observeTerminalResize(
          el,
          () => {
            scheduleFitAndResize("observer");
          },
          () => isVisibleRef.current,
        ),
      );

      logger.debug("[Terminal] persistent create", {
        terminalTabId: sessionId,
        persistentKey,
      });

      return () => {
        ptyCancelled = true;
        for (const d of localDisposers) {
          try {
            d.dispose();
          } catch (error) {
            logger.warn("[Terminal] persistent cleanup local disposer failed:", error);
          }
        }
        // PTY 未就绪即被卸载（极少见）：回收半成品 entry，避免重挂复用到空 PTY
        if (!entry.terminalId) {
          sidePaneTerminalSessionRegistry.release(persistentKey);
        } else {
          sidePaneTerminalSessionRegistry.detachDom(persistentKey);
        }
        termRef.current = null;
        fitAddonRef.current = null;
      };
    }
    // ===== persistentKey 路径结束 =====

    let disposed = false;
    terminalProfileThemeRef.current = undefined;

    const { term, fitAddon } = openTerminalInstance(el, openUrl);
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const initialTerminalSize = fitTerminalForCreate({
      term,
      fitAddon,
      host: el,
      isVisible: () => isVisibleRef.current,
      stats: resizeRequestStatsRef,
      lastSentSize: lastSentTerminalSizeRef,
      sessionId,
      persistent: false,
    });
    if (isVisibleRef.current) {
      requestFocus();
    }

    attachTerminalKeyHandler(term, inputFallbackStateRef);
    const themeObserver = observeTerminalTheme(term, () => terminalProfileThemeRef.current);

    const disposables: IDisposable[] = [themeObserver];
    const { terminalService } = services;
    disposables.push(registerTerminalHttpLinkProvider(term, openUrl));

    // 优先使用 workspace 路径作为 terminal 工作目录，未设置时后端回退到 HOME
    const initialCreateSize = initialTerminalSize ?? { cols: term.cols, rows: term.rows };
    const attachTerminal = (
      result: {
        id: string;
        shell: string;
        fontFamily: string;
        fontSize?: number;
        theme?: ITheme;
        fontFamilySource?: string;
        windowsPty?: IWindowsPty;
      },
      replay: string,
      createdLocally = false,
    ): void => {
      const { id, shell } = result;
      if (disposed) {
        // 只回收本会话新建的 PTY；resume 分支的 PTY 属于刷新前页面，不能杀。
        if (createdLocally) {
          terminalService.dispose({ id });
        }
        return;
      }

      terminalIdRef.current = id;
      onServerIdAcquired?.(sessionId, id);
      // 首次 fit 或 ResizeObserver 可能早于 terminal id ready，先把 resize
      // 暂存在 pendingTerminalSizeRef；id ready 后必须主动 flush，否则相同尺寸会被去重逻辑跳过。
      flushTerminalServiceResize();
      terminalProfileThemeRef.current = applyTerminalProfile(term, {
        profile: result,
        terminalId: id,
        sessionId,
        cwd,
        onShellLabelChange,
      });
      if (replay) {
        // 刷新恢复：先整体回放服务端缓冲（含断连期间输出），再订阅实时流。
        term.write(normalizePowerShellReadlineRedraw(replay, shell));
      }
      scheduleFitAndResize("init");
      if (isVisibleRef.current) {
        requestFocus();
      }

      wireTerminalProcessing({
        term,
        service: terminalService,
        id,
        shell,
        sessionId,
        isWindowsDesktop,
        disposables,
        fallbackState: inputFallbackStateRef,
        getExitHandler: () => exitHandlerRef.current,
        getExitedMessage: () => exitedMessageRef.current,
        // IME 兜底的延迟 flush 前检查组件是否已卸载：disposed 后 textarea 即将随 term.dispose 销毁。
        isTornDown: () => disposed,
      });
    };

    // 刷新恢复：优先重连 localStorage 记录的服务端 PTY（服务端在客户端断连时按设计不回收 pty），
    // 存活则回放服务端缓冲并订阅同一个实例；探活失败（如 host 重启）回退全新 create。
    const resumeTargetId = resumeServerIdRef.current;
    const setupTerminal = async (): Promise<void> => {
      if (resumeTargetId) {
        try {
          const alive = await terminalService.has({ id: resumeTargetId });
          if (alive) {
            const [profile, replay] = await Promise.all([
              terminalService.inspect({ id: resumeTargetId }),
              terminalService.readScrollback({ id: resumeTargetId }),
            ]);
            if (profile && !disposed) {
              logger.info("[Terminal] resumed after refresh", {
                terminalId: resumeTargetId,
                terminalTabId: sessionId,
              });
              // PTY 存活但 create 于旧版本（无 scrollback 缓冲）时 replay 为空串，照常续接实时流。
              attachTerminal({ ...profile, id: resumeTargetId }, replay);
              return;
            }
          }
        } catch (error) {
          // 探活/回放失败不阻断：回退到新建，行为与首次打开一致。
          logger.warn("[Terminal] resume failed, falling back to create:", error);
        }
      }

      try {
        const created = await terminalService.create({
          cols: initialCreateSize.cols,
          rows: initialCreateSize.rows,
          cwd,
        });
        attachTerminal(created, "", true);
      } catch (error) {
        // 之前没有接住 create() 的拒绝态，终端启动失败会直接变成 Uncaught Promise。
        // 这里显式记录错误，并在终端区域提示用户，方便定位到底是 shell 还是 cwd 出了问题。
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[Terminal] failed to create terminal:", error);
        term.write(`\r\n[Terminal failed to start]\r\n${message}\r\n`);
      }
    };

    void setupTerminal();

    disposables.push(
      observeTerminalResize(
        el,
        () => {
          scheduleFitAndResize("observer");
        },
        () => isVisibleRef.current,
      ),
    );

    return () => {
      disposed = true;
      clearResizeThrottleTimer();
      if (resizeRAFRef.current) cancelAnimationFrame(resizeRAFRef.current);
      if (focusRAFRef.current) cancelAnimationFrame(focusRAFRef.current);
      inputFallbackStateRef.current = createTerminalInputFallbackState();
      pendingTerminalSizeRef.current = null;
      lastSentTerminalSizeRef.current = null;
      resizeInFlightRef.current = false;
      for (const d of disposables) d.dispose();
      if (terminalIdRef.current) {
        terminalService.dispose({ id: terminalIdRef.current });
      }
      terminalIdRef.current = undefined;
      fitAddonRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [
    clearResizeThrottleTimer,
    cwd,
    isWindowsDesktop,
    onShellLabelChange,
    requestFocus,
    scheduleFitAndResize,
    flushTerminalServiceResize,
    services,
    sessionId,
    persistentKey,
    // resumeServerId 刻意不进 deps：挂载时从 resumeServerIdRef 读取一次；
    // acquire 后 prop 从 undefined 变为新 id，进 deps 会让 effect 重跑并 dispose 刚建的 PTY。
    onServerIdAcquired,
  ]);

  const handleCopy = () => {
    const term = termRef.current;
    if (!term?.hasSelection()) return;
    void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
      logger.warn("[Terminal] copy via context menu failed:", err);
    });
  };

  const handlePaste = () => {
    const term = termRef.current;
    if (!term) return;
    navigator.clipboard
      .readText()
      .then((text) => text && term.paste(text))
      .catch((err) => logger.warn("[Terminal] paste via context menu failed:", err));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className="terminal-xterm-shell h-full min-h-0 w-full overflow-hidden"
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleCopy}>
          <Copy className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.copy" })}
        </ContextMenuItem>
        <ContextMenuItem onSelect={handlePaste}>
          <ClipboardPaste className="mr-2 h-4 w-4" />
          {intl.formatMessage({ id: "terminal.contextMenu.paste" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
