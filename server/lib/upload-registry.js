// server/lib/upload-registry.js —— Web 端文件上传的"乐观路径"注册表
//
// 背景与设计（见 port-shim.js 的 getPathForFile 实现说明）：
//  - 渲染器对拖入文件的处理是**同步**的：`let n = f.getPathForFile?.(file); t = n?.trim() ? n : void 0`，
//    没有 await —— 因此 Web 端无法在返回路径之前完成 HTTP 上传。
//  - 解法（乐观路径 / optimistic upload）：
//      1. shim 的 getPathForFile 同步返回一个**注册路径** `/upload-registry/<token>`；
//      2. 同一时刻立刻 fetch POST /upload 把 File 内容发上去（服务端按 token 落盘到
//         WORKSPACE_ROOT/.uploads/<token>-<safe-name>，并在本注册表里把 promise 标记为已落地）；
//      3. 用户点发送时，v4 sendText（或旧协议 sendPrompt）在**转发给 app-server 之前**调用
//         resolveAttachmentRefs()：扫描 attachments 引用，凡 /upload-registry/<token> 都等待
//         上传落地（resolve 或超时失败），替换为服务器磁盘上的真实绝对路径。
//         这一步彻底消除「渲染器已拿到路径、字节还没到磁盘」的竞态。
//  - app-server 收到 ref（真实绝对路径）后按桌面零拷贝语义自己读文件 —— 与原生
//    localZeroCopy 完全一致，无需任何传输协议适配。
//
// 生命周期：
//  - token 注册时即有 TTL（默认 1 小时），到期未发送的孤儿上传由 sweeper 清理；
//  - 一旦被某次 send 成功引用，条目转为 committed 并缩短 TTL（可配置），供重试/回滚短暂窗口；
//  - 服务器重启 → 注册表清空 → 未落地的拖拽发送会得到明确错误（不会静默发错文件）。
//
// 内容寻址去重（秒传，见 /upload-dedupe 端点）：
//  - 字节真实落盘到 .uploads/.blobs/<sha256>（内容寻址，双隐藏目录）；
//  - .uploads/<token>__<name> 是它的**硬链接**——对渲染器/app-server 透明（普通文件语义不变）；
//  - 客户端上传前先算 SHA-256 查 dedupe：命中 → 服务端直接链接已有 blob 结算 token，
//    零字节传输（「秒传」）；未命中 → 正常传字节，服务端写 blob + 链接。
//  - 清理按硬链接计数安全：blob 只有在所有别名过期后才会被扫掉（nlink 检查）。
'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const UPLOAD_DIR_NAME = '.uploads';
const BLOB_DIR_NAME = '.blobs';
const REGISTRY_PREFIX = '/upload-registry/';
const DEFAULT_TTL_MS = 60 * 60 * 1000;         // 注册后未引用 → 1 小时后清盘
const COMMITTED_TTL_MS = 24 * 60 * 60 * 1000;  // 已被发送引用 → 保留 24h（重试/审计窗口）
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SHA256_RE = /^[0-9a-f]{64}$/;

function safeBaseName(name) {
  const base = path.basename(String(name || 'file'));
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, '_').trim() || 'file';
  return cleaned.slice(0, 128);
}

class UploadRegistry {
  /**
   * @param {object} o
   * @param {string} o.workspaceRoot        WORKSPACE_ROOT 绝对路径（.uploads 的父目录）
   * @param {number} [o.maxUploadBytes]     单文件上限（默认 512MB；渲染器对无 localPath 的
   *                                        内联附件限制 20MB，我们放宽到 512MB）
   * @param {object} [o.logger]
   */
  constructor({ workspaceRoot, maxUploadBytes, logger }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.uploadDir = path.join(this.workspaceRoot, UPLOAD_DIR_NAME);
    this.blobDir = path.join(this.uploadDir, BLOB_DIR_NAME);
    this.maxUploadBytes = Number(maxUploadBytes) > 0 ? Number(maxUploadBytes) : 512 * 1024 * 1024;
    this.logger = logger;
    this.entries = new Map();   // token -> { promise, resolve, reject, path, fileName, bytes, committed, expiresAt }
    this.blobs = new Map();     // sha256 -> { refs: Set<token>, bytes } （内存索引；blob 文件本身在 .blobs/）
    this.sweeper = null;
  }

  start() {
    if (this.sweeper) return;
    // 启动清理：注册表过期条目 + 磁盘孤儿文件（进程重启后注册表为空，磁盘残留按 mtime 判断）
    this.sweeper = setInterval(() => { this.sweep().catch(() => {}); }, SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
    // 不 await：初始化失败不阻塞服务器启动
    this.sweep().catch(() => {});
  }

  async sweep() {
    const now = Date.now();
    for (const [token, e] of this.entries) {
      if (e.expiresAt && e.expiresAt < now) {
        this.entries.delete(token);
        if (e.sha256) this._unrefBlob(e.sha256, token);
        if (e.path) fsp.rm(e.path, { force: true }).catch(() => {});
        this.logger?.debug?.(`[upload] 过期清理 token=${token}`);
      }
    }
    // 磁盘层清理：.uploads 下 mtime 超过 committedTTL 的文件（涵盖重启后注册表丢失的情况）
    try {
      await fsp.mkdir(this.uploadDir, { recursive: true });
      for (const name of await fsp.readdir(this.uploadDir)) {
        if (name === BLOB_DIR_NAME) continue;
        const p = path.join(this.uploadDir, name);
        try {
          const st = await fsp.stat(p);
          if (now - Number(st.mtimeMs) > COMMITTED_TTL_MS) await fsp.rm(p, { force: true });
        } catch {}
      }
      // blob 目录：无硬链接别名（nlink==1，即只剩 blob 自身）且 mtime 过期的才清。
      // 有活跃别名（注册表内存索引或磁盘别名文件）的一律保留 —— 硬链接语义保证安全。
      try {
        for (const name of await fsp.readdir(this.blobDir)) {
          const p = path.join(this.blobDir, name);
          try {
            const st = await fsp.stat(p);
            if (st.nlink <= 1 && now - Number(st.mtimeMs) > COMMITTED_TTL_MS) await fsp.rm(p, { force: true });
          } catch {}
        }
      } catch {} // blob 目录不存在（首次运行）属正常
    } catch {}
  }

  /** blob 引用计数维护：token 别名销毁时解除引用，降到 0 且条目无 pending → 可清理。 */
  _unrefBlob(sha256, token) {
    const b = this.blobs.get(sha256);
    if (!b) return;
    b.refs.delete(token);
    if (b.refs.size === 0) this.blobs.delete(sha256);
    // 磁盘 blob 交给 sweeper 按 nlink/mtime 兜底清理，这里不立即删
  }

  /** 内容寻址查询（/upload-dedupe）：哈希已有 blob → 直接硬链接结算 token（秒传）。
   *  返回 true=已结算（客户端不用再传字节）。 */
  async dedupeCheck(token, { sha256, bytes, mime, fileName }, reqMeta) {
    if (!SHA256_RE.test(String(sha256 || ''))) return { error: 'bad_sha256' };
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.maxUploadBytes) return { error: 'bad_size' };
    const blobPath = path.join(this.blobDir, sha256);
    let st;
    try { st = await fsp.stat(blobPath); } catch { return false; }
    if (!st.isFile() || st.size !== bytes) return false;
    // 乐观路径自登记（同 settle）
    const tokenStr = String(token || '');
    if (!this.entries.has(tokenStr)) {
      try { this.register(fileName || 'file', tokenStr); } catch { return false; }
    }
    const entry = this.entries.get(tokenStr);
    if (entry.settled) return { ok: true, path: entry.path, deduped: true };
    try {
      await fsp.mkdir(this.uploadDir, { recursive: true });
      if (entry.placeholder) {
        await this._replacePlaceholder(blobPath, entry);
      } else {
        await fsp.link(blobPath, entry.path).catch(async (e) => {
          if (e.code !== 'EEXIST') throw e;
        });
      }
      entry.bytes = bytes;
      entry.mime = String(mime || '').slice(0, 200);
      entry.sha256 = sha256;
      entry.settled = true;
      entry.settledAt = Date.now();
      this._refBlob(sha256, tokenStr, bytes);
      entry.resolve({ path: entry.path, bytes, mime: entry.mime });
      this.logger?.info?.(`[upload] 秒传 ${entry.fileName} (${bytes} bytes, sha=${sha256.slice(0, 10)})${reqMeta ? ' from ' + reqMeta : ''}`);
      return { ok: true, path: entry.path, deduped: true };
    } catch (e) {
      this.logger?.warn?.(`[upload] 秒传链接失败 token=${token}: ${e.message}`);
      return false; // 链接失败 → 回退正常上传
    }
  }

  _refBlob(sha256, token, bytes) {
    let b = this.blobs.get(sha256);
    if (!b) { b = { refs: new Set(), bytes }; this.blobs.set(sha256, b); }
    b.refs.add(token);
  }

  uploadDirPath() { return this.uploadDir; }

  /**
   * 登记一个上传。两种模式：
   *  1. 服务端生成 token（/upload-register 端点：selectFile/selectFiles 流程，await 注册拿路径）；
   *  2. 客户端自报 token（getPathForFile 乐观路径：垫片本地生成 token 并按
   *     `<workspaceRoot>/.uploads/<token>__<safeName>` 规则自行预测路径 —— 双方约定
   *     同一套确定性命名，settle 时服务端以自报 token 为准登记并校验）。
   * @returns {{ token, finalPath, registryPath, entry }}
   */
  register(fileNameHint, clientToken) {
    const token = clientToken || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
    if (!/^[a-z0-9][a-z0-9-]{3,63}$/i.test(token)) throw new Error('bad_token');
    if (this.entries.has(token)) throw new Error('token_taken');
    const fileName = safeBaseName(fileNameHint);
    const finalPath = path.join(this.uploadDir, `${token}__${fileName}`);
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const entry = {
      token, promise, resolve, reject,
      path: finalPath, fileName,
      bytes: 0, mime: '', committed: false,
      expectedBytes: 0,        // 客户端预告的目标大小（占位文件用）
      placeholder: false,      // 磁盘上当前是占位文本而非真实字节
      registeredAt: Date.now(), expiresAt: Date.now() + DEFAULT_TTL_MS,
    };
    this.entries.set(token, entry);
    return { token, finalPath, registryPath: REGISTRY_PREFIX + token, entry };
  }

  /** HTTP /upload 的前置注册端点：登记并返回 token + 最终路径。
   *  clientToken 可选：乐观路径（拖拽）用客户端已生成的 token 注册，保证落盘路径
   *  与垫片同步返回的预测路径一致。
   *  expectedBytes 可选：客户端预告的目标大小 → 立刻在落盘路径写占位文本
   *  （见 writePlaceholder，await 写完才回包）。这保证注册返回的那一刻起该路径
   *  在磁盘上就有语义 —— 哈希计算/秒传查询期间用户就点发送也不会出现
   *  「路径不存在」或「读到半截」的窗口。 */
  async registerEndpoint(fileNameHint, clientToken, expectedBytes) {
    try {
      const r = this.register(fileNameHint, clientToken);
      if (Number.isFinite(expectedBytes) && expectedBytes >= 0) {
        r.entry.expectedBytes = expectedBytes;
        await this.writePlaceholder(r.entry).catch(() => {});
      }
      return { ok: true, token: r.token, path: r.finalPath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * 在 entry.path 写占位文本（原子写：先 .placeholder 再 rename）。
   * 内容面向模型：文件名、目标大小、当前是占位的说明、一条可直接执行的阻塞等待
   * 命令（stat 大小比对即终止条件 —— 无需读取内容判断「是否完成」）。
   * settle 落地时用 link+rename 把真实文件原子替换上去，无空窗。
   */
  async writePlaceholder(entry, extra) {
    await fsp.mkdir(this.uploadDir, { recursive: true });
    const target = entry.path + (entry.placeholder ? '' : '.placeholder');
    const text =
      `[文件上传中 / upload-in-progress]\n` +
      `目标文件: ${entry.fileName}\n` +
      `目标大小: ${entry.expectedBytes} bytes\n` +
      `注册时间: ${new Date().toISOString()}\n` +
      (extra ? extra + '\n' : '') +
      `\n` +
      `这个占位文件会在字节落盘后被原子替换为真实内容。如果你（AI 助手）现在被要求\n` +
      `读取/处理这个文件，说明用户在上传完成前就发送了消息。请执行下面的命令阻塞等待\n` +
      `（大小到达目标值即为完成；文件被替换后本说明自动消失）：\n` +
      `\n` +
      `  timeout 900 bash -c 'until [ "$(stat -c %s "${entry.path}")" = "${entry.expectedBytes}" ]; do sleep 2; done' \\\n` +
      `    && echo "上传完成: ${entry.fileName} (${entry.expectedBytes} bytes)" \\\n` +
      `    || echo "等待超时或上传失败，请告知用户重新上传"\n` +
      `\n` +
      `若等待失败（超时 900 秒 / 大小长期不变 / 出现 [上传失败] 标记），说明上传被中断，\n` +
      `请提示用户重新拖入该文件。\n`;
    await fsp.writeFile(target, text, 'utf8');
    if (target !== entry.path) {
      await fsp.rename(target, entry.path);
      entry.placeholder = true;
    }
  }

  /** 上传失败：把占位改写成失败说明（模型若正阻塞等待会因大小变化退出循环）。
   *  幂等：settle 侧已标记失败的条目直接跳过（客户端 /upload-failed 回调晚到时
   *  不重写、不覆盖第一条失败原因）。 */
  async writeFailure(entry, reason) {
    if (entry.failed) return;
    entry.failed = true;
    entry.expectedBytes = -1;
    entry.placeholder = true;
    await this.writePlaceholder(entry,
      `[上传失败 / upload-failed]\n原因: ${String(reason || 'unknown').slice(0, 200)}\n` +
      `原目标大小信息已作废。`);
    this.logger?.info?.(`[upload] 占位改写为失败 token=${entry.token}: ${reason}`);
  }

  /** settle 校验失败时由服务端统一终结条目：写失败占位 + reject promise。
   *  条目保留在注册表（failed=true）→ resolveAttachmentRefs 以 upload_failed 打回。 */
  async _failEntry(entry, reason) {
    entry.settling = false;
    try { await this.writeFailure(entry, reason); } catch {}
    try { entry.reject(new Error(String(reason))); } catch {}
    this.logger?.info?.(`[upload] settle 失败标记 token=${entry.token}: ${reason}`);
  }

  /** settle 成功路径：用 link+rename 把 blob 原子替换掉占位文件（无空窗）。 */
  async _replacePlaceholder(blobPath, entry) {
    if (!entry.placeholder) return;
    const tmp = entry.path + '.swap';
    try { await fsp.rm(tmp, { force: true }); } catch {}
    await fsp.link(blobPath, tmp);
    await fsp.rename(tmp, entry.path);   // 原子替换：读侧要么看到占位要么看到真文件
    entry.placeholder = false;
  }

  /** HTTP /upload 落地回调：字节写 blob（内容寻址）+ 硬链接别名，resolve promise。 */
  async settle(token, { stream, bytes, mime, fileName, sha256 }, reqMeta) {
    const tokenStr = String(token || '');
    // 乐观路径：客户端自报 token（getPathForFile 同步预测的路径）——此刻登记
    if (!this.entries.has(tokenStr)) {
      try { this.register(fileName || 'file', tokenStr); } catch { return false; }
    }
    const entry = this.entries.get(tokenStr);
    if (entry.settled) return { error: 'already_settled' };
    if (bytes > this.maxUploadBytes) {
      entry.reject(new Error(`upload_too_large: ${bytes} > ${this.maxUploadBytes}`));
      this.entries.delete(entry.token);
      return { error: 'too_large' };
    }
    try {
      await fsp.mkdir(this.blobDir, { recursive: true });
      const hash = crypto.createHash('sha256');
      const ws = require('node:fs').createWriteStream(entry.path + '.part');
      // 边写边算哈希；完成后校验 sha256（客户端提供时）→ rename 到 blob + 硬链接别名
      entry.settling = true;
      const { got, digest } = await new Promise((resolve, reject) => {
        let got = 0;
        stream.on('data', (c) => {
          got += c.length;
          if (got > this.maxUploadBytes) { stream.destroy(); reject(new Error('upload_too_large')); return; }
          hash.update(c);
        });
        stream.on('error', reject);
        stream.pipe(ws);
        ws.on('finish', () => {
          if (got !== bytes) { reject(new Error(`size_mismatch: ${got}/${bytes}`)); return; }
          resolve({ got, digest: hash.digest('hex') });
        });
        ws.on('error', reject);
      });
      // 客户端报了哈希 → 必须一致（防谎报：拿旧 blob 的哈希配新内容）。
      // 校验失败由服务端统一标记（单一所有权）：写失败占位 + reject promise，
      // 之后 resolveAttachmentRefs 以 upload_failed 打回发送；客户端的 /upload-failed
      // 回调退化为幂等兜底。
      if (sha256 && !SHA256_RE.test(String(sha256))) {
        fsp.rm(entry.path + '.part', { force: true }).catch(() => {});
        await this._failEntry(entry, 'bad_sha256（客户端哈希格式非法）');
        return { error: 'bad_sha256' };
      }
      if (sha256 && String(sha256) !== digest) {
        fsp.rm(entry.path + '.part', { force: true }).catch(() => {});
        this.logger?.warn?.(`[upload] 哈希不符 token=${tokenStr}: 宣称=${String(sha256).slice(0, 10)} 实际=${digest.slice(0, 10)}`);
        await this._failEntry(entry, `sha_mismatch: 宣称 ${String(sha256).slice(0, 12)}… 实际 ${digest.slice(0, 12)}…`);
        return { error: 'sha_mismatch' };
      }
      // .part → blob（同哈希 blob 已存在则复用）→ 硬链接到 .uploads/<token>__<name>
      const blobPath = path.join(this.blobDir, digest);
      await fsp.rename(entry.path + '.part', blobPath).catch(async (e) => {
        if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST' && e.code !== 'EISDIR') {
          // rename 跨问题或目标已存在 → 尝试覆盖式写入
          try { await fsp.copyFile(entry.path + '.part', blobPath); await fsp.rm(entry.path + '.part', { force: true }); }
          catch { throw e; }
        } else {
          await fsp.rm(entry.path + '.part', { force: true });
        }
      });
      // 占位在位 → link+rename 原子替换（读侧无空窗）；否则常规硬链接
      if (entry.placeholder) {
        await this._replacePlaceholder(blobPath, entry);
      } else {
        await fsp.link(blobPath, entry.path).catch(async (e) => {
          if (e.code !== 'EEXIST') {
            // 硬链接失败（如跨设备）→ 退回普通文件语义
            await fsp.copyFile(blobPath, entry.path).catch(() => fsp.rename(blobPath, entry.path));
          }
        });
      }
      entry.bytes = bytes;
      entry.mime = String(mime || '').slice(0, 200);
      entry.sha256 = digest;
      entry.settled = true;
      entry.settling = false;
      entry.settledAt = Date.now();
      this._refBlob(digest, tokenStr, bytes);
      entry.resolve({ path: entry.path, bytes, mime: entry.mime });
      this.logger?.info?.(`[upload] 落地 ${entry.fileName} (${bytes} bytes, sha=${digest.slice(0, 10)})${reqMeta ? ' from ' + reqMeta : ''}`);
      return { ok: true, path: entry.path, bytes, sha256: digest };
    } catch (e) {
      entry.settling = false;
      fsp.rm(entry.path + '.part', { force: true }).catch(() => {});
      entry.reject(e);
      this.entries.delete(entry.token);
      this.logger?.warn?.(`[upload] 落地失败 token=${token}: ${e.message}`);
      return { error: 'write_failed' };
    }
  }

  /** 引用是否是注册路径。两种形态都认：
   *   /upload-registry/<token>          —— 显式注册引用（保留兼容）
   *   <workspaceRoot>/.uploads/<token>__<name> —— 乐观路径：垫片 getPathForFile 同步
   *      返回的预测落盘路径（渲染器 localZeroCopy 直接引用它，sendText 时闸门等落地）。
   *      token 可信因为命名规则带随机段，服务端按 <token>__ 前缀精确反查注册表。 */
  isRegistryRef(ref) {
    if (typeof ref !== 'string') return false;
    if (ref.startsWith(REGISTRY_PREFIX)) return true;
    return this._tokenFromUploadsPath(ref) !== null;
  }

  /** 从 .uploads/<token>__<name> 路径提取 token；不属于该形态返回 null。 */
  _tokenFromUploadsPath(ref) {
    const prefix = this.uploadDir + path.sep;
    if (!ref.startsWith(prefix)) return null;
    const rest = ref.slice(prefix.length);
    const m = rest.match(/^([a-z0-9][a-z0-9-]{3,63})__/i);
    return m ? m[1] : null;
  }

  /**
   * 把 attachments 数组里的注册引用（/upload-registry/<token> 或 .uploads/<token>__<name>）
   * 替换为真实路径。各附件**并行**等待 —— 串行会把 N 个在传附件的宽限窗口累加
   * （3 个 × 8s = 24s 闸门阻塞 sendText），并行后总等待只取最慢的一个。
   * 单附件语义（三态）见 _resolveOneRef。
   * @param {Array} attachments  [{ ref, fileName, mime, bytes }]
   */
  async resolveAttachmentRefs(attachments, waitMs = 120 * 1000, graceMs = 8 * 1000) {
    if (!Array.isArray(attachments)) return attachments;
    return Promise.all(attachments.map((a) => this._resolveOneRef(a, waitMs, graceMs)));
  }

  /** 单个附件引用的解析。返回替换后的附件对象；失败（failed/超时无占位）抛错打回发送。 */
  async _resolveOneRef(a, waitMs, graceMs) {
    if (!a || typeof a !== 'object' || !this.isRegistryRef(a.ref)) return a;
    let token;
    if (a.ref.startsWith(REGISTRY_PREFIX)) token = a.ref.slice(REGISTRY_PREFIX.length);
    else {
      token = this._tokenFromUploadsPath(a.ref);
      if (!token) return a;
    }
    const entry = this.entries.get(token);
    if (!entry) return a;                                 // 旧文件已在盘上，放行
    if (entry.settled) return { ...a, ref: entry.path };  // 常规快路径
    if (entry.failed) throw new Error(`upload_failed: ${token}`);
    let timer = null;
    const timeoutP = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`upload_timeout: ${token}`)), entry.placeholder ? graceMs : waitMs);
      timer.unref?.();
    });
    try {
      const settled = await Promise.race([entry.promise, timeoutP]);
      entry.committed = true;
      entry.expiresAt = Date.now() + COMMITTED_TTL_MS;
      return { ...a, ref: settled.path };
    } catch (e) {
      if (entry.settled) {                                // 竞态：等待期间落地了
        entry.committed = true;
        entry.expiresAt = Date.now() + COMMITTED_TTL_MS;
        return { ...a, ref: entry.path };
      }
      if (entry.failed) throw new Error(`upload_failed: ${token}`);
      if (entry.placeholder) {
        // 宽限用尽 → 放行占位路径，模型侧阻塞等待
        this.logger?.info?.(`[upload] 宽限用尽放行占位 token=${token} (${entry.expectedBytes}B)`);
        return { ...a, ref: entry.path };
      }
      throw e;                                            // 无占位 → 打回发送
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

module.exports = { UploadRegistry, REGISTRY_PREFIX, safeBaseName };
