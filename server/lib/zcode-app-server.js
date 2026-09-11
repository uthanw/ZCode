// server/lib/zcode-app-server.js — ZCode app-server (zcode.cjs) 的 stdio JSON-RPC 客户端
'use strict';
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const DEFAULT_TIMEOUT = 3 * 60 * 1000; // 3min，agent 调用可能很长

class AppServerClient {
  constructor({ command, args, cwd, env, logger = console }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.logger = logger;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = new Set(); // (method, params) => void
    this.requestHandler = null;      // async (method, params) => result  （server->client 请求）
    this.buffer = '';
    this.startPromise = null;
  }

  start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      try {
        this.proc = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: this.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) { reject(e); return; }
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
      this.proc.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        // app-server 会把日志打到 stderr
        if (!s.trim()) return;
        this.logger.debug?.(`[app-server:stderr] ${s.trim().slice(0, 500)}`);
      });
      this.proc.on('error', (e) => { this._failAll(e); reject(e); });
      this.proc.on('close', (code) => {
        this._failAll(new Error(`app-server exited (code=${code})`));
        this.exitEmitter?.fire(code);
      });
      // 等 stderr 出现启动迹象或直接 resolve —— app-server 无握手，直接可用
      resolve(this);
    });
    return this.startPromise;
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    // 消息以 \n 分隔的 JSON
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this.logger.warn?.(`[app-server] 非 JSON 行: ${line.slice(0, 200)}`); continue; }
      this._onMessage(msg);
    }
  }

  _onMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = new Error(msg.error.message || 'app-server error');
        e.code = msg.error.code; e.data = msg.error.data;
        p.reject(e);
      } else p.resolve(msg.result);
      return;
    }
    // server -> client 请求（带 id 无 result/error）
    if (msg.id !== undefined && msg.method) {
      const mid = msg.id;
      Promise.resolve()
        .then(() => (this.requestHandler ? this.requestHandler(msg.method, msg.params) : {}))
        .then((result) => this.proc.stdin.write(JSON.stringify({ id: mid, result }) + '\n'))
        .catch((e) => this.proc.stdin.write(JSON.stringify({ id: mid, error: { code: -32603, message: e?.message || String(e) } }) + '\n'));
      return;
    }
    if (msg.method) {
      for (const cb of this.notifications) { try { cb(msg.method, msg.params); } catch (e) { this.logger.error?.('[app-server] notification handler error', e); } }
    }
  }

  _failAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  onNotification(cb) { this.notifications.add(cb); return () => this.notifications.delete(cb); }
  /** app-server 进程退出回调 (供上层清理/广播 runtime 状态) */
  onExit(cb) { this.exitEmitter = this.exitEmitter ?? new (require('./rpc.js').Emitter)(); this.exitEmitter.event(cb); }
  onRequest(handler) { this.requestHandler = handler; }

  /** 发 JSON-RPC 请求。app-server 协议无 jsonrpc 字段: {id, method, params} */
  request(method, params, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
    if (!this.proc) return Promise.reject(new Error('app-server not started'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg = params !== undefined ? { id, method, params } : { id, method };
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  notify(method, params) {
    if (!this.proc) throw new Error('app-server not started');
    const msg = params !== undefined ? { method, params } : { method };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  stop() {
    if (this.proc) { try { this.proc.kill('SIGTERM'); } catch {} this.proc = null; }
    this.startPromise = null;
  }
}

module.exports = { AppServerClient };
