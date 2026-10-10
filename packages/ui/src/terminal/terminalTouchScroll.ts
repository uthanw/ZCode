/*
 * 移动端终端触摸手势兜底。
 *
 * xterm 内置的触摸滚动监听在 .xterm 元素上，靠 touchmove 里手动累加
 * .xterm-viewport.scrollTop；但 .xterm-viewport 是 .xterm-screen 的兄弟节点，
 * 真机浏览器的手势仲裁不会把滑动交给它，工作区根节点又是 overflow:hidden，
 * 结果滑动既滚不动终端、也不会传给任何祖先容器，表现成「滑动没有传递」。
 *
 * 这里在 document 捕获阶段按「单指垂直主导手势」接管，分两种模式：
 * - scrollback 可滚：1:1 跟手滚动回滚；
 * - 无回滚（TUI 的 alternate buffer / 内容不足一屏）：把垂直滑动转成
 *   上下方向键发给 PTY（Termux 的 TUI 手势语义），让 TUI 自己滚动。
 *
 * preventDefault 阻止祖先容器抢滚动，stopPropagation 让 xterm 内置触摸
 * 滚动退出，避免同一手势被滚两次；点按与横向手势完全放行，不影响 tap
 * 聚焦、右键菜单和 TUI 的触摸点击。配合 styles.css 里
 * .terminal-xterm-shell { touch-action: none }，手势仲裁从起手就不介入。
 */

import {
  acceptsMouseWheel,
  EXTRA_KEY_CODES,
  getTermForShell,
  sendXtermKey,
} from "@/terminal/terminalExtraKeys.js";

/** TUI 模式下每滑过多少像素发送一枚方向键/滚轮事件。 */
const TUI_ARROW_STEP_PX = 44;

let active = false;
let touchId = -1;
let startX = 0;
let startY = 0;
let startScrollTop = 0;
/** true = scrollback 滚动模式；false = TUI 方向键/滚轮模式。提交手势时判定。 */
let scrollMode = false;
/** TUI 模式下已按累计位移发出的方向键档位（带符号，负=上滑/向下翻）。 */
let tuiArrowsSent = 0;

const viewportOf = (target: EventTarget | null): HTMLElement | null => {
  return shellOf(target)?.querySelector<HTMLElement>(".xterm-viewport") ?? null;
};

const shellOf = (target: EventTarget | null): HTMLElement | null => {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(".terminal-xterm-shell");
};

const onTouchStart = (event: TouchEvent) => {
  if (event.touches.length !== 1) {
    active = false;
    return;
  }
  const touch = event.touches[0];
  if (!touch) {
    active = false;
    return;
  }
  const shell = shellOf(event.target);
  const viewport = viewportOf(event.target);
  if (!shell || !viewport) {
    active = false;
    return;
  }
  active = true;
  touchId = touch.identifier;
  startX = touch.clientX;
  startY = touch.clientY;
  startScrollTop = viewport.scrollTop;
  // 程序开着鼠标上报（TUI）时滚轮语义优先，即便有回滚也不本地滚动——
  // 与桌面端滚轮行为一致（桌面滚轮在 TUI 里走的是同一条鼠标协议路径）。
  const term = getTermForShell(shell);
  scrollMode = !(term && acceptsMouseWheel(term)) && viewport.scrollHeight > viewport.clientHeight;
  tuiArrowsSent = 0;
};

const onTouchMove = (event: TouchEvent) => {
  if (!active) return;
  if (event.touches.length !== 1) {
    active = false;
    return;
  }
  const touch = event.touches[0];
  if (!touch || touch.identifier !== touchId) {
    active = false;
    return;
  }
  const deltaY = touch.clientY - startY;
  const deltaX = touch.clientX - startX;
  // 未成形的手势或横向主导（选择文本等）不接管，保留原生行为。
  // touch-action:none 已让手势仲裁不介入，这里可以尽早提交。
  if (Math.abs(deltaY) < 2 || Math.abs(deltaY) <= Math.abs(deltaX)) return;
  if (scrollMode) {
    const viewport = viewportOf(event.target);
    if (!viewport) {
      active = false;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    viewport.scrollTop = startScrollTop - deltaY;
    return;
  }

  // TUI 模式：以滑动起点为原点折算，每 TUI_ARROW_STEP_PX 一枚，回滑发反向
  // 事件（同拖动滚动条的语义）。手指上滑（dy<0）= 看到更新的内容 = 滚轮
  // 向下 / 方向键「下」。
  const shell = shellOf(event.target);
  if (!shell) {
    active = false;
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const totalSteps = Math.trunc(-deltaY / TUI_ARROW_STEP_PX);
  if (totalSteps === tuiArrowsSent) return;
  const pending = totalSteps - tuiArrowsSent;
  const term = getTermForShell(shell);
  if (term && acceptsMouseWheel(term)) {
    // SGR 滚轮事件：与桌面滚轮同一条协议路径，TUI 里语义无损。
    const rect = shell.getBoundingClientRect();
    const cols = Math.max(1, term.cols);
    const rows = Math.max(1, term.rows);
    const cx = Math.min(
      cols,
      Math.max(1, Math.ceil(((touch.clientX - rect.left) / rect.width) * cols)),
    );
    const cy = Math.min(
      rows,
      Math.max(1, Math.ceil(((touch.clientY - rect.top) / rect.height) * rows)),
    );
    const button = pending > 0 ? 65 : 64;
    for (let i = 0; i < Math.abs(pending); i += 1) {
      term.input(`\x1b[<${button};${cx};${cy}M`);
    }
  } else {
    const key = pending > 0 ? EXTRA_KEY_CODES.arrowDown : EXTRA_KEY_CODES.arrowUp;
    for (let i = 0; i < Math.abs(pending); i += 1) {
      sendXtermKey(shell, key);
    }
  }
  tuiArrowsSent = totalSteps;
};

const onTouchEnd = () => {
  active = false;
  touchId = -1;
};

function attach(doc: Document): () => void {
  doc.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  doc.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  doc.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  doc.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });

  return () => {
    doc.removeEventListener("touchstart", onTouchStart, { capture: true });
    doc.removeEventListener("touchmove", onTouchMove, { capture: true });
    doc.removeEventListener("touchend", onTouchEnd, { capture: true });
    doc.removeEventListener("touchcancel", onTouchEnd, { capture: true });
  };
}

/*
 * 多个终端 tab 会同时挂载 TerminalSession，这里按引用计数共享同一组
 * document 级监听：首个挂载安装，最后一个卸载才移除。
 */
let refCount = 0;
let detach: (() => void) | null = null;

export function installTerminalTouchScroll(doc: Document = document): () => void {
  if (typeof window === "undefined") return () => {};

  refCount += 1;
  if (!detach) detach = attach(doc);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount -= 1;
    if (refCount <= 0 && detach) {
      detach();
      detach = null;
      refCount = 0;
    }
  };
}
