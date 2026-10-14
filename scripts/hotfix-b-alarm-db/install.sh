#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() { echo "错误：$*" >&2; exit 1; }
BUNDLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ "$(id -u)" == 0 ]] || fail '请在宿主机使用 root 执行。'
for cmd in sha256sum readlink systemctl curl mktemp; do
  command -v "$cmd" >/dev/null || fail "缺少命令：$cmd"
done
case "$(cat "$BUNDLE_DIR/ARCH"):$(uname -m)" in
  arm64:aarch64|arm64:arm64|x64:x86_64|x64:amd64) ;;
  *) fail '更新包架构与宿主机不匹配。' ;;
esac
(cd "$BUNDLE_DIR" && sha256sum -c SHA256SUMS) || fail '更新包内部校验失败，未修改程序。'

APP_DIR="$(readlink -f -- "${WEBSSH_APP_DIR:-/opt/webssh/app}")"
NODE_BIN="${WEBSSH_NODE_BIN:-$(dirname -- "$APP_DIR")/runtime/node/bin/node}"
HEALTH_URL="${WEBSSH_HEALTH_URL:-http://127.0.0.1:3010/health}"
TARGET="$APP_DIR/proto-conv/b-interface-alarm-db.js"
PAYLOAD="$BUNDLE_DIR/payload/b-interface-alarm-db.js"
BACKUP_ROOT="$APP_DIR/.hotfix-backups"
[[ -f "$APP_DIR/server.js" && -f "$TARGET" ]] || fail '目标机尚未安装包含 B 接口的 WebSSH，不能应用此补丁。'
[[ ! -L "$TARGET" && "$(readlink -f -- "$(dirname -- "$TARGET")")" == "$APP_DIR/proto-conv" ]] || fail '目标文件或目录存在符号链接，拒绝覆盖。'
[[ ! -L "$BACKUP_ROOT" ]] || fail '备份目录不能是符号链接。'
[[ -x "$NODE_BIN" ]] || fail "Node 运行时不可执行：$NODE_BIN"
systemctl is-active --quiet webssh || fail 'webssh 服务当前未运行，请先排除原有服务问题。'
curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null || fail '更新前健康检查失败，未修改程序。'

TMP_FILE=''
BACKUP_DIR=''
CHANGED=0
LOCK_DIR="$APP_DIR/.b-alarm-db-hotfix.lock"
mkdir -- "$LOCK_DIR" || fail '另一更新正在执行，或有遗留锁；请核查后再执行。'
restore_backup() {
  (cd "$BACKUP_DIR" && sha256sum -c ORIGINAL.sha256) || return 1
  TMP_FILE="$(mktemp "$TARGET.restore.XXXXXX")" || return 1
  cp -p -- "$BACKUP_DIR/original.js" "$TMP_FILE" || return 1
  mv -f -- "$TMP_FILE" "$TARGET" || return 1
  TMP_FILE=''
}
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
    echo '更新验证失败，正在恢复原文件……' >&2
    if restore_backup && systemctl restart webssh && wait_health; then
      echo '原文件已恢复，服务健康检查通过。' >&2
    else
      echo "自动恢复未完成，请检查服务日志。原文件备份：$BACKUP_DIR/original.js" >&2
    fi
  fi
  if [[ -n "$TMP_FILE" && -f "$TMP_FILE" ]]; then rm -f -- "$TMP_FILE"; fi
  rmdir -- "$LOCK_DIR" || true
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "${1:-}" == --rollback ]]; then
  [[ $# == 2 && "$2" =~ ^b-alarm-db-[0-9]{14}-[0-9]+$ ]] || fail '用法：bash install.sh --rollback 备份编号'
  BACKUP_DIR="$BACKUP_ROOT/$2"
  [[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || fail '指定备份不存在或不是普通目录。'
  [[ "$(readlink -f -- "$BACKUP_DIR")" == "$BACKUP_DIR" ]] || fail '备份路径异常。'
  [[ "$(sha256sum "$TARGET" | cut -d ' ' -f1)" == "$(cat "$BACKUP_DIR/installed.sha256")" ]] || fail '程序已发生后续更新，拒绝覆盖；请人工核对备份。'
  "$NODE_BIN" --check "$BACKUP_DIR/original.js"
  restore_backup || fail '备份校验或恢复失败。'
  systemctl restart webssh
  wait_health || fail '原文件已恢复，但服务健康检查失败，请检查服务日志。'
  echo "回滚成功：$2"
  exit 0
fi
[[ $# == 0 ]] || fail '用法：bash install.sh，或 bash install.sh --rollback 备份编号'
"$NODE_BIN" --check "$PAYLOAD"
"$NODE_BIN" -e 'const m=require(process.argv[1]); if(typeof m.read!=="function") process.exit(1)' "$TARGET" || fail '现有 B 接口模块或依赖异常，未覆盖程序。'

mkdir -p -- "$BACKUP_ROOT"
BACKUP_ID="b-alarm-db-$(date +%Y%m%d%H%M%S)-$$"
BACKUP_DIR="$BACKUP_ROOT/$BACKUP_ID"
mkdir -m 700 -- "$BACKUP_DIR"
cp -p -- "$TARGET" "$BACKUP_DIR/original.js"
(cd "$BACKUP_DIR" && sha256sum original.js > ORIGINAL.sha256)
sha256sum "$PAYLOAD" | cut -d ' ' -f1 > "$BACKUP_DIR/installed.sha256"
TMP_FILE="$(mktemp "$TARGET.update.XXXXXX")"
cp -p -- "$TARGET" "$TMP_FILE"
cat "$PAYLOAD" > "$TMP_FILE"
cmp -s -- "$PAYLOAD" "$TMP_FILE" || fail '暂存文件与补丁不一致。'
mv -f -- "$TMP_FILE" "$TARGET"
TMP_FILE=''
CHANGED=1
systemctl restart webssh
wait_health || fail '更新后健康检查失败。'
CHANGED=0
echo "更新成功。备份编号：$BACKUP_ID"
echo "回滚命令：bash $BUNDLE_DIR/install.sh --rollback $BACKUP_ID"
echo '请在 B 接口中重新点击“批量读取告警定义”，确认实际设备读取结果。'
