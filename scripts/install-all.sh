#!/usr/bin/env bash
# install-all.sh —— 全栈离线包一键安装：webssh 主壳 + 协议助手 + 视频媒体服务（可选）
#
# 离线包结构假设（脚本所在目录的相对路径）：
#   ./app/                 webssh 主壳代码（含 node_modules，含 video/ 子站）
#   ./runtime/node/        Node.js 运行时
#   ./protocol/app/        Flask 应用代码（含 module4_config）
#   ./protocol/runtime/python/         CPython 3.11.10
#   ./protocol/runtime/site-packages/  Python 依赖
#   ./mediaserver/         （可选）ZLMediaKit MediaServer 二进制 + config.ini.example
#                          —— 若包内有 MediaServer*.tar.gz 则解压后覆盖
#                          —— 若包内有 MediaServer 可执行文件则直接使用
#                          —— 若包内目录不存在或为空，跳过视频媒体服务（视频监控功能不可用，但其他功能正常）
#   ./systemd/webssh.service.template
#   ./systemd/webssh-protocol.service.template
#   ./systemd/webssh-mediaserver.service.template   （可选，与 mediaserver/ 一起出现）
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
#   SERVICE_MEDIA      媒体服务 systemd 服务名，默认 webssh-mediaserver
#   SIP_PORT           SIP 信令端口，默认 5060（UDP+TCP 都开放）
#   RTP_PORT_RANGE     RTP 收流端口段，默认 30000-30100
#   ZLM_HTTP_PORT      ZLM HTTP-FLV 端口，默认 18080（仅本机，由 webssh 反代）
#   ZLM_API_PORT       ZLM HTTP API 端口，默认 8000（仅本机）

set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INSTALL_DIR="${INSTALL_DIR:-/opt/webssh}"
RUN_USER="${RUN_USER:-root}"
HTTP_PORT="${HTTP_PORT:-3010}"
PROTOCOL_PORT="${PROTOCOL_PORT:-5000}"
PROTOCOL_PREFIX="${PROTOCOL_PREFIX:-/protocol}"
SERVICE_MAIN="${SERVICE_MAIN:-webssh}"
SERVICE_PROTO="${SERVICE_PROTO:-webssh-protocol}"
SERVICE_MEDIA="${SERVICE_MEDIA:-webssh-mediaserver}"
SIP_PORT="${SIP_PORT:-5060}"
RTP_PORT_RANGE="${RTP_PORT_RANGE:-30000-30100}"
ZLM_HTTP_PORT="${ZLM_HTTP_PORT:-18080}"
ZLM_API_PORT="${ZLM_API_PORT:-8000}"

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

# 视频媒体服务（可选）：检测 ./mediaserver/ 是否带了 MediaServer 二进制或 tar.gz
INSTALL_MEDIA="0"
if [[ -d "$PACKAGE_ROOT/mediaserver" ]]; then
  if [[ -x "$PACKAGE_ROOT/mediaserver/MediaServer" ]]; then
    INSTALL_MEDIA="1"
    log "检测到 mediaserver/MediaServer，视频监控功能将启用"
  elif compgen -G "$PACKAGE_ROOT/mediaserver/MediaServer*.tar.gz" > /dev/null; then
    INSTALL_MEDIA="1"
    log "检测到 mediaserver/MediaServer*.tar.gz，将解压后启用视频监控"
  else
    warn "mediaserver/ 目录存在但没有 MediaServer 二进制或 tar.gz，跳过视频监控"
  fi
fi
if [[ "$INSTALL_MEDIA" == "1" && ! -f "$PACKAGE_ROOT/systemd/webssh-mediaserver.service.template" ]]; then
  warn "缺 systemd/webssh-mediaserver.service.template，跳过视频监控（包不完整）"
  INSTALL_MEDIA="0"
fi

# -------------------- 2. 停旧服务（如果有） --------------------
for svc in "$SERVICE_PROTO" "$SERVICE_MAIN" "$SERVICE_MEDIA"; do
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
if [[ "$INSTALL_MEDIA" == "1" && -d "$INSTALL_DIR/mediaserver" ]]; then
  log "备份旧 mediaserver -> $INSTALL_DIR/mediaserver.bak-$STAMP"
  mv "$INSTALL_DIR/mediaserver" "$INSTALL_DIR/mediaserver.bak-$STAMP"
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

# -------------------- 5.5 部署视频媒体服务（可选） --------------------
if [[ "$INSTALL_MEDIA" == "1" ]]; then
  log "部署视频媒体服务 -> $INSTALL_DIR/mediaserver"
  mkdir -p "$INSTALL_DIR/mediaserver"

  # 二选一：tar.gz 解压 / 直接复制目录
  if compgen -G "$PACKAGE_ROOT/mediaserver/MediaServer*.tar.gz" > /dev/null; then
    ZLM_TAR="$(ls "$PACKAGE_ROOT/mediaserver/"MediaServer*.tar.gz | sort | tail -n 1)"
    log "  解压 $ZLM_TAR ..."
    tar -xzf "$ZLM_TAR" -C "$INSTALL_DIR/mediaserver/" --strip-components=0 || \
      tar -xzf "$ZLM_TAR" -C "$INSTALL_DIR/mediaserver/"
    # 兼容 tar 内带子目录的情形
    if [[ ! -x "$INSTALL_DIR/mediaserver/MediaServer" ]]; then
      INNER="$(find "$INSTALL_DIR/mediaserver" -maxdepth 3 -name MediaServer -type f -executable | head -n 1)"
      if [[ -n "$INNER" ]]; then
        cp -a "$(dirname "$INNER")/." "$INSTALL_DIR/mediaserver/"
      fi
    fi
  else
    cp -a "$PACKAGE_ROOT/mediaserver/." "$INSTALL_DIR/mediaserver/"
  fi
  chmod +x "$INSTALL_DIR/mediaserver/MediaServer" 2>/dev/null || true
  [[ -x "$INSTALL_DIR/mediaserver/MediaServer" ]] || die "MediaServer 可执行文件不存在或无 +x"

  # 生成 secret 并写 config.ini
  SECRET="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | xxd -p -c 16)"
  CONF="$INSTALL_DIR/mediaserver/config.ini"
  if [[ ! -f "$CONF" ]]; then
    # 没现成 config.ini 就写一份最小可用的
    cat > "$CONF" <<EOF
[hook]
enable=1
admin_params=secret=${SECRET}
on_server_keepalive=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=keepalive
on_publish=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=publish
on_play=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=play
on_stream_changed=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=stream_changed
on_stream_none_reader=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=stream_none_reader
on_send_rtp_stopped=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=send_rtp_stopped
on_rtp_server_timeout=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=rtp_server_timeout

[gb28181]
serverId=34020000002000000001
serverDomain=3402000000
serverPort=${SIP_PORT}
authPwd=12345678
keepaliveInterval=60
keepaliveExpires=3

[api]
secret=${SECRET}

[http]
port=${ZLM_HTTP_PORT}

[rtp_proxy]
port_range=${RTP_PORT_RANGE}
EOF
    log "  生成新 config.ini（含随机 secret）"
  else
    # 已有 config.ini：只刷新 secret + webhook 地址 + 端口（其他保留）
    sed -i \
      -e "s|^secret=.*|secret=${SECRET}|" \
      -e "s|^admin_params=.*|admin_params=secret=${SECRET}|" \
      -e "s|^on_server_keepalive=.*|on_server_keepalive=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=keepalive|" \
      -e "s|^on_publish=.*|on_publish=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=publish|" \
      -e "s|^on_play=.*|on_play=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=play|" \
      -e "s|^on_stream_changed=.*|on_stream_changed=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=stream_changed|" \
      -e "s|^on_stream_none_reader=.*|on_stream_none_reader=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=stream_none_reader|" \
      -e "s|^on_send_rtp_stopped=.*|on_send_rtp_stopped=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=send_rtp_stopped|" \
      -e "s|^on_rtp_server_timeout=.*|on_rtp_server_timeout=http://127.0.0.1:${HTTP_PORT}/api/video/zlm/webhook?event=rtp_server_timeout|" \
      "$CONF"
    log "  已刷新 config.ini 中的 secret + webhook 地址"
  fi

  # 把 secret 同步写到 webssh 主壳的 config/video-28181.json
  mkdir -p "$INSTALL_DIR/config"
  VC="$INSTALL_DIR/config/video-28181.json"
  if [[ ! -f "$VC" ]]; then
    cat > "$VC" <<EOF
{
  "sip": {
    "serverId": "34020000002000000001",
    "serverDomain": "3402000000",
    "localPort": ${SIP_PORT},
    "transport": "UDP",
    "authPwd": "12345678",
    "keepaliveInterval": 60,
    "keepaliveTimeout": 3,
    "registerExpires": 3600,
    "protocolVersion": "GB/T28181-2016",
    "streamIndex": "main",
    "whitelist": []
  },
  "zlm": {
    "apiBase": "http://127.0.0.1:${ZLM_API_PORT}",
    "secret": "${SECRET}",
    "publicHost": ""
  }
}
EOF
    chmod 600 "$VC"
    log "  生成新 video-28181.json"
  else
    # 仅更新 secret（用 python 改 JSON 更安全，没 python 就回退用 sed）
    if command -v python3 >/dev/null 2>&1; then
      python3 - <<PYUPD
import json, os
p = os.environ['VC']
with open(p, 'r', encoding='utf-8') as f: d = json.load(f)
d.setdefault('zlm', {})['secret'] = os.environ['SECRET']
with open(p, 'w', encoding='utf-8') as f: json.dump(d, f, ensure_ascii=False, indent=2); f.write('\n')
PYUPD
      log "  已更新 video-28181.json 的 zlm.secret"
    else
      sed -i "s|\"secret\":[[:space:]]*\"[^\"]*\"|\"secret\": \"${SECRET}\"|" "$VC" || true
    fi
    chmod 600 "$VC" || true
  fi

  # 给 video 子站准备运行时目录（vendor/flv.min.js 由打包脚本塞入）
  if [[ ! -f "$INSTALL_DIR/app/video/vendor/flv.min.js" ]]; then
    warn "缺 video/vendor/flv.min.js，前端 flv.js 播放器将无法工作。请手动放置后再访问视频监控页"
  fi
fi

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

if [[ "$INSTALL_MEDIA" == "1" ]]; then
  sed \
    -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    -e "s|__RUN_USER__|$RUN_USER|g" \
    "$PACKAGE_ROOT/systemd/webssh-mediaserver.service.template" \
    > "/etc/systemd/system/${SERVICE_MEDIA}.service"
fi

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
if [[ "$INSTALL_MEDIA" == "1" ]]; then
  systemctl enable "$SERVICE_MEDIA" "$SERVICE_MAIN" "$SERVICE_PROTO" >/dev/null
  systemctl restart "$SERVICE_MEDIA"
  sleep 2
fi
systemctl enable "$SERVICE_MAIN" "$SERVICE_PROTO" >/dev/null
systemctl restart "$SERVICE_MAIN"
systemctl restart "$SERVICE_PROTO"

log "等待 4 秒后探活..."
sleep 4

CHECK_SVCS=("$SERVICE_MAIN" "$SERVICE_PROTO")
[[ "$INSTALL_MEDIA" == "1" ]] && CHECK_SVCS+=("$SERVICE_MEDIA")
for svc in "${CHECK_SVCS[@]}"; do
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

# 媒体服务（可选）
if [[ "$INSTALL_MEDIA" == "1" ]]; then
  HEALTH_ZLM="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${ZLM_HTTP_PORT}/" || true)"
  if [[ "$HEALTH_ZLM" != "200" && "$HEALTH_ZLM" != "404" ]]; then
    warn "ZLM HTTP-FLV 端口 ${ZLM_HTTP_PORT} 探活返回 ${HEALTH_ZLM}（不致命，但请检查 mediaserver 配置）"
  fi
fi

# -------------------- 9. 防火墙（可选） --------------------
if systemctl is-active firewalld >/dev/null 2>&1; then
  log "firewalld 运行中，开放 ${HTTP_PORT}/tcp"
  firewall-cmd --permanent --add-port="${HTTP_PORT}/tcp" >/dev/null 2>&1 || true
  if [[ "$INSTALL_MEDIA" == "1" ]]; then
    log "  视频监控：开放 ${SIP_PORT}/{tcp,udp} + ${RTP_PORT_RANGE}/udp"
    firewall-cmd --permanent --add-port="${SIP_PORT}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-port="${SIP_PORT}/udp" >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-port="${RTP_PORT_RANGE}/udp" >/dev/null 2>&1 || true
  fi
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

log ""
log "✅ 安装完成"
log "   主壳     systemctl status $SERVICE_MAIN  --no-pager"
log "   协议助手 systemctl status $SERVICE_PROTO --no-pager"
[[ "$INSTALL_MEDIA" == "1" ]] && \
log "   媒体服务 systemctl status $SERVICE_MEDIA --no-pager"
log "   日志     tail -f $INSTALL_DIR/logs/webssh.out.log"
log "           tail -f $INSTALL_DIR/logs/protocol.out.log"
[[ "$INSTALL_MEDIA" == "1" ]] && \
log "           tail -f $INSTALL_DIR/logs/mediaserver.out.log"
log ""
log "   浏览器访问：http://<host>:${HTTP_PORT}/  → 左栏「协议助手」/「视频监控」"
