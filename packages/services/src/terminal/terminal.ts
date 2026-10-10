import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { TerminalFontFamilySource, TerminalThemeProfile } from "./terminalProfile.js";

export interface TerminalWindowsPtyInfo {
  backend: "conpty" | "winpty";
  buildNumber?: number;
}

/** create / inspect 共用的终端外观信息（重连时原样套回 xterm，观感不跳变）。 */
export interface TerminalCreateResult {
  id: string;
  shell: string;
  fontFamily: string;
  fontSize?: number;
  theme?: TerminalThemeProfile;
  fontFamilySource: TerminalFontFamilySource;
  windowsPty?: TerminalWindowsPtyInfo;
}

export interface ITerminalService {
  create(params: { cols: number; rows: number; cwd?: string }): Promise<TerminalCreateResult>;
  write(params: { id: string; data: string }): Promise<void>;
  /** 客户端断连重连前探活：PTY 在客户端断开时不回收，刷新页面后可按 id 重连。 */
  has(params: { id: string }): Promise<boolean>;
  /** 读取服务端回放缓冲（客户端断连期间的输出），重连后先回放再订阅实时流。 */
  readScrollback(params: { id: string }): Promise<string>;
  /** 按 id 探测存活终端并取回 create 时的外观信息；不存在时返回 null，客户端回退到全新 create。 */
  inspect(params: { id: string }): Promise<TerminalCreateResult | null>;
  resize(params: { id: string; cols: number; rows: number }): Promise<void>;
  dispose(params: { id: string }): Promise<void>;
  onDynamicData(id: string): Event<string>;
  onDynamicExit(id: string): Event<number>;
}

export const ITerminalService = createServiceDescriptor<ITerminalService>(ServiceChannels.Terminal);
