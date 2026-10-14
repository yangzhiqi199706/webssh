#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
fail() { echo "错误：$*" >&2; exit 1; }
BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ "$(id -u)" == 0 ]] || fail '请在宿主机使用 root 执行。'
for cmd in sha256sum readlink systemctl curl find; do command -v "$cmd" >/dev/null || fail "缺少命令：$cmd"; done
case "$(cat "$BUNDLE_DIR/ARCH"):$(uname -m)" in
  arm64:aarch64|arm64:arm64|x64:x86_64|x64:amd64) ;;
  *) fail '更新包架构与宿主机不匹配。' ;;
esac
(cd "$BUNDLE_DIR" && sha256sum -c SHA256SUMS) || fail '包内校验失败，未修改程序。'
APP_DIR="$(readlink -f -- "${WEBSSH_APP_DIR:-/opt/webssh/app}")"
NODE_BIN="${WEBSSH_NODE_BIN:-$(dirname -- "$APP_DIR")/runtime/node/bin/node}"
HEALTH_URL="${WEBSSH_HEALTH_URL:-http://127.0.0.1:3010/health}"
WORKER="$BUNDLE_DIR/update-files.js"
[[ -f "$APP_DIR/server.js" && -f "$APP_DIR/package.json" ]] || fail '未找到已安装的 WebSSH。'
[[ -x "$NODE_BIN" ]] || fail 'Node 运行时不可执行。'
[[ ! -L "$APP_DIR/.hotfix-backups" ]] || fail '备份目录不能是符号链接。'
LOCK_DIR="$APP_DIR/.b-alarm-db-hotfix.lock"
mkdir -- "$LOCK_DIR" || fail '已有热更新正在执行或遗留锁，请核查。'
BACKUP_DIR=''
CHANGED=0
wait_health() {
  local attempt
  for attempt in {1..10}; do
    if systemctl is-active --quiet webssh && curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
finish() {
  local status=$?
  trap - EXIT
  if [[ "$status" != 0 && "$CHANGED" == 1 ]]; then
    echo '更新失败，正在恢复全部原文件并撤销新增文件……' >&2
    if "$NODE_BIN" "$WORKER" restore "$APP_DIR" "$BACKUP_DIR" && systemctl restart webssh && wait_health; then
      echo '原文件已恢复，服务健康检查通过。' >&2
    else
      echo "自动恢复未完成，请检查服务日志。完整备份：$BACKUP_DIR" >&2
    fi
  fi
  rmdir -- "$LOCK_DIR" || true
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "${1:-}" == --rollback ]]; then
  [[ $# == 2 && "$2" =~ ^feature-sync-[0-9]{14}-[0-9]+$ ]] || fail '用法：bash install.sh --rollback 备份编号'
  BACKUP_DIR="$APP_DIR/.hotfix-backups/$2"
  "$NODE_BIN" "$WORKER" checkCurrent "$APP_DIR" "$BACKUP_DIR"
  "$NODE_BIN" "$WORKER" restore "$APP_DIR" "$BACKUP_DIR"
  systemctl restart webssh
  wait_health || fail '文件已恢复，但服务健康检查失败。'
  echo "回滚成功：$2"
  exit 0
fi
[[ $# == 0 ]] || fail '用法：bash install.sh，或 bash install.sh --rollback 备份编号'
systemctl is-active --quiet webssh || fail '原 webssh 服务未运行，请先检查服务。'
curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null || fail '更新前健康检查失败。'
"$NODE_BIN" --check "$WORKER"
while IFS= read -r -d '' file; do "$NODE_BIN" --check "$file"; done < <(find "$BUNDLE_DIR/payload" -type f -name '*.js' -print0)
"$NODE_BIN" "$WORKER" preflight "$APP_DIR" "$BUNDLE_DIR"
# SAX is delivered as pure JS; all other dependencies must already exist on the target.
"$NODE_BIN" -e 'const p=require("path"),r=require("module").createRequire(p.join(process.argv[1],"server.js")); for(const n of ["express","ws","ssh2","http-proxy","mysql2","net-snmp","pg","dmdb"]) r(n)' "$APP_DIR"
BACKUP_ID="feature-sync-$(date +%Y%m%d%H%M%S)-$$"
BACKUP_DIR="$APP_DIR/.hotfix-backups/$BACKUP_ID"
"$NODE_BIN" "$WORKER" prepare "$APP_DIR" "$BUNDLE_DIR" "$BACKUP_DIR"
CHANGED=1
"$NODE_BIN" "$WORKER" apply "$APP_DIR" "$BUNDLE_DIR" "$BACKUP_DIR"
"$NODE_BIN" "$WORKER" checkCurrent "$APP_DIR" "$BACKUP_DIR"
"$NODE_BIN" -e 'const p=require("path"),r=require("module").createRequire(p.join(process.argv[1],"server.js")); const c=r("./proto-conv/b-interface-forwarder").defaults; const a=r("./proto-conv/b-interface-mock-ack").generate(c); if(a.responseBody!=="${bAckEnvelope}" || !["LOGIN","LOGOUT","SEND_ALARM","SEND_HISALARM"].every(n=>a.script.includes(n))) throw Error("ACK生成验证失败"); r("./proto-conv/b-interface-routes"); console.log("ACK模块与路由验证通过")' "$APP_DIR"
systemctl restart webssh
wait_health || fail '更新后服务健康检查失败。'
CHANGED=0
echo "更新成功。备份编号：$BACKUP_ID"
echo "回滚命令：bash $BUNDLE_DIR/install.sh --rollback $BACKUP_ID"
echo '浏览器按 Ctrl+F5 刷新，再打开 B接口转发 → 接入配置 → SoapUI / 告警ACK自动响应。'
