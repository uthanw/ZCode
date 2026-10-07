/*
 * Termux 式小屏补全按键的共享状态与按键注入工具。
 *
 * 三个消费方：
 * - TerminalExtraKeysBar（UI 按钮）：ESC/TAB/方向键/符号，粘滞 Ctrl 修饰；
 * - TerminalSession 的 attachCustomKeyEventHandler：粘滞 Ctrl 激活时，把下一个
 *   软键盘可打印键转成对应的 Ctrl 组合发给 PTY；
 * - terminalTouchScroll 的 TUI 模式：alternate buffer（无回滚）下垂直滑动
 *   转成上下方向键发给 TUI。
 *
 * 按键注入统一走「向 xterm 隐藏 textarea 派发合成 KeyboardEvent」：xterm 自己的
 * 键盘翻译层会处理 DECCKM（应用光标模式）等终端模式，比手写转义序列更可靠。
 */

type KeyInit = {
  key: string;
  keyCode: number;
  ctrlKey?: boolean;
};

let stickyCtrlActive = false;
const stickyCtrlListeners = new Set<(active: boolean) => void>();

export function setStickyCtrl(active: boolean): void {
  stickyCtrlActive = active;
  for (const listener of stickyCtrlListeners) listener(active);
}

export function isStickyCtrlActive(): boolean {
  return stickyCtrlActive;
}

/** 消费一次粘滞 Ctrl（仅应在实际发出 Ctrl 组合时调用）。 */
export function consumeStickyCtrl(): void {
  if (!stickyCtrlActive) return;
  stickyCtrlActive = false;
  for (const listener of stickyCtrlListeners) listener(false);
}

/** 订阅粘滞 Ctrl 状态变化（按键栏用镜像样式；软键盘路径消费后也能同步熄灭）。 */
export function onStickyCtrlChange(listener: (active: boolean) => void): () => void {
  stickyCtrlListeners.add(listener);
  return () => stickyCtrlListeners.delete(listener);
}

/**
 * onData 统一漏斗上的粘滞 Ctrl 变换：软键盘（Android 输入法走 composition /
 * insertText，key 是 Unidentified）不产生可拦截的 keydown，只有在这里才能兜住
 * 所有输入路径。整词上屏时 data 可能是多字符，只变换首个可打印 ASCII 字符、
 * 其余保留（"cd" → Ctrl+C + "d"）；控制序列与中文等非 ASCII 上屏不消费粘滞。
 */
export function applyStickyCtrlToInputData(data: string): string {
  if (!stickyCtrlActive || data.length === 0) return data;
  const code = data.charCodeAt(0);
  if (code < 32 || code > 126) return data;
  consumeStickyCtrl();
  return String.fromCharCode(code & 0x1f) + data.slice(1);
}

export function findXtermTextarea(container: Element | null | undefined): HTMLTextAreaElement | null {
  return container?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") ?? null;
}

/** 向 xterm 的隐藏 textarea 派发一对合成 keydown/keyup，让 xterm 键盘层完成翻译。 */
export function sendXtermKey(
  container: Element | null | undefined,
  { key, keyCode, ctrlKey = false }: KeyInit,
): boolean {
  const textarea = findXtermTextarea(container);
  if (!textarea) return false;
  const init: KeyboardEventInit = {
    key,
    code: key.length === 1 ? "" : key,
    keyCode,
    bubbles: true,
    cancelable: true,
    ctrlKey,
  };
  textarea.dispatchEvent(new KeyboardEvent("keydown", init));
  textarea.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
}

export const EXTRA_KEY_CODES = {
  escape: { key: "Escape", keyCode: 27 },
  tab: { key: "Tab", keyCode: 9 },
  arrowUp: { key: "ArrowUp", keyCode: 38 },
  arrowDown: { key: "ArrowDown", keyCode: 40 },
  arrowLeft: { key: "ArrowLeft", keyCode: 37 },
  arrowRight: { key: "ArrowRight", keyCode: 39 },
} as const;

/* ------------------------------------------------------------------ */
/*  鼠标上报模式跟踪 + shell → xterm 实例反查                           */
/* ------------------------------------------------------------------ */

import type { Terminal as XTerm } from "@xterm/xterm";

type TermBridge = {
  term: XTerm;
  /** 程序开启了任意鼠标按键上报（DECSET 1000/1002/1003）。 */
  mouseButtons: boolean;
  /** 程序要求 SGR 编码（DECSET 1006），滚轮事件才用 `\x1b[<b;x;yM`。 */
  sgr: boolean;
  /** 分块输出可能把转义序列劈开，保留一小段尾巴和下一块拼着扫。 */
  tail: string;
};

const termBridges = new WeakMap<XTerm, TermBridge>();
const termElementsByShell = new WeakMap<Element, XTerm>();

const DEC_PRIVATE_MODE = /\u001b\[\?(\d{3,4})(h|l)/g;

/** 在 PTY 输出路径上调用：跟踪程序开关鼠标上报的模式。 */
export function noteTerminalOutput(term: XTerm, chunk: string): void {
  let bridge = termBridges.get(term);
  if (!bridge) {
    bridge = { term, mouseButtons: false, sgr: false, tail: "" };
    termBridges.set(term, bridge);
  }
  if (term.element && termElementsByShell.get(term.element) !== term) {
    termElementsByShell.set(term.element, term);
  }
  const window = bridge.tail + chunk;
  DEC_PRIVATE_MODE.lastIndex = 0;
  for (let m = DEC_PRIVATE_MODE.exec(window); m; m = DEC_PRIVATE_MODE.exec(window)) {
    const mode = m[1];
    const enable = m[2] === "h";
    if (mode === "1000" || mode === "1002" || mode === "1003") {
      bridge.mouseButtons = enable;
    } else if (mode === "1006") {
      bridge.sgr = enable;
    }
  }
  bridge.tail = window.slice(-24);
}

/** 由终端 DOM 壳反查 xterm 实例（输出到达过至少一次后才可用）。 */
export function getTermForShell(shell: Element): XTerm | null {
  const root = shell.querySelector(".xterm");
  return (root && termElementsByShell.get(root)) || null;
}

/** 程序是否正在收鼠标滚轮事件（按键上报 + SGR 编码都开着）。 */
export function acceptsMouseWheel(term: XTerm): boolean {
  const bridge = termBridges.get(term);
  return Boolean(bridge?.mouseButtons && bridge.sgr);
}

/**
 * 打开终端后对 textarea 做「终端式输入」加固：
 * - autocomplete=off 与 xterm 已设的 autocorrect/autocapitalize/spellcheck 一起，
 *   让输入法尽量逐字符上屏而不是整词预测（真机软键盘组合键依赖这个）；
 * - inputmode=none 让虚拟键盘默认不自动弹出——点终端只聚焦（TUI 点击/选择
 *   照常工作），键盘由按键栏的 ⌨ 按钮显式拉起；硬件键盘不受影响。
 */
export function hardenTerminalTextarea(term: XTerm): void {
  const textarea = term.textarea;
  if (!textarea) return;
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("inputmode", "none");
}

/** 开/关虚拟键盘：拉起需要在用户手势内 focus 才生效。 */
export function setTerminalKeyboardOpen(
  textarea: HTMLTextAreaElement | null,
  open: boolean,
): boolean {
  if (!textarea) return false;
  if (open) {
    textarea.removeAttribute("inputmode");
    textarea.focus({ preventScroll: true });
  } else {
    textarea.setAttribute("inputmode", "none");
    textarea.blur();
  }
  return true;
}
