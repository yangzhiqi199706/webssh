# flv.js 离线 vendor

把 flv.js 的 dist 文件放在这里，文件名固定为 `flv.min.js`。

## 获取方式

**方式一：从 GitHub release 下载**
- 仓库：https://github.com/bilibili/flv.js
- 推荐版本：**v1.6.2**（兼容性最好，2024 年的稳定 dist）
- 下载 `dist/flv.min.js` 后改名为 `flv.min.js` 放到本目录

**方式二：从 npm 镜像下载**
```bash
curl -L -o video/vendor/flv.min.js \
  https://registry.npmmirror.com/flv.js/-/flv.js-1.6.2.tgz
# 或解压 tgz 后拿 package/dist/flv.min.js
```

**方式三：本地 windows（无外网时）**
让有外网的电脑下好后丢进 `.offline-downloads/flvjs/flv.min.js`，
打全栈包时由 `scripts/build-fullstack-on-server.js` 自动塞进 `app/video/vendor/`。

## 注意

- 不要用 v2.x（mpegts.js 重写版，API 变了）
- 文件大小约 150 KB
- 不要走 CDN：webssh 部署目标是离线 Linux，外网不通
