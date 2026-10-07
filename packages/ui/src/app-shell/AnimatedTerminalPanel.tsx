import { useCallback, useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { RefObject } from "react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import type { IServiceAccessor } from "@zcode/services";
import { Terminal } from "@/Terminal.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { cn } from "@/components/lib/utils.js";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable.js";

export function AnimatedTerminalPanel({
  services,
  workspaceAbsPath,
  workspaceIdentity,
  openWorkspaceKeys,
  isVisible,
  isWindowsDesktop,
  frameClassName = "rounded-xl border border-border",
  panelRef,
  panelElementRef,
  onClose,
  onOpenBrowserUrl,
  onResize,
}: {
  services: IServiceAccessor;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  openWorkspaceKeys?: string[];
  isVisible: boolean;
  isWindowsDesktop?: boolean;
  frameClassName?: string;
  panelRef: RefObject<PanelImperativeHandle | null>;
  panelElementRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onOpenBrowserUrl: (url: string) => void;
  /** 用户把面板拖到收起 / 从收起态拖出来时回调，用于把面板状态同步回 App。 */
  onResize?: (panelSize: PanelSize) => void;
}) {
  const [hasRenderedTerminal, setHasRenderedTerminal] = useState(isVisible);
  const [isTerminalPanelResizing, setIsTerminalPanelResizing] = useState(false);
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;

  const finishTerminalPanelResize = useCallback(() => {
    setIsTerminalPanelResizing(false);
  }, []);

  const handleTerminalPanelResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isVisible || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }

      // 终端面板拖拽时会产生连续 ResizeObserver 回调。
      // 显式标记拖拽窗口，让 TerminalSession 在拖拽中低频 resize，松手后再 flush 最终尺寸。
      setIsTerminalPanelResizing(true);
    },
    [isVisible],
  );

  useEffect(() => {
    if (isVisible) {
      // Terminal 首次展开前不应该提前创建会话，否则即使用户从未打开终端，
      // 也会白白创建 xterm 和后端 terminal 进程。这里改成首次展开后再渲染，
      // 后续收起只隐藏不卸载，这样既保留会话，又避免重复初始化。
      setHasRenderedTerminal(true);
    }
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) {
      setIsTerminalPanelResizing(false);
    }
  }, [isVisible]);

  useEffect(() => {
    if (!isTerminalPanelResizing) {
      return;
    }

    window.addEventListener("pointerup", finishTerminalPanelResize);
    window.addEventListener("pointercancel", finishTerminalPanelResize);
    window.addEventListener("blur", finishTerminalPanelResize);
    return () => {
      window.removeEventListener("pointerup", finishTerminalPanelResize);
      window.removeEventListener("pointercancel", finishTerminalPanelResize);
      window.removeEventListener("blur", finishTerminalPanelResize);
    };
  }, [finishTerminalPanelResize, isTerminalPanelResizing]);

  return (
    <>
      {/* 分隔条常驻：终端收起后它仍留在栏底，用户按住往上拖就能把终端拉出来，
          这正是 VS Code 的收起/恢复方式。之前按 isVisible 卸载分隔条，一旦拖到收起
          就没有任何可抓的热区，面板再也拉不回来。 */}
      <ResizableHandle
        data-workspace-terminal-resize-handle="true"
        className={cn(
          "aria-[orientation=horizontal]:h-1 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:mx-0 aria-[orientation=horizontal]:translate-y-0 aria-[orientation=horizontal]:[mask-image:none] aria-[orientation=horizontal]:[-webkit-mask-image:none] hover:bg-transparent data-[separator=hover]:bg-transparent data-[separator=active]:bg-transparent focus-visible:bg-transparent after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 after:opacity-0 after:transition-opacity after:content-[''] after:inset-x-[var(--workspace-panel-radius,var(--radius-xl))] after:h-0.5 hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100",
          isTerminalPanelResizing && "after:opacity-100",
        )}
        onPointerCancel={finishTerminalPanelResize}
        onPointerDown={handleTerminalPanelResizeStart}
        onPointerUp={finishTerminalPanelResize}
      />
      <ResizablePanel
        id="terminal"
        panelRef={panelRef}
        elementRef={panelElementRef}
        defaultSize="0px"
        minSize="140px"
        // 上限从 50% 放宽到 100%：上限卡在 50% 时，用户没法把聊天区完全折叠、
        // 让终端独占主区域。真正防止「拖到最小就自动收起」的是下面的 collapsible 语义。
        maxSize="100%"
        collapsedSize="0px"
        // 常驻 collapsible：拖到 minSize 以下会像 VS Code 一样吸附收起，
        // 收起后继续把分隔条往外拖就能重新拉出来（库内建的行为）。
        collapsible
        onResize={onResize}
        className={cn(
          "transition-opacity duration-200 ease-out",
          isVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div
          data-workspace-terminal-frame="true"
          className={cn("h-full overflow-hidden bg-background", frameClassName)}
        >
          {hasRenderedTerminal ? (
            <div aria-hidden={!isVisible} className="h-full">
              {/* terminal 首次展开前不渲染，避免无意义初始化；
                  首次展开后保持挂载，收起时只隐藏不卸载，这样下一次展开就能直接复用现有会话。 */}
              <ScopedErrorBoundary
                scope="workspace-terminal"
                resetKeys={[workspaceKey]}
                variant="panel"
                className="h-full"
              >
                <Terminal
                  services={services}
                  cwd={workspaceAbsPath}
                  workspaceIdentity={workspaceIdentity}
                  openWorkspaceKeys={openWorkspaceKeys}
                  isVisible={isVisible}
                  isPanelResizing={isTerminalPanelResizing}
                  isWindowsDesktop={isWindowsDesktop}
                  onClose={onClose}
                  onOpenBrowserUrl={onOpenBrowserUrl}
                />
              </ScopedErrorBoundary>
            </div>
          ) : null}
        </div>
      </ResizablePanel>
    </>
  );
}
