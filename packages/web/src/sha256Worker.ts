/**
 * SHA-256 计算 Worker（Vite 模块 worker，`new Worker(new URL(...))` 打包入口）。
 *
 * 大文件的压缩循环是同步计算，主线程按 4MB 块跑会连续抢占 UI；把整文件哈希
 * 丢进 worker（Blob 通过 postMessage 是引用语义，不拷字节）。
 * 失败/不可用时由调用方回退到主线程实现（hashBlob 在安全上下文还优先走
 * crypto.subtle，三层降级）。
 */
import { hashBlob } from "./sha256Core.js";

interface HashRequest {
  id: number;
  blob: Blob;
}

self.onmessage = async (event: MessageEvent<HashRequest>) => {
  const { id, blob } = event.data ?? {};
  if (typeof id !== "number" || !blob) return;
  try {
    const hex = await hashBlob(blob, (loaded, total) => {
      self.postMessage({ id, loaded, total });
    });
    self.postMessage({ id, hex });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
