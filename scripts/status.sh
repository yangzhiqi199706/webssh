#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ENV="$ROOT_DIR/config/install.env"
APP_ENV="$ROOT_DIR/config/.env"
PID_FILE="$ROOT_DIR/run/webssh.pid"
PORT="3010"

if [[ -f "$INSTALL_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$INSTALL_ENV"
fi

if [[ -f "$APP_ENV" ]]; then
  CURRENT_PORT="$(awk -F= '/^PORT=/{print $2; exit}' "$APP_ENV" || true)"
  if [[ -n "$CURRENT_PORT" ]]; then
    PORT="$CURRENT_PORT"
  fi
fi

if [[ -n "${SERVICE_NAME:-}" && -f "/etc/systemd/system/${SERVICE_NAME}.service" ]] && command -v systemctl >/dev/null 2>&1; then
  systemctl --no-pager --full status "$SERVICE_NAME" || true
else
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "运行中，PID: $(cat "$PID_FILE")"
  else
    echo "未运行"
  fi
fi

echo "探活地址: http://127.0.0.1:${PORT}/health"
if command -v curl >/dev/null 2>&1; then
  curl -fsS "http://127.0.0.1:${PORT}/health" || true
  echo
fi
