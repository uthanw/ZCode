/* eslint-disable max-lines -- 常量表与压缩循环无法再拆分，行数天然超上限 */
/**
 * 流式 SHA-256（浏览器侧纯 JS 实现）。
 *
 * 为什么不用 crypto.subtle.digest：它只在安全上下文（HTTPS/localhost）存在；自托管
 * 常以 http://IP:port 裸跑，subtle 为 undefined。本实现在任意上下文可用。
 *
 * 分块流式读取（File.slice 不把整文件读进内存），worker 与主线程共用同一份核心，
 * 通过 DataView 读取大端字以避开 noUncheckedIndexedAccess 的下标检查噪音。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

interface Sha256State {
  h: Uint32Array;
  pending: Uint8Array;
  total: number;
}

function createSha256State(): Sha256State {
  return {
    h: new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]),
    pending: new Uint8Array(0),
    total: 0,
  };
}

/**
 * 压缩 64 字节对齐的数据（data.length 必须是 64 的倍数）。
 * data 可以是任意「64 的倍数」长度：流式累积的整块、或 128 字节填充 tail。
 * 之前这里只压缩第一个 64 字节块，导致（a）流式循环传入的整块只算了开头 64 字节，
 * （b）128 字节 tail 只压了一半 —— 两者都让哈希与标准实现不符，上传时服务端按
 * 真实字节算出的摘要与客户端宣称的不一致，报 sha_mismatch。
 */
function compress(state: Sha256State, data: Uint8Array): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const w = new Uint32Array(64);
  for (let block = 0; block < data.length; block += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(block + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const wm15 = w[i - 15] as number;
      const wm2 = w[i - 2] as number;
      const s0 = rotr(wm15, 7) ^ rotr(wm15, 18) ^ (wm15 >>> 3);
      const s1 = rotr(wm2, 17) ^ rotr(wm2, 19) ^ (wm2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    const H = state.h;
    let a = H[0] as number;
    let b = H[1] as number;
    let c = H[2] as number;
    let d = H[3] as number;
    let e = H[4] as number;
    let f = H[5] as number;
    let g = H[6] as number;
    let h = H[7] as number;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = ((H[0] as number) + a) >>> 0;
    H[1] = ((H[1] as number) + b) >>> 0;
    H[2] = ((H[2] as number) + c) >>> 0;
    H[3] = ((H[3] as number) + d) >>> 0;
    H[4] = ((H[4] as number) + e) >>> 0;
    H[5] = ((H[5] as number) + f) >>> 0;
    H[6] = ((H[6] as number) + g) >>> 0;
    H[7] = ((H[7] as number) + h) >>> 0;
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const r = new Uint8Array(a.length + b.length);
  r.set(a, 0);
  r.set(b, a.length);
  return r;
}

/**
 * 流式计算 Blob 的 SHA-256（hex）。
 *
 * @param blob 输入内容（File.slice 不整文件读进内存）
 * @param onProgress 已处理字节数回调（可用于进度条）
 */
export async function hashBlob(
  blob: Blob,
  onProgress?: (loaded: number, total: number) => void,
): Promise<string> {
  // 安全上下文（HTTPS/localhost）优先走原生实现：不占主线程、不需要降级路径。
  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    try {
      // 部分 TS DOM lib 版本不接受 Blob 直接作为 BufferSource，await arrayBuffer 后传入
      const buffer = await blob.arrayBuffer();
      const hash = await crypto.subtle.digest("SHA-256", buffer);
      const bytes = new Uint8Array(hash);
      let hex = "";
      for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i]?.toString(16).padStart(2, "0") ?? "00";
      }
      onProgress?.(blob.size, blob.size);
      return hex;
    } catch {
      // 大文件/非安全上下文回落到下面的流式实现
    }
  }

  const state = createSha256State();
  const CHUNK = 4 * 1024 * 1024;
  const total = blob.size;
  let offset = 0;
  while (offset < total) {
    const buf = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
    offset += buf.length;
    const data = state.pending.length ? concatBytes(state.pending, buf) : buf;
    const full = data.length - (data.length % 64);
    if (full > 0) compress(state, data.subarray(0, full));
    state.pending = data.subarray(full);
    onProgress?.(offset, total);
  }

  // 标准填充：0x80 + 0 填充 + 8 字节大端位长，补齐到 64 的倍数（1 或 2 块）
  const rem = state.pending.length;
  const tailLen = rem + 1 + 8 <= 64 ? 64 : 128;
  const tail = new Uint8Array(tailLen);
  tail.set(state.pending, 0);
  tail[rem] = 0x80;
  const dv = new DataView(tail.buffer);
  // 位长（64 位大端）：JS 位运算是 32 位，高 32 位单独算
  dv.setUint32(tailLen - 8, Math.floor(total / 0x20000000), false);
  dv.setUint32(tailLen - 4, total * 8, false);
  compress(state, tail);

  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += state.h[i]?.toString(16).padStart(8, "0") ?? "00000000";
  }
  return hex;
}
