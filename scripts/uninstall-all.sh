#!/usr/bin/env bash
# uninstall-all.sh —— 全栈一键卸载：webssh 主壳 + 协议助手
#
# 默认会：
#   1. 停止并 disable 双 systemd 服务
#   2. 删除两个 unit 文件 + daemon-reload
#   3. 删除 /opt/webssh/{app,protocol,runtime,scripts,systemd,run} 等
#   4. 默认会保留 logs/ 和 config/，避免误删审计日志/配置
#
# 用法：
#   chmod +x uninstall-all.sh
#   ./uninstall-all.sh                 # 默认保留 logs + config + 历史 .bak-* 备份
#   ./uninstall-all.sh --purge         # 全清，连 logs / config / 备份目录一起删
#   ./uninstall-all.sh --keep-backups  # 仅删主目录，保留所有 .bak-* 备份
#
# 环境变量：
#   INSTALL_DIR     默认 /opt/webssh
#   SERVICE_MAIN    默认 webssh
#   SERVICE_PROTO   默认 webssh-protocol

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/webssh}"
SERVICE_MAIN="${SERVICE_MAIN:-webssh}"
SERVICE_PROTO="${SERVICE_PROTO:-webssh-protocol}"

PURGE="0"
KEEP_BACKUPS="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge)         PURGE="1"; shift ;;
    --keep-backups)  KEEP_BACKUPS="1"; shift ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *)
      echo "未知参数: $1" >&2
      exit 1 ;;
  esac
done

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "[警告] $*" >&2; }

[[ "$(id -u)" -eq 0 ]] || { echo "需要 root 权限" >&2; exit 1; }

# -------------------- 1. 停止并 disable 服务（顺序：先 protocol 再 main，避免 PartOf 二次触发） --------------------
for svc in "$SERVICE_PROTO" "$SERVICE_MAIN"; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${svc}\.service"; then
    log "停止 $svc ..."
    systemctl stop    "$svc" 2>/dev/null || true
    systemctl disable "$svc" 2>/dev/null || true
  else
    log "$svc 未注册，跳过"
  fi
done

# -------------------- 2. 删除 systemd unit --------------------
for svc in "$SERVICE_PROTO" "$SERVICE_MAIN"; do
  UNIT="/etc/systemd/system/${svc}.service"
  if [[ -f "$UNIT" ]]; then
    log "删除 unit: $UNIT"
    rm -f "$UNIT"
  fi
done
command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true

# -------------------- 3. 删除运行时目录 --------------------
if [[ ! -d "$INSTALL_DIR" ]]; then
  log "$INSTALL_DIR 不存在，无需清理目录"
  log "✅ 卸载完成"
  exit 0
fi

log "清理 $INSTALL_DIR 下子目录..."

# 必删项：代码、运行时、systemd 模板、脚本、运行时数据
for sub in app protocol runtime scripts systemd run release; do
  if [[ -e "$INSTALL_DIR/$sub" ]]; then
    log "  删除 $INSTALL_DIR/$sub"
    rm -rf "$INSTALL_DIR/$sub"
  fi
done

# 历史备份（app.bak-* / protocol.bak-* / runtime/node.bak-*）
if [[ "$KEEP_BACKUPS" != "1" && "$PURGE" != "1" ]]; then
  log "保留历史备份（如不想保留，加 --purge）"
elif [[ "$KEEP_BACKUPS" != "1" ]]; then
  for bak in "$INSTALL_DIR"/*.bak-*; do
    [[ -e "$bak" ]] || continue
    log "  删除备份 $bak"
    rm -rf "$bak"
  done
fi

# 配置 + 日志：默认保留，--purge 全清
if [[ "$PURGE" == "1" ]]; then
  for sub in config logs; do
    if [[ -e "$INSTALL_DIR/$sub" ]]; then
      log "  --purge 删除 $INSTALL_DIR/$sub"
      rm -rf "$INSTALL_DIR/$sub"
    fi
  done
  # 整目录如果空了也一起删
  rmdir "$INSTALL_DIR" 2>/dev/null && log "  $INSTALL_DIR 已空，已删除" || true
else
  log "保留 $INSTALL_DIR/{config,logs}（如需全清，加 --purge）"
fi

# -------------------- 4. 防火墙提示（不主动改）--------------------
if systemctl is-active firewalld >/dev/null 2>&1; then
  warn "firewalld 仍在运行。如已开放过 webssh 端口（默认 3010），可手动收回："
  warn "  firewall-cmd --permanent --remove-port=3010/tcp && firewall-cmd --reload"
fi

log ""
log "✅ 卸载完成"
log "   服务状态: systemctl is-active $SERVICE_MAIN $SERVICE_PROTO 应输出 inactive"
log "   残留目录: ls -la $INSTALL_DIR 2>/dev/null"
