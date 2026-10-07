const MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX = 96;

export type OpenTabLauncherItemId =
  | "selection-side-conversation"
  | "review"
  | "terminal"
  | "browser"
  | "developer-tools";

export function resolveOpenTabLauncherItemIds({
  developerToolsEnabled,
  hasReviewTab,
  canOpenSelectionSideConversation = false,
  supportsEmbeddedBrowser = true,
}: {
  developerToolsEnabled: boolean;
  hasReviewTab: boolean;
  canOpenSelectionSideConversation?: boolean;
  supportsEmbeddedBrowser?: boolean;
}): OpenTabLauncherItemId[] {
  const itemIds: OpenTabLauncherItemId[] = [];

  if (canOpenSelectionSideConversation) {
    itemIds.push("selection-side-conversation");
  }

  if (!hasReviewTab) {
    itemIds.push("review");
  }

  itemIds.push("terminal");

  if (supportsEmbeddedBrowser) {
    itemIds.push("browser");
  }

  if (developerToolsEnabled) {
    itemIds.push("developer-tools");
  }

  return itemIds;
}

export function shouldOfferSelectionSideConversation({
  activeTaskId,
}: {
  activeTaskId: string | null;
}): boolean {
  return Boolean(activeTaskId);
}

export function resolveAnimatedSidePanePanelLayout() {
  return {
    collapsedSize: "0px",
    defaultSize: "0px",
    // 上限从 65% 放宽到 100%：65% 时右侧面板没法占满主区域，
    // 也没法把聊天区完全折叠。聊天区能否被挤掉由 conversation-column 的 minSize 决定。
    maxSize: "100%",
    minSize: "240px",
    useResizablePanel: true,
  };
}

export function shouldRenderPreviewPaneHeavyContent({
  isActiveTab,
  isMediaPreview = false,
  isResizeSettling = false,
  isSidePaneVisible,
  minVisibleInlineSizePx = MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX,
  visibleInlineSizePx,
}: {
  isActiveTab: boolean;
  isMediaPreview?: boolean;
  isResizeSettling?: boolean;
  isSidePaneVisible: boolean;
  minVisibleInlineSizePx?: number;
  visibleInlineSizePx: number | null;
}) {
  if (!isSidePaneVisible || !isActiveTab) {
    return false;
  }

  if (isResizeSettling) {
    // 原生 video/audio 进入 HTML fullscreen 时会触发 resize；如果此时卸载
    // 媒体节点，浏览器会因 fullscreen 元素消失而立即退出全屏。
    return isMediaPreview;
  }

  if (visibleInlineSizePx === null) {
    return true;
  }

  return visibleInlineSizePx >= minVisibleInlineSizePx;
}
