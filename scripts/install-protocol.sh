#!/usr/bin/env bash
# install-protocol.sh —— 在目标机一次性安装协议助手服务
# 部署目录: /opt/webssh/protocol/
# 先决条件: /opt/webssh/ 已存在（webssh 主服务已部署）
#
# 用法（目标机 root 下）:
#   cd /root/webssh-protocol-<stamp>
#   chmod +x install-protocol.sh
#   ./install-protocol.sh
#
# 环境变量（一般不用动）:
#   INSTALL_DIR        默认 /opt/webssh
#   SERVICE_NAME       默认 webssh-protocol
#   RUN_USER           默认 root
#   PROTOCOL_PORT      默认 5000
#   PROTOCOL_PREFIX    默认 /protocol

set -euo pipefail

# 当前包的根目录（脚本所在目录）
PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INSTALL_DIR="${INSTALL_DIR:-/opt/webssh}"
SERVICE_NAME="${SERVICE_NAME:-webssh-protocol}"
RUN_USER="${RUN_USER:-root}"
PROTOCOL_PORT="${PROTOCOL_PORT:-5000}"
PROTOCOL_PREFIX="${PROTOCOL_PREFIX:-/protocol}"

PROTO_DIR="$INSTALL_DIR/protocol"
PROTO_APP_DIR="$PROTO_DIR/app"
PROTO_RUNTIME_DIR="$PROTO_DIR/runtime"
PROTO_PY_DIR="$PROTO_RUNTIME_DIR/python"
PROTO_SITE_PACKAGES="$PROTO_RUNTIME_DIR/site-packages"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { echo "[错误] $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "需要 root 权限"
command -v systemctl >/dev/null 2>&1 || die "缺少 systemctl"
[[ -d "$INSTALL_DIR" ]] || die "$INSTALL_DIR 不存在，请先安装 webssh 主服务"

# -------------------- 1. 检查包内素材 --------------------
log "检查离线包结构..."
PYTHON_TAR="$(ls "$PACKAGE_ROOT"/runtime/cpython-*-x86_64-unknown-linux-gnu-install_only.tar.gz 2>/dev/null | head -1 || true)"
[[ -n "$PYTHON_TAR" && -f "$PYTHON_TAR" ]] || die "未找到 runtime/cpython-*.tar.gz"
[[ -d "$PACKAGE_ROOT/wheels" ]] || die "未找到 wheels/ 目录"
[[ -f "$PACKAGE_ROOT/protocol_app/app.py" ]] || die "未找到 protocol_app/app.py"
[[ -f "$PACKAGE_ROOT/protocol_app/requirements.txt" ]] || die "未找到 protocol_app/requirements.txt"
[[ -f "$PACKAGE_ROOT/systemd/webssh-protocol.service.template" ]] || die "未找到 systemd unit 模板"

# -------------------- 2. 停旧服务（如果有） --------------------
if systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
  log "停止已有服务 $SERVICE_NAME ..."
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
fi

# -------------------- 3. 备份旧的 protocol 安装（如果有） --------------------
if [[ -d "$PROTO_DIR" ]]; then
  STAMP="$(date +%Y%m%d%H%M%S)"
  BACKUP_DIR="$INSTALL_DIR/protocol.bak-$STAMP"
  log "备份旧 protocol 目录 -> $BACKUP_DIR"
  mv "$PROTO_DIR" "$BACKUP_DIR"
fi

# -------------------- 4. 创建目录骨架 --------------------
log "创建目录骨架..."
mkdir -p "$PROTO_APP_DIR" "$PROTO_PY_DIR" "$PROTO_SITE_PACKAGES" \
  "$INSTALL_DIR/logs"

# -------------------- 5. 解压 Python 运行时 --------------------
log "解压 Python 运行时 -> $PROTO_PY_DIR"
# install_only tar 的顶层目录是 python/，解压后我们想要的是 python/bin/python3 等
# 先解到临时目录再 mv 进去
TMP_PY_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_PY_DIR"' EXIT
tar -xzf "$PYTHON_TAR" -C "$TMP_PY_DIR"
[[ -x "$TMP_PY_DIR/python/bin/python3" ]] || die "Python 解压失败：找不到 bin/python3"
# 把 python/* 的内容移到 PROTO_PY_DIR
shopt -s dotglob
mv "$TMP_PY_DIR/python/"* "$PROTO_PY_DIR/"
shopt -u dotglob
rm -rf "$TMP_PY_DIR"
trap - EXIT

PY_BIN="$PROTO_PY_DIR/bin/python3"
[[ -x "$PY_BIN" ]] || die "Python 解压后 $PY_BIN 不可执行"
log "Python 版本: $("$PY_BIN" --version 2>&1)"

# -------------------- 6. 离线 pip install 到 site-packages --------------------
log "离线安装 Python 依赖到 $PROTO_SITE_PACKAGES ..."
"$PY_BIN" -m pip install \
  --no-index \
  --no-deps \
  --find-links "$PACKAGE_ROOT/wheels" \
  --target "$PROTO_SITE_PACKAGES" \
  -r "$PACKAGE_ROOT/protocol_app/requirements.txt"

# 验证关键依赖能 import
log "验证关键依赖..."
PYTHONPATH="$PROTO_SITE_PACKAGES" "$PY_BIN" -c "
import sys
mods = ['flask', 'pandas', 'numpy', 'xlrd', 'xlwt', 'openpyxl', 'docx', 'lxml']
for m in mods:
    try:
        __import__(m)
        print('  OK', m)
    except Exception as e:
        print('  FAIL', m, '->', e)
        sys.exit(1)
"

# -------------------- 7. 部署 Flask 应用代码 --------------------
log "部署 Flask 应用代码 -> $PROTO_APP_DIR"
cp -a "$PACKAGE_ROOT/protocol_app/." "$PROTO_APP_DIR/"
# 运行时数据目录（每次安装都重置）
mkdir -p \
  "$PROTO_APP_DIR/uploads" \
  "$PROTO_APP_DIR/outputs" \
  "$PROTO_APP_DIR/downloads" \
  "$PROTO_APP_DIR/module4_uploads" \
  "$PROTO_APP_DIR/module4_downloads"
# module4_config 必须保留 j2k2 配置文件
[[ -f "$PROTO_APP_DIR/module4_config/j2k2_format_config.json" ]] || \
  die "缺少 module4_config/j2k2_format_config.json"

# -------------------- 8. 渲染并安装 systemd unit --------------------
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
log "写入 systemd unit -> $UNIT_FILE"
sed \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__RUN_USER__|$RUN_USER|g" \
  "$PACKAGE_ROOT/systemd/webssh-protocol.service.template" > "$UNIT_FILE"

# 端口和前缀如果用户改过，覆盖到 unit 里
if [[ "$PROTOCOL_PORT" != "5000" ]]; then
  sed -i "s|PROTOCOL_PORT=5000|PROTOCOL_PORT=$PROTOCOL_PORT|" "$UNIT_FILE"
fi
if [[ "$PROTOCOL_PREFIX" != "/protocol" ]]; then
  sed -i "s|PROTOCOL_PREFIX=/protocol|PROTOCOL_PREFIX=$PROTOCOL_PREFIX|" "$UNIT_FILE"
fi

# -------------------- 9. 权限 --------------------
chown -R "$RUN_USER":"$(id -gn "$RUN_USER")" "$PROTO_DIR"
chmod 755 "$PROTO_DIR" "$PROTO_APP_DIR" "$PROTO_RUNTIME_DIR"

# -------------------- 10. 启动并探活 --------------------
log "启用并启动 $SERVICE_NAME ..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

log "等待 3 秒后探活..."
sleep 3
ACTIVE="$(systemctl is-active "$SERVICE_NAME" || true)"
if [[ "$ACTIVE" != "active" ]]; then
  echo "服务未 active，最近日志："
  journalctl -u "$SERVICE_NAME" -n 50 --no-pager
  die "$SERVICE_NAME 未启动成功"
fi

HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PROTOCOL_PORT}${PROTOCOL_PREFIX}/" || true)"
if [[ "$HEALTH_CODE" != "200" ]]; then
  echo "Flask 健康检查失败，最近日志："
  journalctl -u "$SERVICE_NAME" -n 50 --no-pager
  die "GET http://127.0.0.1:${PROTOCOL_PORT}${PROTOCOL_PREFIX}/ -> ${HEALTH_CODE}"
fi

log "✅ 安装完成"
log "服务名: $SERVICE_NAME"
log "端口  : 127.0.0.1:${PROTOCOL_PORT}${PROTOCOL_PREFIX}/"
log "状态  : systemctl status $SERVICE_NAME --no-pager"
log "日志  : journalctl -u $SERVICE_NAME -n 100 --no-pager"
log "       tail -f $INSTALL_DIR/logs/protocol.out.log"
