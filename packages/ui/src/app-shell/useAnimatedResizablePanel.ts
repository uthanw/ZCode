import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

const PANEL_FLEX_GROW_TRANSITION_CLASSES = ["transition-[flex-grow]", "duration-200", "ease-out"];
const PANEL_FLEX_GROW_TRANSITION_FALLBACK_MS = 240;
// 记住展开尺寸时忽略接近 0 的百分比：拖到收起的那一帧 getSize() 会读到 0.x%，
// 若把它记成“上次展开尺寸”，用户下次点开关展开出来就是一条缝。
const PANEL_SIZE_REMEMBER_MIN_PERCENTAGE = 2;

function enablePanelFlexGrowTransition(panelElement: HTMLElement): () => void {
  panelElement.classList.add(...PANEL_FLEX_GROW_TRANSITION_CLASSES);

  let finished = false;
  let fallbackTimer = 0;

  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    panelElement.removeEventListener("transitionend", handleTransitionEnd);
    if (fallbackTimer) {
      window.clearTimeout(fallbackTimer);
    }
    panelElement.classList.remove(...PANEL_FLEX_GROW_TRANSITION_CLASSES);
  };

  const handleTransitionEnd = (event: TransitionEvent) => {
    if (event.target === panelElement && event.propertyName === "flex-grow") {
      finish();
    }
  };

  panelElement.addEventListener("transitionend", handleTransitionEnd);
  fallbackTimer = window.setTimeout(finish, PANEL_FLEX_GROW_TRANSITION_FALLBACK_MS);

  return finish;
}

export function useAnimatedResizablePanel({
  open,
  alwaysMounted = false,
  expandedSize,
  rememberExpandedSize = false,
  resizeOnInitialVisibleMount = true,
  onUserCollapseChange,
}: {
  open: boolean;
  alwaysMounted?: boolean;
  expandedSize?: string;
  rememberExpandedSize?: boolean;
  resizeOnInitialVisibleMount?: boolean;
  /**
   * 用户把面板拖到收起、或从收起态拖出来时回调。
   *
   * 库没有 onCollapse/onExpand，只能在 onResize 里用 isCollapsed() 反推；
   * 而程序化收起（点开关、窗口 resize 触发自动收起、切视图）同样会走 onResize，
   * 所以这里用“指针是否按在 PanelGroup 内”把用户拖拽和程序化变更分开，只同步前者。
   */
  onUserCollapseChange?: (collapsed: boolean) => void;
}) {
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const panelElementRef = useRef<HTMLDivElement | null>(null);
  const expandedSizeRef = useRef(expandedSize);
  const hasHandledVisibilityRef = useRef(false);
  const [isVisible, setIsVisible] = useState(open);
  const openRef = useRef(open);
  openRef.current = open;
  const onUserCollapseChangeRef = useRef(onUserCollapseChange);
  onUserCollapseChangeRef.current = onUserCollapseChange;
  // 拖拽中标记：pointerup 之后再放两帧，让拖拽最后一拍产生的 ResizeObserver
  // 回调仍被判定成“用户拖拽”，否则松手瞬间的收起/展开会漏同步。
  const isPointerDownOnGroupRef = useRef(false);
  const pointerUpFrameRef = useRef(0);

  useEffect(() => {
    const resolveGroupElement = () => panelElementRef.current?.parentElement ?? null;

    const handlePointerDown = (event: PointerEvent) => {
      const groupElement = resolveGroupElement();
      if (!groupElement || !(event.target instanceof Node) || !groupElement.contains(event.target)) {
        return;
      }
      if (pointerUpFrameRef.current) {
        window.cancelAnimationFrame(pointerUpFrameRef.current);
        pointerUpFrameRef.current = 0;
      }
      isPointerDownOnGroupRef.current = true;
    };

    const handlePointerUp = () => {
      if (pointerUpFrameRef.current) {
        window.cancelAnimationFrame(pointerUpFrameRef.current);
      }
      pointerUpFrameRef.current = window.requestAnimationFrame(() => {
        pointerUpFrameRef.current = window.requestAnimationFrame(() => {
          pointerUpFrameRef.current = 0;
          isPointerDownOnGroupRef.current = false;
        });
      });
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerUp, true);
    return () => {
      if (pointerUpFrameRef.current) {
        window.cancelAnimationFrame(pointerUpFrameRef.current);
        pointerUpFrameRef.current = 0;
      }
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerUp, true);
    };
  }, []);

  const handlePanelResize = useCallback(() => {
    if (!isPointerDownOnGroupRef.current) {
      return;
    }
    const collapsed = panelRef.current?.isCollapsed() ?? false;
    if (collapsed === !openRef.current) {
      return;
    }
    onUserCollapseChangeRef.current?.(collapsed);
  }, []);

  useEffect(() => {
    expandedSizeRef.current = expandedSize;
  }, [expandedSize]);

  useEffect(() => {
    if (alwaysMounted) {
      setIsVisible(open);
      return;
    }

    if (open) {
      // 条件渲染的 Panel 如果一挂载就直接处于展开态，首帧会直接跳到目标尺寸。
      // 这里先让常驻 Panel 保持折叠态，再在下一帧切到展开态，打开和关闭就能复用同一套过渡。
      const rafId = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }

    setIsVisible(false);
  }, [alwaysMounted, open]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const panelElement = panelElementRef.current;

    if (!hasHandledVisibilityRef.current) {
      hasHandledVisibilityRef.current = true;
      if (isVisible && !resizeOnInitialVisibleMount) {
        // sidebar 的 PanelGroup 已通过 layoutId 持久化宽度。
        // 首次可见挂载时如果这里再 resize 到默认值，会覆盖用户上次拖拽保存的宽度。
        return;
      }
    }

    // 之前把 flex-grow transition 常驻在 data-panel 上，窗口原生缩放时
    // react-resizable-panels 的 ResizeObserver 会看到一串动画中间尺寸，进而触发大量
    // layout store 更新和 React commit。这里只在显式展开/收起面板时短暂启用尺寸过渡，
    // 避免普通窗口 resize 被动画链路放大。
    const cleanupTransition = panelElement
      ? enablePanelFlexGrowTransition(panelElement)
      : undefined;

    // Panel 首次挂载时，react-resizable-panels 会在内部 effect 里注册约束。
    // 如果我们同一拍就立刻调用 collapse/expand，偶发会早于约束注册完成，触发
    // “Panel constraints not found” 崩溃。这里延后一帧，确保面板先完成注册再执行动画命令。
    const rafId = window.requestAnimationFrame(() => {
      if (isVisible) {
        // 面板可能已经被用户从边缘直接拖出来了。这种情况下尺寸是用户当下的选择，
        // 再 resize 到记住的百分比会把刚拖出的宽度顶回去；只在确实处于 collapsed 时才展开。
        if (!panel.isCollapsed()) {
          return;
        }
        const nextExpandedSize = expandedSizeRef.current;
        if (nextExpandedSize) {
          panel.resize(nextExpandedSize);
          return;
        }
        panel.expand();
        return;
      }
      if (rememberExpandedSize) {
        const currentSize = panel.getSize().asPercentage;
        if (
          Number.isFinite(currentSize) &&
          currentSize >= PANEL_SIZE_REMEMBER_MIN_PERCENTAGE
        ) {
          expandedSizeRef.current = `${currentSize}%`;
        }
      }
      panel.collapse();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      cleanupTransition?.();
    };
  }, [isVisible, rememberExpandedSize, resizeOnInitialVisibleMount]);

  return {
    panelRef,
    panelElementRef,
    isVisible,
    handlePanelResize,
  };
}
