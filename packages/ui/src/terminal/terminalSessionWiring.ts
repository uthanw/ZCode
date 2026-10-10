/*
 * TerminalSession 两条生命周期路径（persistentKey 常驻 registry / 普通 effect）共享的
 * 装配逻辑。此前这些逻辑在 TerminalSession.tsx 里各存一份拷贝，曾发生漂移
 * （persistentKey 路径漏 debug 日志）；收敛到本模块后，两条路径行为由同一份代码保证。
 *
 * 生命周期边界仍归 TerminalSession 所有：本模块只做「装配 + 订阅」，产生的 IDisposable
 * 由调用方决定放进哪个数组（普通路径 disposables 随 effect 销毁；persistent 路径
 * registryDisposers 随 entry 常驻，detach 不取消）。
 */

/* eslint-disable max-lines -- TerminalSession 两条生命周期路径（persistentKey registry 常驻 / 普通 effect）的共享装配必须保持在同一模块，拆散后两条路径会重新漂移。 */
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import type { Event, IDisposable } from "@zcode/rpc";
import type { ILink, ILinkHandler, ITheme, IWindowsPty } from "@xterm/xterm";
import {
  createPendingTerminalInputFallback,
  consumeTerminalInputFallbackHandledData,
  createTerminalInputFallbackKeydownCandidate,
  markTerminalInputFallbackHandled,
  recordTerminalInputFallbackHandledData,
  recordTerminalInputFallbackRecentData,
  resolveTerminalInputFallbackAction,
  type PendingTerminalInputFallback,
  type TerminalInputFallbackKeydownCandidate,
  type TerminalInputFallbackHandledData,
} from "@/terminal/terminalComposedInputFallback.js";
import { normalizePowerShellReadlineRedraw } from "@/terminal/terminalDataTransform.js";
import {
  applyStickyCtrlToInputData,
  applyStickyShiftToInputData,
  consumeStickyCtrl,
  hardenTerminalTextarea,
  isStickyCtrlActive,
  isStickyShiftActive,
  noteTerminalOutput,
} from "@/terminal/terminalExtraKeys.js";
import { getHttpLinksForTerminalBufferLine } from "@/terminal/terminalLinks.js";
import { mergeTerminalTheme } from "@/terminal/terminalTheme.js";
import { logger } from "@/logger.js";

const DEFAULT_TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Cascadia Mono', 'JetBrains Mono', 'MesloLGS NF', 'Hack Nerd Font', monospace";
const TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS = 150;
const TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS = 40;
const TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS = 150;

/** 避免 UI 工具模块直接依赖 React 类型版本；组件 useRef 产物结构兼容。 */
interface RefLike<T> {
  current: T;
}

export type TerminalSize = {
  cols: number;
  rows: number;
};

export interface TerminalResizeRequestStats {
  fit: number;
  queued: number;
  sent: number;
  skipped: number;
}

/** create / inspect 返回的终端外观信息（shell / 字体 / 主题）。 */
interface TerminalProfileInfo {
  shell: string;
  fontFamily: string;
  fontSize?: number;
  theme?: ITheme;
  fontFamilySource?: string;
  windowsPty?: IWindowsPty;
}

/** wireTerminalProcessing 需要的服务面（terminalService 的结构子集）。 */
interface TerminalProcessingService {
  write(params: { id: string; data: string }): Promise<void> | void;
  onDynamicData(id: string): Event<string>;
  onDynamicExit(id: string): Event<number>;
}

/*
 * Windows IME 组合输入兜底的三段去重状态（keydown candidate / 已处理历史 / 待定兜底），
 * 被 attachTerminalKeyHandler（写 candidate）与 wireTerminalProcessing（消费）共享。
 * persistent 路径随 entry 常驻时，实际被闭包引用的是首次创建时的那份状态（与拆分前
 * 引用旧 mount 的 refs 行为一致）。
 */
export interface TerminalInputFallbackState {
  pending: PendingTerminalInputFallback[];
  keydownCandidate: TerminalInputFallbackKeydownCandidate | null;
  recentHandled: TerminalInputFallbackHandledData[];
}

export function createTerminalInputFallbackState(): TerminalInputFallbackState {
  return { pending: [], keydownCandidate: null, recentHandled: [] };
}

function normalizeWindowsPtyOption(windowsPty: IWindowsPty | undefined): IWindowsPty | undefined {
  if (!windowsPty) return undefined;
  return windowsPty.buildNumber
    ? { backend: windowsPty.backend, buildNumber: windowsPty.buildNumber }
    : { backend: windowsPty.backend };
}

function normalizeTerminalFontSize(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 6 || value > 72) {
    return undefined;
  }
  return value;
}

function formatShellLabel(shell: string | null): string | null {
  if (!shell) {
    return null;
  }

  const shellParts = shell.split(/[\\/]/);
  const lastPart = shellParts[shellParts.length - 1];
  const name = lastPart?.replace(/\.exe$/i, "").toLowerCase();
  if (!name) {
    return shell;
  }
  if (name === "powershell" || name === "pwsh") {
    return "PowerShell";
  }
  return name;
}

function isHttpTerminalUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

/**
 * 创建 xterm 实例、装载 fit/clipboard 插件并 open 到 host。
 * 创建时 profile 未知，先用基础主题；PTY 就绪后由 applyTerminalProfile 覆盖。
 */
export function openTerminalInstance(
  host: HTMLElement,
  openUrl: (url: string) => void,
): {
  term: XTerm;
  fitAddon: FitAddon;
} {
  const term = new XTerm({
    fontSize: 13,
    fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    theme: mergeTerminalTheme(undefined),
    linkHandler: {
      allowNonHttpProtocols: false,
      activate(event, text) {
        if (!isHttpTerminalUrl(text)) return;
        event.preventDefault();
        logger.debug("[Terminal] open OSC 8 http link", { url: text });
        openUrl(text);
      },
    } satisfies ILinkHandler,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // 接入 ClipboardAddon 以支持 OSC 52，并让 xterm 的 copy 事件把选区写入系统剪贴板。
  term.loadAddon(new ClipboardAddon());
  term.open(host);
  hardenTerminalTextarea(term);
  return { term, fitAddon };
}

/**
 * 拦截 Ctrl/Cmd+C、Ctrl/Cmd+V：
 * - Ctrl+C 在 Win/Linux 默认会被当作 SIGINT 传给 PTY，必须在有选区时改走复制；
 * - Ctrl+V 不拦截会被当作 `^V` 字符输入；
 * - attachCustomKeyEventHandler 返回 false 只阻止 xterm 处理 Ctrl+V，
 *   不会取消浏览器随后派发的原生 paste 事件；这里手动 paste 一次后，
 *   原生 paste 又会被 xterm 的内置监听写入一次，导致快捷键粘贴重复。
 *   因此必须先取消默认事件，再保留手动读取剪贴板的单次写入。
 *
 * Termux 式粘滞 Ctrl：小屏补全按键栏激活后，下一个软键盘可打印键按 Ctrl 组合发送
 * （如 Ctrl+C 中断）；桌面真实 Ctrl 键自带 e.ctrlKey，不走这里。必须取消默认行为：
 * 否则浏览器继续产生 beforeinput/input，组合输入兜底会把它当作 IME 文本再写一次 PTY
 * （Ctrl+C 变成 "^C"+"c"）。粘滞 Shift 是锁定式的（一直生效到手动关闭），这里只标记，
 * 不在这里发字节：软键盘路径会走 onData 漏斗统一变换。
 */
export function attachTerminalKeyHandler(
  term: XTerm,
  fallbackState: RefLike<TerminalInputFallbackState>,
): void {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (isStickyCtrlActive() && !e.ctrlKey && e.key.length === 1) {
      consumeStickyCtrl();
      e.preventDefault();
      e.stopPropagation();
      term.input(String.fromCharCode(e.key.charCodeAt(0) & 0x1f));
      return false;
    }
    if (isStickyShiftActive() && !e.shiftKey && e.key.length === 1 && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
    }
    fallbackState.current.keydownCandidate =
      e.metaKey || e.ctrlKey || e.altKey
        ? null
        : createTerminalInputFallbackKeydownCandidate({
            eventTimeStamp: e.timeStamp,
            key: e.key,
            now: performance.now(),
          });
    if (!(e.metaKey || e.ctrlKey)) return true;
    const key = e.key.toLowerCase();
    if (key === "c" && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection()).catch((err) => {
        logger.warn("[Terminal] copy via shortcut failed:", err);
      });
      return false;
    }
    if (key === "v") {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard
        .readText()
        .then((text) => {
          logger.debug("[Terminal] paste via shortcut", { length: text.length });
          if (text) term.paste(text);
        })
        .catch((err) => logger.warn("[Terminal] paste via shortcut failed:", err));
      return false;
    }
    return true;
  });
}

/**
 * 交互说明：plain URL 不属于 React DOM，必须通过 xterm link provider 从 buffer
 * 计算可点击区域，再统一交给右侧 browser pane，避免在终端层直接碰平台 API。
 */
export function registerTerminalHttpLinkProvider(
  term: XTerm,
  openUrl: (url: string) => void,
): IDisposable {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const links = getHttpLinksForTerminalBufferLine(
        term.buffer.active,
        bufferLineNumber,
        term.cols,
      )?.map(
        (link): ILink => ({
          ...link,
          activate(event, text) {
            event.preventDefault();
            logger.debug("[Terminal] open plain http link", { url: text });
            openUrl(text);
          },
        }),
      );

      callback(links);
    },
  });
}

/**
 * 监听主题切换（<html> class 变化），实时更新 terminal 配色。
 * profile theme 的读取方式由调用方决定：普通路径读组件局部 ref；
 * persistent 路径读 registry entry（跨重挂常驻，重挂后组件局部 ref 已重置为 undefined）。
 */
export function observeTerminalTheme(
  term: XTerm,
  getProfileTheme: () => ITheme | undefined,
): IDisposable {
  const observer = new MutationObserver(() => {
    term.options.theme = mergeTerminalTheme(getProfileTheme());
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return { dispose: () => observer.disconnect() } satisfies IDisposable;
}

/**
 * 容器尺寸变化 → 节流到下一帧再 schedule。
 * shouldSchedule 读调用方的可见性 ref：隐藏 tab 的 ResizeObserver 回调直接忽略。
 */
export function observeTerminalResize(
  el: HTMLElement,
  schedule: () => void,
  shouldSchedule: () => boolean,
): IDisposable {
  let resizeRAF = 0;
  const observer = new ResizeObserver(() => {
    if (!shouldSchedule()) return;
    if (resizeRAF) cancelAnimationFrame(resizeRAF);
    resizeRAF = requestAnimationFrame(schedule);
  });
  observer.observe(el);
  return {
    dispose: () => {
      observer.disconnect();
      if (resizeRAF) cancelAnimationFrame(resizeRAF);
    },
  } satisfies IDisposable;
}

/** 计入统计并尝试 fit，失败只告警不抛出。context 用于区分日志来源（如 "persistent reuse"）。 */
export function tryFitTerminal(
  fitAddon: FitAddon,
  stats: RefLike<TerminalResizeRequestStats>,
  context: string,
): boolean {
  stats.current.fit += 1;
  try {
    fitAddon.fit();
    return true;
  } catch (error) {
    logger.warn(`[Terminal] ${context} fit failed:`, error);
    return false;
  }
}

/**
 * create PTY 前的首次同步 fit：
 * 如果先用 xterm 默认列数创建 PTY，启动输出会在随后 fit/resize 时按错误宽度重排，
 * zsh 可能显示反白的 PROMPT_EOL_MARK。首次可见时先同步 fit 再用真实 cols/rows 启动 PTY，
 * 避免启动输出和尺寸校正竞态。
 */
export function fitTerminalForCreate(params: {
  term: XTerm;
  fitAddon: FitAddon;
  host: HTMLElement;
  isVisible: () => boolean;
  stats: RefLike<TerminalResizeRequestStats>;
  lastSentSize: RefLike<TerminalSize | null>;
  sessionId: string;
  persistent: boolean;
}): TerminalSize | null {
  const { term, fitAddon, host, isVisible, stats, lastSentSize, sessionId, persistent } = params;
  if (!isVisible() || host.clientWidth <= 0 || host.clientHeight <= 0) {
    return null;
  }
  const context = persistent ? "persistent initial" : "initial";
  if (!tryFitTerminal(fitAddon, stats, context)) {
    return null;
  }
  const size = { cols: term.cols, rows: term.rows };
  lastSentSize.current = size;
  logger.debug(
    persistent
      ? "[Terminal] initial fit before create (persistent)"
      : "[Terminal] initial fit before create",
    {
      cols: size.cols,
      rows: size.rows,
      terminalTabId: sessionId,
    },
  );
  return size;
}

/**
 * PTY 就绪后把 create/inspect 返回的外观信息套回 xterm：
 * Windows ConPTY 在 resize 增高时不会像传统 Unix PTY 一样把 scrollback 拉回 viewport，
 * 不开启 xterm 的 windowsPty 兼容会让 PSReadLine 后续按旧坐标重绘，覆盖到上一条命令输出行。
 * 返回 profile theme 由调用方决定存到组件 ref 还是 registry entry。
 */
export function applyTerminalProfile(
  term: XTerm,
  params: {
    profile: TerminalProfileInfo;
    terminalId: string;
    sessionId: string;
    cwd?: string;
    onShellLabelChange: (sessionId: string, shellLabel: string | null) => void;
  },
): ITheme | undefined {
  const { shell, fontFamily, fontSize, theme, fontFamilySource, windowsPty } = params.profile;
  term.options.windowsPty = normalizeWindowsPtyOption(windowsPty);
  term.options.fontFamily = fontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
  const nextFontSize = normalizeTerminalFontSize(fontSize);
  if (nextFontSize) {
    term.options.fontSize = nextFontSize;
  }
  const profileTheme = theme as ITheme | undefined;
  term.options.theme = mergeTerminalTheme(profileTheme);
  const shellLabel = formatShellLabel(shell);
  logger.info("[Terminal] shell resolved:", {
    cwd: params.cwd,
    fontFamilySource,
    shell,
    shellLabel,
    terminalId: params.terminalId,
    terminalTabId: params.sessionId,
  });
  params.onShellLabelChange(params.sessionId, shellLabel);
  return profileTheme;
}

/**
 * PTY 就绪后的统一装配：实时输出订阅、exit 订阅、onData 输入漏斗、
 * Windows IME 组合输入兜底。这是两条生命周期路径曾经的漂移重灾区，收敛为唯一实现。
 *
 * 订阅产生的 IDisposable 全部 push 进调用方传入的 disposables：
 * - 普通路径传 effect 局部数组，组件卸载时随 cleanup 一并取消；
 * - persistent 路径传 registryDisposers，订阅随 entry 常驻——组件卸载只 detach DOM，
 *   不取消订阅，重挂复用时不重绑，切回 workspace 后 scrollback 与输入交互都还在。
 *
 * onData 漏斗上统一应用粘滞 Ctrl / Shift：Android 软键盘走 composition、不发标准
 * keydown，只有 onData 能覆盖全部输入路径（keydown/组合输入/粘贴）。
 */
export function wireTerminalProcessing(params: {
  term: XTerm;
  service: TerminalProcessingService;
  id: string;
  shell: string;
  sessionId: string;
  isWindowsDesktop: boolean;
  disposables: IDisposable[];
  fallbackState: RefLike<TerminalInputFallbackState>;
  getExitHandler: () => ((sessionId: string, exitCode: number) => void) | undefined;
  getExitedMessage: () => string;
  /**
   * IME 兜底延迟 flush 前的过期判断。普通路径传 () => disposed（组件已卸载则放弃）；
   * persistent 路径必须传 () => false——订阅随 entry 常驻、不随组件卸载取消，
   * 若在这里检查单次 effect 的取消标记（ptyCancelled），detach 后变 true 会让 IME
   * 兜底永久失效。release 时 entry.dispose 才是真生命周期终点；PTY disposed 后
   * write 为 no-op，安全。
   */
  isTornDown: () => boolean;
}): void {
  const { term, service, id, shell, sessionId, disposables, fallbackState, isTornDown } = params;

  disposables.push(
    service.onDynamicData(id)((data) => {
      noteTerminalOutput(term, data);
      term.write(normalizePowerShellReadlineRedraw(data, shell));
    }),
  );

  disposables.push(
    service.onDynamicExit(id)((exitCode) => {
      const exitHandler = params.getExitHandler();
      logger.info("[Terminal] terminal session exited", {
        autoClose: Boolean(exitHandler),
        exitCode,
        terminalId: id,
        terminalTabId: sessionId,
      });
      if (exitHandler) {
        exitHandler(sessionId, exitCode);
        return;
      }
      // side pane Terminal 不传 onExit，保留退出提示。
      term.write(`\r\n${params.getExitedMessage()}\r\n`);
    }),
  );

  disposables.push(
    term.onData((rawData) => {
      const data = applyStickyShiftToInputData(applyStickyCtrlToInputData(rawData));
      const now = performance.now();
      const state = fallbackState.current;
      // 维护 keydown candidate 去重历史，供 Windows 输入法 textarea 兜底消费
      // （IME composition committed text 的三段去重闭环）。
      const handledData = recordTerminalInputFallbackHandledData({
        candidate: state.keydownCandidate,
        data,
        history: state.recentHandled,
        maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
        now,
      });
      state.recentHandled = handledData.usedCandidate
        ? handledData.history
        : recordTerminalInputFallbackRecentData({
            data,
            history: handledData.history,
            maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
            now,
          });
      if (handledData.usedCandidate) {
        state.keydownCandidate = null;
      }
      markTerminalInputFallbackHandled(state.pending, data);
      void service.write({ id, data });
    }),
  );

  // Windows desktop 下某些输入法会把 composed text 留在 textarea 里，
  // xterm 可能只处理到一半；这里保留兜底。但 Linux Wayland 已确认会和 xterm 的
  // onData 路径重复写入，所以必须显式收窄到 Windows，避免把正常链路误伤。
  const textarea =
    params.isWindowsDesktop &&
    (term as unknown as { _core: { textarea: HTMLTextAreaElement } })._core?.textarea;
  if (textarea) {
    const handleInput = (e: InputEvent) => {
      // 只处理组合文本的 insertText
      if (e.inputType !== "insertText" || !e.data || !e.composed) return;
      const insertedText = e.data;
      const now = performance.now();
      const pendingFallback = createPendingTerminalInputFallback(insertedText);
      fallbackState.current.pending.push(pendingFallback);
      // 普通空格会先经 keydown 被 xterm onData 写入 PTY，随后浏览器才派发 composed input。
      // 搜狗输入法也会在没有稳定 keydown candidate 的情况下先触发 xterm onData、后触发 composed input。
      // 这里消费同一次输入附近的未消费 onData，避免把同一段组合文本再兜底写入一次。
      consumeTerminalInputFallbackHandledData({
        history: fallbackState.current.recentHandled,
        inputEventTimeStamp: e.timeStamp,
        maxAgeMs: TERMINAL_INPUT_FALLBACK_RECENT_DATA_MS,
        maxInputDelayMs: TERMINAL_INPUT_FALLBACK_KEYDOWN_INPUT_MS,
        now,
        pending: pendingFallback,
      });

      // 延迟检查：等 xterm 的 onData 先认领 pending，再判断是否需要兜底写入。
      setTimeout(() => {
        fallbackState.current.pending = fallbackState.current.pending.filter(
          (item) => item !== pendingFallback,
        );
        if (isTornDown()) {
          return;
        }
        const fallbackAction = resolveTerminalInputFallbackAction({
          pending: pendingFallback,
          textareaValue: textarea.value,
        });
        if (fallbackAction.shouldWrite) {
          // 普通空格也会触发 composed input，且 xterm 已经通过 onData 写入 PTY。
          // 只看 textarea.value 会把空格再手动写一次；这里必须确认 onData 没处理过才兜底。
          logger.debug("[Terminal] flush composed input fallback", {
            length: insertedText.length,
            terminalId: id,
            terminalTabId: sessionId,
          });
          void service.write({ id, data: insertedText });
        }
        if (fallbackAction.shouldClearTextarea) {
          textarea.value = "";
        }
      }, TERMINAL_INPUT_FALLBACK_FLUSH_DELAY_MS);
    };

    textarea.addEventListener("input", handleInput, true);
    disposables.push({
      dispose: () => textarea.removeEventListener("input", handleInput, true),
    } satisfies IDisposable);
  }
}
