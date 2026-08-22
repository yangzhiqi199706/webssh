#!/usr/bin/env bash
# ARM64 全功能 WebSSH 离线安装器。仅安装 webssh 主壳和协议助手，视频复用目标机现有 dcim/ZLMediaKit/WVP。
set -Eeuo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/webssh}"
RUN_USER="${RUN_USER:-root}"
HTTP_PORT="${HTTP_PORT:-3010}"
PROTOCOL_PORT="${PROTOCOL_PORT:-5000}"
PROTOCOL_PREFIX="${PROTOCOL_PREFIX:-/protocol}"
SERVICE_MAIN="${SERVICE_MAIN:-webssh}"
SERVICE_PROTO="${SERVICE_PROTO:-webssh-protocol}"
STAMP="$(date +%Y%m%d%H%M%S)"
TMP_ROOT="$(mktemp -d /tmp/webssh-arm64-install.XXXXXX)"
BACKUP_APP=""
BACKUP_PROTOCOL=""
BACKUP_NODE=""
NEW_MAIN_STARTED=0
NEW_PROTO_STARTED=0

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '[警告] %s\n' "$*" >&2; }
die() { printf '[错误] %s\n' "$*" >&2; exit 1; }

cleanup_tmp() { rm -rf "$TMP_ROOT"; }

rollback() {
  local rc=$?
  [[ "$rc" -eq 0 ]] && return 0
  warn "安装失败，开始回滚；不会操作 dcim、ZLMediaKit、WVP、Redis 或 MySQL。"
  systemctl stop "$SERVICE_PROTO" "$SERVICE_MAIN" >/dev/null 2>&1 || true
  [[ -n "$BACKUP_APP" && -d "$BACKUP_APP" ]] && { rm -rf "$INSTALL_DIR/app"; mv "$BACKUP_APP" "$INSTALL_DIR/app"; }
  [[ -n "$BACKUP_PROTOCOL" && -d "$BACKUP_PROTOCOL" ]] && { rm -rf "$INSTALL_DIR/protocol"; mv "$BACKUP_PROTOCOL" "$INSTALL_DIR/protocol"; }
  [[ -n "$BACKUP_NODE" && -d "$BACKUP_NODE" ]] && { rm -rf "$INSTALL_DIR/runtime/node"; mv "$BACKUP_NODE" "$INSTALL_DIR/runtime/node"; }
  systemctl daemon-reload >/dev/null 2>&1 || true
  [[ -n "$BACKUP_APP" ]] && systemctl start "$SERVICE_MAIN" >/dev/null 2>&1 || true
  [[ -n "$BACKUP_PROTOCOL" ]] && systemctl start "$SERVICE_PROTO" >/dev/null 2>&1 || true
  cleanup_tmp
  exit "$rc"
}
trap rollback ERR
trap cleanup_tmp EXIT

[[ "$(id -u)" -eq 0 ]] || die '必须使用 root 安装'
command -v systemctl >/dev/null 2>&1 || die '缺少 systemctl'
command -v tar >/dev/null 2>&1 || die '缺少 tar'
command -v curl >/dev/null 2>&1 || die '缺少 curl'
id "$RUN_USER" >/dev/null 2>&1 || die "运行用户不存在: $RUN_USER"

ARCH="$(uname -m)"
[[ "$ARCH" == 'aarch64' || "$ARCH" == 'arm64' ]] || die "此安装包仅支持 ARM64/aarch64，当前架构：$ARCH"

APP_SRC="$PACKAGE_ROOT/app"
PROTO_SRC="$PACKAGE_ROOT/protocol/app"
NODE_ARCHIVE="$(find "$PACKAGE_ROOT/runtime" -maxdepth 1 -type f -name 'node-v*-linux-arm64.tar.xz' | sort | tail -n 1)"
PY_ARCHIVE="$(find "$PACKAGE_ROOT/protocol/runtime" -maxdepth 1 -type f -name 'cpython-*-aarch64-unknown-linux-gnu-install_only.tar.gz' | sort | tail -n 1)"
WHEELS_DIR="$PACKAGE_ROOT/protocol/wheels"

[[ -f "$APP_SRC/server.js" ]] || die '缺少 app/server.js'
[[ -f "$APP_SRC/index.html" ]] || die '缺少 app/index.html'
[[ -d "$APP_SRC/node_modules" ]] || die '缺少 app/node_modules'
[[ -n "$NODE_ARCHIVE" && -f "$NODE_ARCHIVE" ]] || die '缺少 Node.js ARM64 压缩包'
[[ -f "$PROTO_SRC/app.py" ]] || die '缺少 protocol/app/app.py'
[[ -d "$WHEELS_DIR" ]] || die '缺少 protocol/wheels'
[[ -f "$PACKAGE_ROOT/systemd/webssh.service.template" ]] || die '缺少 webssh.service.template'
[[ -f "$PACKAGE_ROOT/systemd/webssh-protocol.service.template" ]] || die '缺少 webssh-protocol.service.template'

log "ARM64 架构检查通过：$ARCH"
log "检查 Node runtime：$(basename "$NODE_ARCHIVE")"
mkdir -p "$TMP_ROOT/node" "$TMP_ROOT/python"
tar -xJf "$NODE_ARCHIVE" -C "$TMP_ROOT/node"
NODE_BIN="$(find "$TMP_ROOT/node" -type f -path '*/bin/node' | head -n 1)"
[[ -n "$NODE_BIN" && -f "$NODE_BIN" ]] || die 'Node 压缩包内没有 bin/node'
chmod +x "$NODE_BIN"
NODE_VERSION="$($NODE_BIN -p 'process.version')"
NODE_PROCESS_ARCH="$($NODE_BIN -p 'process.arch')"
[[ "$NODE_PROCESS_ARCH" == 'arm64' ]] || die "Node 架构不是 arm64：$NODE_PROCESS_ARCH"
log "Node 校验通过：$NODE_VERSION:$NODE_PROCESS_ARCH"
NODE_ROOT="$(dirname "$(dirname "$NODE_BIN")")"

[[ -n "$PY_ARCHIVE" && -f "$PY_ARCHIVE" ]] || die '缺少 CPython 3.11 ARM64 压缩包'
tar -xzf "$PY_ARCHIVE" -C "$TMP_ROOT/python"
PY_ROOT="$(find "$TMP_ROOT/python" -mindepth 1 -maxdepth 1 -type d -name python | head -n 1)"
[[ -n "$PY_ROOT" && -x "$PY_ROOT/bin/python3" ]] || die 'Python 压缩包内没有 python/bin/python3'
PY_BIN="$PY_ROOT/bin/python3"
chmod +x "$PY_ROOT/bin"/* 2>/dev/null || true
log "Python runtime 已解包：$($PY_BIN --version 2>&1)"

mkdir -p "$INSTALL_DIR/logs" "$INSTALL_DIR/run" "$INSTALL_DIR/config" "$INSTALL_DIR/runtime"

if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_PROTO}\.service"; then systemctl stop "$SERVICE_PROTO" || true; fi
if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_MAIN}\.service"; then systemctl stop "$SERVICE_MAIN" || true; fi

if [[ -d "$INSTALL_DIR/app" ]]; then BACKUP_APP="$INSTALL_DIR/app.bak-arm64-$STAMP"; mv "$INSTALL_DIR/app" "$BACKUP_APP"; fi
if [[ -d "$INSTALL_DIR/protocol" ]]; then BACKUP_PROTOCOL="$INSTALL_DIR/protocol.bak-arm64-$STAMP"; mv "$INSTALL_DIR/protocol" "$BACKUP_PROTOCOL"; fi
if [[ -d "$INSTALL_DIR/runtime/node" && ! -L "$INSTALL_DIR/runtime/node" ]]; then BACKUP_NODE="$INSTALL_DIR/runtime/node.bak-arm64-$STAMP"; mv "$INSTALL_DIR/runtime/node" "$BACKUP_NODE"; fi

log '复制主壳和全功能静态子站...'
cp -a "$APP_SRC" "$INSTALL_DIR/app"
mkdir -p "$INSTALL_DIR/runtime/node"
cp -a "$NODE_ROOT/." "$INSTALL_DIR/runtime/node/"
chmod +x "$INSTALL_DIR/runtime/node/bin/node"

if [[ -f "$INSTALL_DIR/config/.env" ]]; then
  if grep -q '^PORT=' "$INSTALL_DIR/config/.env"; then sed -i "s/^PORT=.*/PORT=$HTTP_PORT/" "$INSTALL_DIR/config/.env"; else printf '\nPORT=%s\n' "$HTTP_PORT" >> "$INSTALL_DIR/config/.env"; fi
  if grep -q '^PROTOCOL_TARGET=' "$INSTALL_DIR/config/.env"; then sed -i "s|^PROTOCOL_TARGET=.*|PROTOCOL_TARGET=http://127.0.0.1:$PROTOCOL_PORT|" "$INSTALL_DIR/config/.env"; else printf 'PROTOCOL_TARGET=http://127.0.0.1:%s\n' "$PROTOCOL_PORT" >> "$INSTALL_DIR/config/.env"; fi
else
  printf 'PORT=%s\nPROTOCOL_TARGET=http://127.0.0.1:%s\n' "$HTTP_PORT" "$PROTOCOL_PORT" > "$INSTALL_DIR/config/.env"
fi
chmod 600 "$INSTALL_DIR/config/.env"

log '安装协议助手 Python runtime 和离线 wheels...'
mkdir -p "$INSTALL_DIR/protocol/runtime"
cp -a "$PROTO_SRC" "$INSTALL_DIR/protocol/app"
cp -a "$PY_ROOT" "$INSTALL_DIR/protocol/runtime/python"
mkdir -p "$INSTALL_DIR/protocol/runtime/site-packages"
"$INSTALL_DIR/protocol/runtime/python/bin/python3" -m pip install --no-index --no-cache-dir --disable-pip-version-check --find-links="$WHEELS_DIR" --target="$INSTALL_DIR/protocol/runtime/site-packages" "$WHEELS_DIR"/*.whl

mkdir -p "$INSTALL_DIR/protocol/app/uploads" "$INSTALL_DIR/protocol/app/outputs" "$INSTALL_DIR/protocol/app/downloads" "$INSTALL_DIR/protocol/app/module4_uploads" "$INSTALL_DIR/protocol/app/module4_downloads"
PYTHONPATH="$INSTALL_DIR/protocol/runtime/site-packages" "$INSTALL_DIR/protocol/runtime/python/bin/python3" - <<'PY_CHECK'
import importlib
mods = ['flask', 'pandas', 'numpy', 'xlrd', 'xlwt', 'openpyxl', 'docx', 'lxml']
missing = []
for name in mods:
    try:
        importlib.import_module(name)
        print('OK', name)
    except Exception as exc:
        print('FAIL', name, exc)
        missing.append(name)
raise SystemExit(1 if missing else 0)
PY_CHECK

printf 'window.WEBSSH_FEATURES = { protocol: true, video: true, db: true, ha: true, protoConv: true };\n' > "$INSTALL_DIR/app/runtime-features.js"

mkdir -p "$INSTALL_DIR/systemd" "$INSTALL_DIR/scripts"
cp -a "$PACKAGE_ROOT/systemd/." "$INSTALL_DIR/systemd/"
if [[ -d "$PACKAGE_ROOT/scripts" ]]; then cp -a "$PACKAGE_ROOT/scripts/." "$INSTALL_DIR/scripts/"; fi
if [[ -f "$PACKAGE_ROOT/uninstall-all.sh" ]]; then cp -a "$PACKAGE_ROOT/uninstall-all.sh" "$INSTALL_DIR/uninstall-all.sh"; chmod +x "$INSTALL_DIR/uninstall-all.sh"; fi

cat > "$INSTALL_DIR/config/install.env" <<EOF
INSTALL_DIR=$INSTALL_DIR
SERVICE_NAME=$SERVICE_MAIN
RUN_USER=$RUN_USER
EOF

sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__RUN_USER__|$RUN_USER|g" "$PACKAGE_ROOT/systemd/webssh.service.template" > "/etc/systemd/system/${SERVICE_MAIN}.service"
sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" -e "s|__RUN_USER__|$RUN_USER|g" -e "s|PROTOCOL_PORT=5000|PROTOCOL_PORT=$PROTOCOL_PORT|g" -e "s|PROTOCOL_PREFIX=/protocol|PROTOCOL_PREFIX=$PROTOCOL_PREFIX|g" "$PACKAGE_ROOT/systemd/webssh-protocol.service.template" > "/etc/systemd/system/${SERVICE_PROTO}.service"

chown -R "$RUN_USER":"$(id -gn "$RUN_USER")" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/runtime/node/bin/node" "$INSTALL_DIR/protocol/runtime/python/bin/python3"
systemctl daemon-reload
systemctl enable "$SERVICE_MAIN" "$SERVICE_PROTO" >/dev/null
systemctl restart "$SERVICE_PROTO"
systemctl restart "$SERVICE_MAIN"
sleep 4

[[ "$(systemctl is-active "$SERVICE_MAIN")" == 'active' ]] || { journalctl -u "$SERVICE_MAIN" -n 80 --no-pager || true; die "$SERVICE_MAIN 未 active"; }
[[ "$(systemctl is-active "$SERVICE_PROTO")" == 'active' ]] || { journalctl -u "$SERVICE_PROTO" -n 80 --no-pager || true; die "$SERVICE_PROTO 未 active"; }
[[ "$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HTTP_PORT}/health")" == '200' ]] || die '主壳 /health 探活失败'
[[ "$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PROTOCOL_PORT}${PROTOCOL_PREFIX}/")" == '200' ]] || die '协议助手直连探活失败'
[[ "$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HTTP_PORT}${PROTOCOL_PREFIX}/")" == '200' ]] || die '协议助手反代探活失败'

log '安装验证通过：'
log "  webssh: $(systemctl is-active "$SERVICE_MAIN")"
log "  webssh-protocol: $(systemctl is-active "$SERVICE_PROTO")"
log "  health: $(curl -fsS "http://127.0.0.1:${HTTP_PORT}/health")"
log "  node: $($INSTALL_DIR/runtime/node/bin/node -p 'process.version + ":" + process.arch')"
log '  视频：复用现有 dcim/ZLMediaKit/WVP，不安装或重启第二套 MediaServer'
trap - ERR
