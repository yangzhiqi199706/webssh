# flv.js 离线 Vendor

- 文件：`flv.min.js`
- 固定版本：`flv.js@1.6.2`
- 来源：官方 npm 包 `flv.js@1.6.2` 的 `dist/flv.min.js`
- 许可证：Apache License 2.0，完整文本见同目录 `LICENSE`
- SHA-256：`733b9b325dbc59871a652c0a84f2f285a2cfd06cf2efcedcd87cb1e194cd1e8f`

更新时只允许离线下载并解包官方 npm 包：

```powershell
npm pack flv.js@1.6.2 --pack-destination $env:TEMP
tar -xzf "$env:TEMP/flv.js-1.6.2.tgz" -C $env:TEMP
Copy-Item "$env:TEMP/package/dist/flv.min.js" video/vendor/flv.min.js
Copy-Item "$env:TEMP/package/LICENSE" video/vendor/LICENSE
```

不要改用 CDN 或 v2.x。`video/` 会随现有部署目录同步，因此目标离线环境不依赖联网运行时。
