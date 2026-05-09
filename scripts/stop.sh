#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ENV="$ROOT_DIR/config/install.env"
PID_FILE="$ROOT_DIR/run/webssh.pid"

if [[ -f "$INSTALL_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$INSTALL_ENV"
else
  SERVICE_NAME=""
fi

if [[ -n "${SERVICE_NAME:-}" && -f "/etc/systemd/system/${SERVICE_NAME}.service" ]] && command -v systemctl >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME"
  echo "已停止 systemd 服务: $SERVICE_NAME"
  exit 0
fi

if [[ ! -f "$PID_FILE" ]]; then
  echo "未找到 PID 文件，服务可能未运行。"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for _ in 1 2 3 4 5; do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID"
  fi
fi

rm -f "$PID_FILE"
echo "已停止进程: $PID"
