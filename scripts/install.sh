#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/webssh"
SERVICE_NAME="webssh"
RUN_USER="root"
PORT="3010"
ENABLE_SERVICE="1"
START_SERVICE="1"

usage() {
  cat <<'EOF'
用法:
  ./scripts/install.sh [--install-dir /opt/webssh] [--service-name webssh] [--user root] [--port 3010] [--no-enable] [--no-start]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --user)
      RUN_USER="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --no-enable)
      ENABLE_SERVICE="0"
      shift
      ;;
    --no-start)
      START_SERVICE="0"
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
  echo "install.sh 需要 root 权限执行。" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "当前系统缺少 systemctl，无法安装 systemd 服务。" >&2
  exit 1
fi

if [[ ! -x "$PACKAGE_ROOT/runtime/node/bin/node" ]]; then
  echo "未找到包内 Node 运行时: $PACKAGE_ROOT/runtime/node/bin/node" >&2
  exit 1
fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "运行用户不存在: $RUN_USER" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/logs" "$INSTALL_DIR/run" "$INSTALL_DIR/config"
cp -a "$PACKAGE_ROOT/app" "$INSTALL_DIR/"
cp -a "$PACKAGE_ROOT/runtime" "$INSTALL_DIR/"
cp -a "$PACKAGE_ROOT/scripts" "$INSTALL_DIR/"
cp -a "$PACKAGE_ROOT/systemd" "$INSTALL_DIR/"

if [[ ! -f "$INSTALL_DIR/config/.env" ]]; then
  cp "$PACKAGE_ROOT/config/.env.example" "$INSTALL_DIR/config/.env"
fi

if grep -q '^PORT=' "$INSTALL_DIR/config/.env"; then
  sed -i "s/^PORT=.*/PORT=$PORT/" "$INSTALL_DIR/config/.env"
else
  printf '\nPORT=%s\n' "$PORT" >> "$INSTALL_DIR/config/.env"
fi

cat > "$INSTALL_DIR/config/install.env" <<EOF
INSTALL_DIR=$INSTALL_DIR
SERVICE_NAME=$SERVICE_NAME
RUN_USER=$RUN_USER
PORT=$PORT
EOF

UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
sed \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__RUN_USER__|$RUN_USER|g" \
  "$PACKAGE_ROOT/systemd/webssh.service.template" > "$UNIT_FILE"

chown -R "$RUN_USER":"$(id -gn "$RUN_USER")" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/scripts/"*.sh

systemctl daemon-reload
if [[ "$ENABLE_SERVICE" == "1" ]]; then
  systemctl enable "$SERVICE_NAME" >/dev/null
fi
if [[ "$START_SERVICE" == "1" ]]; then
  systemctl restart "$SERVICE_NAME"
fi

echo "安装完成。"
echo "安装目录: $INSTALL_DIR"
echo "服务名称: $SERVICE_NAME"
echo "端口: $PORT"
echo "状态检查: $INSTALL_DIR/scripts/status.sh"
echo "日志查看: journalctl -u $SERVICE_NAME -n 100 --no-pager"
