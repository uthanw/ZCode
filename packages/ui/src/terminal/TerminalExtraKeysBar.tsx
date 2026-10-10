import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  EXTRA_KEY_CODES,
  applyShiftToKeyChar,
  findXtermTextarea,
  isStickyCtrlActive,
  isStickyShiftActive,
  onStickyCtrlChange,
  onStickyShiftChange,
  setStickyCtrl,
  setStickyShift,
  sendXtermKey,
  setTerminalKeyboardOpen,
  type KeyInit,
} from "@/terminal/terminalExtraKeys.js";

/*
 * Termux 式小屏补全按键栏。
 *
 * 软键盘没有 Esc/Ctrl/Tab/方向键，TUI 操作基本没法做。这里在检测到
 * 触屏或窄屏时自动显示一排补全按键；桌面（fine pointer 且宽屏）不渲染。
 * 按键经 terminalExtraKeys.sendXtermKey 注入 xterm 键盘层，粘滞 Ctrl
 * 的软键盘部分由 TerminalSession 的 customKeyEventHandler 完成。
 *
 * 按钮全部在 pointerdown 阶段 preventDefault，避免把焦点从 xterm
 * textarea 抢走导致软键盘收起。
 */

const SHOW_BAR_QUERY = "(pointer: coarse), (max-width: 720px)";

function TerminalExtraKeysBar({ getContainer }: { getContainer: () => HTMLElement | null }) {
  const [visible, setVisible] = useState(
    () => typeof window !== "undefined" && window.matchMedia(SHOW_BAR_QUERY).matches,
  );
  const [ctrlActive, setCtrlActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(SHOW_BAR_QUERY);
    const onChange = () => setVisible(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // 模块状态是唯一事实源：软键盘路径在 onData 漏斗里消费粘滞 Ctrl 后，
  // 这里的样式也要跟着熄灭，否则用户会以为 Ctrl 还挂着。
  useEffect(() => onStickyCtrlChange(setCtrlActive), []);
  // Shift 是锁定式粘滞（软键盘上每敲一字母要点两次没法用），状态只在按钮切换时变化。
  useEffect(() => onStickyShiftChange(setShiftActive), []);

  // 虚拟键盘默认被 inputmode=none 抑制（点终端不弹键盘），这里显式拉起/收起。
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const toggleKeyboard = () => {
    const opened = setTerminalKeyboardOpen(findXtermTextarea(getContainer()), !keyboardOpen);
    if (opened) setKeyboardOpen(!keyboardOpen);
  };

  if (!visible) return null;

  // 粘滞 Ctrl 以模块状态为唯一事实源：软键盘输入可能在 customKeyEventHandler
  // 里消费掉粘滞（consumeStickyCtrl），栏上的 React 状态只是样式镜像，
  // 发送前必须重读，否则会把普通按键错误地修饰成 Ctrl 组合。
  // 粘滞 Shift 是锁定式的：不随发送熄灭，只有再点 SHIFT 才关闭。
  const press = (init: KeyInit) => {
    const useCtrl = isStickyCtrlActive();
    const useShift = isStickyShiftActive();
    const keyInit: KeyInit = { ...init, ctrlKey: useCtrl, shiftKey: useShift || init.shiftKey };
    if (useShift && init.key.length === 1) {
      // 符号键在 Shift 层上直接换成变体字符（"1"→"!"），软键盘没有 Shift 概念。
      keyInit.key = applyShiftToKeyChar(init.key);
    }
    sendXtermKey(getContainer(), keyInit);
    if (useCtrl || ctrlActive) {
      setStickyCtrl(false);
      setCtrlActive(false);
    }
    refocusTerminal();
  };

  /** 点按可能仍把焦点挪到按钮上，把焦点还回去，软键盘才不会收起。 */
  const refocusTerminal = () => {
    findXtermTextarea(getContainer())?.focus({ preventScroll: true });
  };

  const toggleCtrl = () => {
    const next = !ctrlActive;
    setCtrlActive(next);
    setStickyCtrl(next);
    refocusTerminal();
  };

  const toggleShift = () => {
    const next = !shiftActive;
    setShiftActive(next);
    setStickyShift(next);
    refocusTerminal();
  };

  const keys: Array<{
    label: string;
    onPress: () => void;
    active?: boolean;
  }> = [
    { label: "ESC", onPress: () => press(EXTRA_KEY_CODES.escape) },
    { label: "CTRL", onPress: toggleCtrl, active: ctrlActive },
    { label: "SHIFT", onPress: toggleShift, active: shiftActive },
    { label: "TAB", onPress: () => press(EXTRA_KEY_CODES.tab) },
    { label: "←", onPress: () => press(EXTRA_KEY_CODES.arrowLeft) },
    { label: "↑", onPress: () => press(EXTRA_KEY_CODES.arrowUp) },
    { label: "↓", onPress: () => press(EXTRA_KEY_CODES.arrowDown) },
    { label: "→", onPress: () => press(EXTRA_KEY_CODES.arrowRight) },
    { label: "/", onPress: () => press({ key: "/", keyCode: 191 }) },
    { label: "~", onPress: () => press({ key: "~", keyCode: 192 }) },
    { label: "|", onPress: () => press({ key: "|", keyCode: 220 }) },
    { label: "-", onPress: () => press({ key: "-", keyCode: 189 }) },
  ];

  return (
    <div
      className="flex shrink-0 select-none items-center gap-1 overflow-x-auto border-t border-border/40 pt-1.5 !scrollbar-hide"
      data-testid="terminal-extra-keys"
    >
      <button
        type="button"
        aria-pressed={keyboardOpen}
        aria-label="Toggle keyboard"
        title="键盘"
        onPointerDown={(event) => event.preventDefault()}
        onClick={toggleKeyboard}
        className={cn(
          "flex h-8 min-w-10 shrink-0 items-center justify-center rounded-md transition-colors",
          keyboardOpen
            ? "bg-foreground-subtlest/30 text-foreground"
            : "bg-foreground-subtlest/10 text-foreground-subtle active:bg-foreground-subtlest/25",
        )}
      >
        <Keyboard className="h-4 w-4" />
      </button>
      {keys.map(({ label, onPress, active }) => (
        <button
          key={label}
          type="button"
          aria-pressed={active}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onPress}
          className={cn(
            "h-8 min-w-10 shrink-0 rounded-md px-1.5 text-xs font-medium transition-colors",
            active
              ? "bg-foreground-subtlest/30 text-foreground"
              : "bg-foreground-subtlest/10 text-foreground-subtle active:bg-foreground-subtlest/25",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export { TerminalExtraKeysBar };
