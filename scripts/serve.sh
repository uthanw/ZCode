#!/usr/bin/env bash
# zcode-web-service 守护启动脚本 —— 崩溃自动重启（公网服务必备）
#
# 用法:
#   ./scripts/serve.sh                       # 前台运行（Ctrl+C 退出）
#   ZCODE_WEB_TOKEN=xxx ./scripts/serve.sh   # 开启 Bearer/Cookie/?token= 鉴权
#   ZCODE_WEB_PORT=8080 ./scripts/serve.sh   # 指定端口（默认 8080）
#   nohup ./scripts/serve.sh > /var/log/zcode-web.log 2>&1 &   # 后台常驻
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${ZCODE_WEB_PORT:=8080}"
: "${ZCODE_WEB_HOST:=0.0.0.0}"
export ZCODE_WEB_PORT ZCODE_WEB_HOST

NODE_BIN="${NODE_BIN:-$(command -v node || echo /root/.nvm/versions/node/v22.23.2/bin/node)}"
if [ ! -x "$NODE_BIN" ]; then
  echo "找不到 node 可执行文件，请设置 NODE_BIN" >&2
  exit 1
fi

RESTART_COUNT=0
RESTART_WINDOW_START=$(date +%s)
MAX_RESTARTS_PER_10MIN=20

echo "[serve] 启动 zcode-web-service  端口=$ZCODE_WEB_PORT  鉴权=${ZCODE_WEB_TOKEN:+已开启}${ZCODE_WEB_TOKEN:-未开启}"

# trap 重入保护：kill 0 会向本进程组（含自己）再发 TERM，必须先解除 trap，否则死循环刷日志
STOPPING=0
on_exit_signal() {
  if [ "$STOPPING" = "1" ]; then return; fi
  STOPPING=1
  trap - INT TERM
  echo "[serve] 收到退出信号，停止守护"
  kill 0
  exit 0
}
trap on_exit_signal INT TERM

while true; do
  START_TS=$(date +%s)
  "$NODE_BIN" server/web-server.mjs
  EXIT_CODE=$?
  END_TS=$(date +%s)
  RUNTIME=$((END_TS - START_TS))

  if [ "$EXIT_CODE" = "0" ]; then
    echo "[serve] 进程正常退出（code=0），守护结束"
    exit 0
  fi

  # 重启风暴保护：10 分钟内超过 N 次则退出，避免无意义刷日志
  NOW=$(date +%s)
  if [ $((NOW - RESTART_WINDOW_START)) -gt 600 ]; then
    RESTART_WINDOW_START=$NOW
    RESTART_COUNT=0
  fi
  RESTART_COUNT=$((RESTART_COUNT + 1))
  if [ "$RESTART_COUNT" -gt "$MAX_RESTARTS_PER_10MIN" ]; then
    echo "[serve] 10 分钟内已重启 $RESTART_COUNT 次，疑似持续性故障，停止守护" >&2
    exit 1
  fi

  # 快速失败时退避，避免死循环占满 CPU
  if [ "$RUNTIME" -lt 5 ]; then DELAY=5; else DELAY=1; fi
  echo "[serve] 进程异常退出 code=$EXIT_CODE 运行时长=${RUNTIME}s，${DELAY}s 后重启（本窗口第 $RESTART_COUNT 次）" >&2
  sleep "$DELAY"
done
