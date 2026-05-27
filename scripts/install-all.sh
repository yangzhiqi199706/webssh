#!/usr/bin/env bash
# install-all.sh —— 全栈离线包一键安装：webssh 主壳 + 协议助手
#
# 离线包结构假设（脚本所在目录的相对路径）：
#   ./app/                 webssh 主壳代码（含 node_modules）
#   ./runtime/node/        Node.js 运行时
#   ./protocol/app/        Flask 应用代码（含 module4_config）
#   ./protocol/runtime/python/         CPython 3.11.10
#   ./protocol/runtime/site-packages/  Python 依赖
#   ./systemd/webssh.service.template
#   ./systemd/webssh-protocol.service.template
#   ./config/.env.example  webssh 主壳环境变量模板（可选）
#
# 用法（目标机 root 下）：
#   tar -xzf webssh-fullstack-offline-*.tar.gz
#   cd webssh-fullstack-offline-*/
#   chmod +x install-all.sh
#   ./install-all.sh
#
# 环境变量（一般不用动）：
#   INSTALL_DIR        默认 /opt/webssh
#   RUN_USER           默认 root
#   HTTP_PORT          webssh 主壳端口，默认 3010
#   PROTOCOL_PORT      协议助手端口，默认 5000
#   PROTOCOL_PREFIX    协议助手 URL 前缀，默认 /protocol
#   SERVICE_MAIN       主壳 systemd 服务名，默认 webssh
#   SERVICE_PROTO      协议助手 systemd 服务名，默认 webssh-protocol

set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INSTALL_DIR="${INSTALL_DIR:-/opt/webssh}"
RUN_USER="${RUN_USER:-root}"
HTTP_PORT="${HTTP_PORT:-3010}"
PROTOCOL_PORT="${PROTOCOL_PORT:-5000}"
PROTOCOL_PREFIX="${PROTOCOL_PREFIX:-/protocol}"
SERVICE_MAIN="${SERVICE_MAIN:-webssh}"
SERVICE_PROTO="${SERVICE_PROTO:-webssh-protocol}"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
die()  { echo "[错误] $*" >&2; exit 1; }
warn() { echo "[警告] $*" >&2; }

[[ "$(id -u)" -eq 0 ]] || die "需要 root 权限"
command -v systemctl >/dev/null 2>&1 || die "缺少 systemctl"
id "$RUN_USER" >/dev/null 2>&1 || die "运行用户不存在: $RUN_USER"

# -------------------- 1. 检查包内素材 --------------------
log "检查离线包结构..."
[[ -f "$PACKAGE_ROOT/app/server.js" ]]      || die "缺 app/server.js"
[[ -f "$PACKAGE_ROOT/app/index.html" ]]     || die "缺 app/index.html"
[[ -d "$PACKAGE_ROOT/app/node_modules" ]]   || die "缺 app/node_modules（请确保 http-proxy 等依赖已打入）"
[[ -x "$PACKAGE_ROOT/runtime/node/bin/node" ]]                    || die "缺 runtime/node/bin/node"
[[ -f "$PACKAGE_ROOT/protocol/app/app.py" ]]                      || die "缺 protocol/app/app.py"
[[ -f "$PACKAGE_ROOT/protocol/app/module4_config/j2k2_format_config.json" ]] || die "缺 module4_config/j2k2_format_config.json"
[[ -x "$PACKAGE_ROOT/protocol/runtime/python/bin/python3" ]]      || die "缺 protocol/runtime/python/bin/python3"
[[ -d "$PACKAGE_ROOT/protocol/runtime/site-packages" ]]           || die "缺 protocol/runtime/site-packages"
[[ -f "$PACKAGE_ROOT/systemd/webssh.service.template" ]]          || die "缺 systemd/webssh.service.template"
[[ -f "$PACKAGE_ROOT/systemd/webssh-protocol.service.template" ]] || die "缺 systemd/webssh-protocol.service.template"

# -------------------- 2. 停旧服务（如果有） --------------------
for svc in "$SERVICE_PROTO" "$SERVICE_MAIN"; do
  if systemctl list-unit-files | grep -q "^${svc}\.service"; then
    log "停止已有服务 $svc ..."
    systemctl stop "$svc" 2>/dev/null || true
  fi
done

# -------------------- 3. 备份旧安装（如果有） --------------------
STAMP="$(date +%Y%m%d%H%M%S)"
if [[ -d "$INSTALL_DIR/app" ]]; then
  log "备份旧 app -> $INSTALL_DIR/app.bak-$STAMP"
  mv "$INSTALL_DIR/app" "$INSTALL_DIR/app.bak-$STAMP"
fi
if [[ -d "$INSTALL_DIR/protocol" ]]; then
  log "备份旧 protocol -> $INSTALL_DIR/protocol.bak-$STAMP"
  mv "$INSTALL_DIR/protocol" "$INSTALL_DIR/protocol.bak-$STAMP"
fi
if [[ -d "$INSTALL_DIR/runtime/node" && ! -L "$INSTALL_DIR/runtime/node" ]]; then
  log "备份旧 runtime/node -> $INSTALL_DIR/runtime/node.bak-$STAMP"
  mv "$INSTALL_DIR/runtime/node" "$INSTALL_DIR/runtime/node.bak-$STAMP"
fi

# -------------------- 4. 创建骨架并复制 --------------------
log "部署主壳 -> $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/logs" "$INSTALL_DIR/run" "$INSTALL_DIR/config" "$INSTALL_DIR/runtime"
cp -a "$PACKAGE_ROOT/app"          "$INSTALL_DIR/"
cp -a "$PACKAGE_ROOT/runtime/node" "$INSTALL_DIR/runtime/node"
mkdir -p "$INSTALL_DIR/systemd" "$INSTALL_DIR/scripts"
cp -a "$PACKAGE_ROOT/systemd/." "$INSTALL_DIR/systemd/"
if [[ -d "$PACKAGE_ROOT/scripts" ]]; then
  cp -a "$PACKAGE_ROOT/scripts/." "$INSTALL_DIR/scripts/"
fi
# 把 uninstall-all.sh 也放到 INSTALL_DIR 根，方便日后直接调用
if [[ -f "$PACKAGE_ROOT/uninstall-all.sh" ]]; then
  cp -a "$PACKAGE_ROOT/uninstall-all.sh" "$INSTALL_DIR/uninstall-all.sh"
  chmod +x "$INSTALL_DIR/uninstall-all.sh"
fi

# 主壳 .env
if [[ ! -f "$INSTALL_DIR/config/.env" ]]; then
  if [[ -f "$PACKAGE_ROOT/config/.env.example" ]]; then
    cp "$PACKAGE_ROOT/config/.env.example" "$INSTALL_DIR/config/.env"
  else
    : > "$INSTALL_DIR/config/.env"
  fi
fi
if grep -q '^PORT=' "$INSTALL_DIR/config/.env"; then
  sed -i "s/^PORT=.*/PORT=$HTTP_PORT/" "$INSTALL_DIR/config/.env"
else
  printf '\nPORT=%s\n' "$HTTP_PORT" >> "$INSTALL_DIR/config/.env"
fi
# 协议助手反代地址，让 server.js 知道往哪转
if grep -q '^PROTOCOL_TARGET=' "$INSTALL_DIR/config/.env"; then
  sed -i "s|^PROTOCOL_TARGET=.*|PROTOCOL_TARGET=http://127.0.0.1:$PROTOCOL_PORT|" "$INSTALL_DIR/config/.env"
else
  printf 'PROTOCOL_TARGET=http://127.0.0.1:%s\n' "$PROTOCOL_PORT" >> "$INSTALL_DIR/config/.env"
fi

# install.env（start.sh / stop.sh / status.sh 读这个）
cat > "$INSTALL_DIR/config/install.env" <<EOF
INSTALL_DIR=$INSTALL_DIR
SERVICE_NAME=$SERVICE_MAIN
RUN_USER=$RUN_USER
EOF

# -------------------- 5. 部署协议助手 --------------------
log "部署协议助手 -> $INSTALL_DIR/protocol"
mkdir -p "$INSTALL_DIR/protocol/runtime"
cp -a "$PACKAGE_ROOT/protocol/app"                    "$INSTALL_DIR/protocol/"
cp -a "$PACKAGE_ROOT/protocol/runtime/python"         "$INSTALL_DIR/protocol/runtime/"
cp -a "$PACKAGE_ROOT/protocol/runtime/site-packages"  "$INSTALL_DIR/protocol/runtime/"

# 运行时数据目录
mkdir -p \
  "$INSTALL_DIR/protocol/app/uploads" \
  "$INSTALL_DIR/protocol/app/outputs" \
  "$INSTALL_DIR/protocol/app/downloads" \
  "$INSTALL_DIR/protocol/app/module4_uploads" \
  "$INSTALL_DIR/protocol/app/module4_downloads"

# 验证关键依赖能 import
log "验证 Python 依赖..."
PY_BIN="$INSTALL_DIR/protocol/runtime/python/bin/python3"
PYTHONPATH="$INSTALL_DIR/protocol/runtime/site-packages" "$PY_BIN" - <<'PYCHECK'
import sys
mods = ['flask', 'pandas', 'numpy', 'xlrd', 'xlwt', 'openpyxl', 'docx', 'lxml']
fails = []
for m in mods:
    try:
        __import__(m); print('  OK', m)
    except Exception as e:
        print('  FAIL', m, '->', e); fails.append(m)
sys.exit(1 if fails else 0)
PYCHECK

# -------------------- 6. 渲染 systemd unit --------------------
log "写入 systemd unit..."
sed \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__RUN_USER__|$RUN_USER|g" \
  "$PACKAGE_ROOT/systemd/webssh.service.template" \
  > "/etc/systemd/system/${SERVICE_MAIN}.service"

sed \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__RUN_USER__|$RUN_USER|g" \
  "$PACKAGE_ROOT/systemd/webssh-protocol.service.template" \
  > "/etc/systemd/system/${SERVICE_PROTO}.service"

# 端口/前缀如果用户改了，覆盖到协议助手 unit
if [[ "$PROTOCOL_PORT" != "5000" ]]; then
  sed -i "s|PROTOCOL_PORT=5000|PROTOCOL_PORT=$PROTOCOL_PORT|" "/etc/systemd/system/${SERVICE_PROTO}.service"
fi
if [[ "$PROTOCOL_PREFIX" != "/protocol" ]]; then
  sed -i "s|PROTOCOL_PREFIX=/protocol|PROTOCOL_PREFIX=$PROTOCOL_PREFIX|" "/etc/systemd/system/${SERVICE_PROTO}.service"
fi

# -------------------- 7. 权限 --------------------
chown -R "$RUN_USER":"$(id -gn "$RUN_USER")" "$INSTALL_DIR"
[[ -d "$INSTALL_DIR/scripts" ]] && chmod +x "$INSTALL_DIR/scripts/"*.sh 2>/dev/null || true

# -------------------- 8. 启动并探活 --------------------
log "启用并启动服务..."
systemctl daemon-reload
systemctl enable "$SERVICE_MAIN" "$SERVICE_PROTO" >/dev/null
systemctl restart "$SERVICE_MAIN"
systemctl restart "$SERVICE_PROTO"

log "等待 4 秒后探活..."
sleep 4

for svc in "$SERVICE_MAIN" "$SERVICE_PROTO"; do
  ACTIVE="$(systemctl is-active "$svc" || true)"
  if [[ "$ACTIVE" != "active" ]]; then
    echo "服务 $svc 未 active，最近日志："
    journalctl -u "$svc" -n 50 --no-pager
    die "$svc 未启动成功"
  fi
done

# 主壳 /health
HEALTH_MAIN="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HTTP_PORT}/health" || true)"
[[ "$HEALTH_MAIN" == "200" ]] || die "主壳 /health -> ${HEALTH_MAIN}"

# 协议助手直连
HEALTH_PROTO_DIRECT="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PROTOCOL_PORT}${PROTOCOL_PREFIX}/" || true)"
[[ "$HEALTH_PROTO_DIRECT" == "200" ]] || die "协议助手直连 -> ${HEALTH_PROTO_DIRECT}"

# 协议助手反代
HEALTH_PROTO_PROXY="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HTTP_PORT}${PROTOCOL_PREFIX}/" || true)"
[[ "$HEALTH_PROTO_PROXY" == "200" ]] || die "协议助手反代 -> ${HEALTH_PROTO_PROXY}"

# -------------------- 9. 防火墙（可选） --------------------
if systemctl is-active firewalld >/dev/null 2>&1; then
  log "firewalld 运行中，开放 ${HTTP_PORT}/tcp"
  firewall-cmd --permanent --add-port="${HTTP_PORT}/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

log ""
log "✅ 安装完成"
log "   主壳     systemctl status $SERVICE_MAIN  --no-pager"
log "   协议助手 systemctl status $SERVICE_PROTO --no-pager"
log "   日志     tail -f $INSTALL_DIR/logs/webssh.out.log"
log "           tail -f $INSTALL_DIR/logs/protocol.out.log"
log ""
log "   浏览器访问：http://<host>:${HTTP_PORT}/  → 左栏「协议助手」"
