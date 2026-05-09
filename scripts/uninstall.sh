#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ENV="$ROOT_DIR/config/install.env"
KEEP_CONFIG="0"
KEEP_LOGS="0"

usage() {
  cat <<'EOF'
用法:
  ./scripts/uninstall.sh [--keep-config] [--keep-logs]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-config)
      KEEP_CONFIG="1"
      shift
      ;;
    --keep-logs)
      KEEP_LOGS="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "uninstall.sh 需要 root 权限执行。" >&2
  exit 1
fi

if [[ ! -f "$INSTALL_ENV" ]]; then
  echo "缺少安装信息文件: $INSTALL_ENV" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$INSTALL_ENV"

if [[ -x "$ROOT_DIR/scripts/stop.sh" ]]; then
  "$ROOT_DIR/scripts/stop.sh" || true
fi

UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
if [[ -f "$UNIT_FILE" ]] && command -v systemctl >/dev/null 2>&1; then
  systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload
fi

if [[ "$KEEP_CONFIG" != "1" ]]; then
  rm -rf "$ROOT_DIR/config"
fi

if [[ "$KEEP_LOGS" != "1" ]]; then
  rm -rf "$ROOT_DIR/logs"
fi

rm -rf "$ROOT_DIR/app" "$ROOT_DIR/runtime" "$ROOT_DIR/scripts" "$ROOT_DIR/systemd" "$ROOT_DIR/run"

if [[ "$KEEP_CONFIG" != "1" && "$KEEP_LOGS" != "1" ]]; then
  rmdir "$ROOT_DIR" 2>/dev/null || true
fi

echo "卸载完成。"
