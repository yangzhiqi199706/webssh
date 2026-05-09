#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
BUILD_ROOT="$ROOT_DIR/.offline-build"
DOWNLOAD_ROOT="$ROOT_DIR/.offline-downloads"
APP_NAME="${APP_NAME:-webssh}"
PLATFORM="${PLATFORM:-linux-x64}"
NPM_CMD="${NPM_CMD:-npm}"
NODE_RUNTIME_DIR="${NODE_RUNTIME_DIR:-}"
NODE_VERSION="${NODE_VERSION:-12.22.12}"
NODE_ARCHIVE_NAME="node-v${NODE_VERSION}-${PLATFORM}"
NODE_ARCHIVE_PATH="$DOWNLOAD_ROOT/${NODE_ARCHIVE_NAME}.tar.xz"
NODE_DOWNLOAD_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE_NAME}.tar.xz"

if [[ -f "$ROOT_DIR/package.json" ]]; then
  APP_SRC_DIR="$ROOT_DIR"
elif [[ -f "$ROOT_DIR/app/package.json" ]]; then
  APP_SRC_DIR="$ROOT_DIR/app"
else
  echo "未找到 package.json，既不在根目录，也不在 app/ 目录。" >&2
  exit 1
fi

APP_VERSION="${APP_VERSION:-$(awk -F '"' '/"version"/ { print $4; exit }' "$APP_SRC_DIR/package.json")}"
RELEASE_NAME="${APP_NAME}-offline-${PLATFORM}-v${APP_VERSION}"
RELEASE_DIR="$BUILD_ROOT/$RELEASE_NAME"
ARCHIVE_PATH="$DIST_DIR/${RELEASE_NAME}.tar.gz"

require_file() {
  local file_path="$1"
  if [[ ! -f "$file_path" ]]; then
    echo "缺少文件: $file_path" >&2
    exit 1
  fi
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "缺少命令: $cmd" >&2
    exit 1
  fi
}

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "此脚本需要在 Linux 构建机上运行，避免把 Windows 依赖打入离线包。" >&2
  exit 1
fi

require_cmd tar
require_cmd curl

prepare_official_node() {
  if [[ -n "$NODE_RUNTIME_DIR" ]]; then
    if [[ ! -x "$NODE_RUNTIME_DIR/bin/node" ]]; then
      echo "NODE_RUNTIME_DIR 下未找到可执行的 bin/node: $NODE_RUNTIME_DIR" >&2
      exit 1
    fi
    return
  fi

  if [[ -x "$ROOT_DIR/runtime/node/bin/node" ]]; then
    NODE_RUNTIME_DIR="$ROOT_DIR/runtime/node"
    return
  fi

  if [[ ! -f "$NODE_ARCHIVE_PATH" ]]; then
    echo "下载官方 Node 运行时: $NODE_DOWNLOAD_URL"
    curl -fL -o "$NODE_ARCHIVE_PATH" "$NODE_DOWNLOAD_URL"
  fi

  rm -rf "$DOWNLOAD_ROOT/$NODE_ARCHIVE_NAME"
  tar -xJf "$NODE_ARCHIVE_PATH" -C "$DOWNLOAD_ROOT"
  NODE_RUNTIME_DIR="$DOWNLOAD_ROOT/$NODE_ARCHIVE_NAME"

  if [[ ! -x "$NODE_RUNTIME_DIR/bin/node" ]]; then
    echo "官方 Node 运行时准备失败: $NODE_RUNTIME_DIR/bin/node 不存在" >&2
    exit 1
  fi
}

prepare_official_node

export PATH="$NODE_RUNTIME_DIR/bin:$PATH"
if ! command -v "$NPM_CMD" >/dev/null 2>&1; then
  if [[ -x "$NODE_RUNTIME_DIR/bin/npm" ]]; then
    NPM_CMD="$NODE_RUNTIME_DIR/bin/npm"
  else
    echo "缺少命令: $NPM_CMD，且未找到可用的 runtime/node/bin/npm" >&2
    exit 1
  fi
fi

require_file "$APP_SRC_DIR/server.js"
require_file "$APP_SRC_DIR/index.html"
require_file "$APP_SRC_DIR/package.json"
require_file "$APP_SRC_DIR/package-lock.json"
require_file "$APP_SRC_DIR/README.txt"
require_file "$ROOT_DIR/scripts/install.sh"
require_file "$ROOT_DIR/scripts/start.sh"
require_file "$ROOT_DIR/scripts/stop.sh"
require_file "$ROOT_DIR/scripts/status.sh"
require_file "$ROOT_DIR/scripts/uninstall.sh"
require_file "$ROOT_DIR/systemd/webssh.service.template"
require_file "$ROOT_DIR/config/.env.example"

mkdir -p "$DIST_DIR" "$BUILD_ROOT" "$DOWNLOAD_ROOT"

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR/app" "$RELEASE_DIR/runtime" "$RELEASE_DIR/scripts" "$RELEASE_DIR/systemd" "$RELEASE_DIR/config" "$RELEASE_DIR/logs" "$RELEASE_DIR/run"

cp "$APP_SRC_DIR/server.js" "$RELEASE_DIR/app/"
cp "$APP_SRC_DIR/index.html" "$RELEASE_DIR/app/"
cp "$APP_SRC_DIR/package.json" "$RELEASE_DIR/app/"
cp "$APP_SRC_DIR/package-lock.json" "$RELEASE_DIR/app/"
cp "$APP_SRC_DIR/README.txt" "$RELEASE_DIR/app/"

cp "$ROOT_DIR/scripts/install.sh" "$RELEASE_DIR/scripts/"
cp "$ROOT_DIR/scripts/start.sh" "$RELEASE_DIR/scripts/"
cp "$ROOT_DIR/scripts/stop.sh" "$RELEASE_DIR/scripts/"
cp "$ROOT_DIR/scripts/status.sh" "$RELEASE_DIR/scripts/"
cp "$ROOT_DIR/scripts/uninstall.sh" "$RELEASE_DIR/scripts/"
cp "$ROOT_DIR/systemd/webssh.service.template" "$RELEASE_DIR/systemd/"
cp "$ROOT_DIR/config/.env.example" "$RELEASE_DIR/config/"
cp -a "$NODE_RUNTIME_DIR" "$RELEASE_DIR/runtime/node"

find "$RELEASE_DIR/runtime/node" -name 'libc.so.6' -o -name 'ld-linux-x86-64.so.2' | xargs -r rm -f

pushd "$RELEASE_DIR/app" >/dev/null
rm -rf node_modules
"$NPM_CMD" install --production --no-audit --no-fund
popd >/dev/null

if [[ ! -d "$RELEASE_DIR/app/node_modules" ]]; then
  echo "node_modules 生成失败，未找到 $RELEASE_DIR/app/node_modules" >&2
  exit 1
fi

if [[ ! -x "$RELEASE_DIR/runtime/node/bin/node" ]]; then
  echo "打包后的 Node 运行时无效，未找到 $RELEASE_DIR/runtime/node/bin/node" >&2
  exit 1
fi

chmod +x "$RELEASE_DIR/scripts/"*.sh

tar -C "$BUILD_ROOT" -czf "$ARCHIVE_PATH" "$RELEASE_NAME"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ARCHIVE_PATH" > "$ARCHIVE_PATH.sha256"
fi

echo "离线包已生成: $ARCHIVE_PATH"
if [[ -f "$ARCHIVE_PATH.sha256" ]]; then
  echo "校验文件已生成: $ARCHIVE_PATH.sha256"
fi

echo "结构检查:"
echo "- app 源目录: $APP_SRC_DIR"
echo "- npm 命令: $NPM_CMD"
echo "- Node 运行时: $NODE_RUNTIME_DIR"
echo "- app/node_modules: $(test -d "$RELEASE_DIR/app/node_modules" && echo OK || echo FAIL)"
echo "- runtime/node/bin/node: $(test -x "$RELEASE_DIR/runtime/node/bin/node" && echo OK || echo FAIL)"
echo "- glibc 文件清理: $(find "$RELEASE_DIR/runtime/node" -name 'libc.so.6' -o -name 'ld-linux-x86-64.so.2' | grep -q . && echo FAIL || echo OK)"

echo "使用说明:"
echo "1. 在 Linux 服务器项目根目录执行: ./scripts/build-offline-tar.sh"
echo "2. 支持两种结构：根目录直接放源码，或根目录下的 app/ 放源码。"
echo "3. 默认会自动优先使用 runtime/node/bin/npm 或下载官方 Node ${NODE_VERSION}。"
echo "4. 生成后的 tar.gz 和 .sha256 在 dist/ 目录。"
