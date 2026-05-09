#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ENV="$ROOT_DIR/config/install.env"
APP_ENV="$ROOT_DIR/config/.env"
PID_FILE="$ROOT_DIR/run/webssh.pid"
OUT_LOG="$ROOT_DIR/logs/webssh.out.log"
ERR_LOG="$ROOT_DIR/logs/webssh.err.log"

if [[ -f "$INSTALL_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$INSTALL_ENV"
else
  SERVICE_NAME=""
fi

if [[ -f "$APP_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$APP_ENV"
  set +a
fi

if [[ -n "${SERVICE_NAME:-}" && -f "/etc/systemd/system/${SERVICE_NAME}.service" ]] && command -v systemctl >/dev/null 2>&1; then
  systemctl start "$SERVICE_NAME"
  echo "已通过 systemd 启动: $SERVICE_NAME"
  exit 0
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "服务已在运行，PID: $(cat "$PID_FILE")"
  exit 0
fi

mkdir -p "$ROOT_DIR/logs" "$ROOT_DIR/run"
nohup "$ROOT_DIR/runtime/node/bin/node" "$ROOT_DIR/app/server.js" >> "$OUT_LOG" 2>> "$ERR_LOG" &
echo $! > "$PID_FILE"

echo "已以前台外模式启动，PID: $(cat "$PID_FILE")"
