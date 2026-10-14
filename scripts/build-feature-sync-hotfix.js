#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const root = path.resolve(__dirname, '..'), auditDir = path.join(root, 'output/arm-feature-sync-audit');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
const baselineNames = {
  arm64old: 'webssh-fullstack-offline-linux-arm64-v1.0.0-20261012055544.tar.gz',
  x64old: 'webssh-fullstack-offline-linux-x64-v1.0.0-20261012055716.tar.gz',
  arm64latest: 'webssh-fullstack-offline-linux-arm64-v1.0.0-20261014015706.tar.gz',
  x64latest: 'webssh-fullstack-offline-linux-x64-v1.0.0-20261014015706.tar.gz'
};
const baselines = [];
for (const [key, archive] of Object.entries(baselineNames)) {
  const file = path.join(root, 'dist', archive), expected = fs.readFileSync(file + '.sha256', 'utf8').trim().split(/\s+/)[0];
  if (sha(file) !== expected) throw new Error('基线归档校验失败：' + archive);
  const manifestFile = key.endsWith('old') ? key.replace('old', '') + '-20261012.manifest.json' : archive + '.manifest.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(auditDir, manifestFile), 'utf8'));
  baselines.push({ name: archive, sha256: expected, sources: manifest });
}
const current = JSON.parse(fs.readFileSync(path.join(auditDir, 'current-manifest.json'), 'utf8'));
for (const [key, expected] of Object.entries(current)) {
  const file = key.startsWith('app/') ? key.slice(4) : key.replace(/^protocol\/app\//, 'protocol_app/');
  if (sha(path.join(root, file)) !== expected) throw new Error('审计后源码发生变化，请重新审计：' + key);
}
const files = ['server.js', 'package.json', 'package-lock.json', 'proto-conv/index.html'];
fs.readdirSync(path.join(root, 'proto-conv')).filter(n => /^b-interface-[a-z-]+\.js$/.test(n)).sort().forEach(n => files.push('proto-conv/' + n));
fs.readdirSync(path.join(root, 'proto-conv/assets/js')).filter(n => /^pc-(b-[a-z-]+|point-types)\.js$/.test(n)).sort().forEach(n => files.push('proto-conv/assets/js/' + n));
files.push('proto-conv/assets/css/pc-b-interface.css');
for (const file of ['package.json', 'lib/sax.js', 'LICENSE', 'README.md']) files.push('node_modules/sax/' + file);
const sourcePaths = new Set(files.map(f => 'app/' + f));
const compared = baselines.map(b => {
  const changed = Object.keys(current).filter(k => b.sources[k] && b.sources[k] !== current[k]);
  const added = Object.keys(current).filter(k => !b.sources[k]);
  return { archive: b.name, sha256: b.sha256, comparedCurrentSourceFiles: Object.keys(current).length,
    changed, added, gapsOutsideBInterfacePatch: changed.concat(added).filter(k => !sourcePaths.has(k)) };
});
if (compared.some(b => b.gapsOutsideBInterfacePatch.length && b.archive.includes('arm64'))) throw new Error('ARM 存在未纳入补丁的功能差异');
const report = { generatedAt: new Date().toISOString(), scope: 'Local ARM/x64 2026-10-12 and 2026-10-14 fullstack archives versus current shared sources; no live server audit',
  baselineReports: compared, latestArmGaps: ['Dynamic ACK script generation and copy UI', 'DCIM database config path fallback and BOM/error handling'],
  olderArmGaps: ['B-interface integration and associated backend/frontend modules', 'Pure-JavaScript sax 1.4.1 dependency'],
  sourceFilesPatched: files.length, binariesIncluded: false, productionDeployed: false };
const auditMarkdown = '# ARM / x86 功能同步核对\n\n' +
  '核对范围：本地 2026-10-12、2026-10-14 两批 ARM/x86 全栈归档及当前共享源码；没有连接生产服务器，不能据此认定所有现场机器版本相同。\n\n' +
  '| 功能 | 10/12 ARM 包 | 10/14 ARM 包 | 本累计热更新 |\n| --- | --- | --- | --- |\n' +
  '| B 接口 SU/SC、告警上报和查询 | 缺少 | 已有 | 完整同步 |\n' +
  '| 动态 ACK 脚本及响应正文生成、复制 | 缺少 | 缺少 | 补齐 |\n' +
  '| AI/DI 分类、测试编码、全选/移除、CSV 导出 | 缺少 | 已有 | 完整同步 |\n' +
  '| WSDL 下载、AI/DI/ALARM 查询模板和报文预览 | 缺少 | 已有 | 完整同步 |\n' +
  '| 批量告警定义映射和设备测点界面 | 缺少 | 已有 | 完整同步 |\n' +
  '| ARM 数据库配置路径兼容、BOM、脱敏诊断 | 缺少 | 缺少 | 包含第62章修复 |\n' +
  '| 其他主壳、串口、短信、HA、视频、数据库管理、协议助手 | 未发现本次业务源码缺口 | 未发现本次业务源码缺口 | 保留 |\n\n' +
  '第61章记录 x86 已部署动态 ACK 功能，但同日早些时候生成的两架构全栈包均早于该功能；不能将 x86 运行态与旧 x86 安装包混为一谈。10/14 两包共享业务 manifest 相同。10/12 旧 x86 的视频 vendor 文件与当前源码哈希不同，不能仅凭哈希差异断言视频功能缺失；本次不替换视频资源。\n\n' +
  'package.json/package-lock.json 同步 SAX 依赖及测试命令。其他源码仅覆盖 B 接口累计变化，纯 JavaScript SAX 随包离线提供，不携带架构二进制。保留连接配置、B 接口身份和设备映射。\n\n' +
  '详细逐文件哈希差异见 audit.json；生成的 runtime-features.js 是打包期文件，没有仓库源文件，因此不作为缺失功能判据，也不替换现场功能开关。协议助手运行目录和自定义 module4_config 不在补丁覆盖范围。\n';
const stagedRoot = path.join(root, 'output/feature-sync-hotfix', stamp), artifacts = [];
for (const arch of ['arm64', 'x64']) {
  const release = 'webssh-feature-sync-hotfix-linux-' + arch + '-' + stamp, bundle = path.join(stagedRoot, release);
  fs.mkdirSync(bundle, { recursive: true });
  const manifest = { name: release, architecture: arch, supportedBaselines: Object.values(baselineNames), productionDeployed: false,
    files: files.map(file => ({ path: file, sha256: sha(path.join(root, file)),
      allowedBeforeHashes: Array.from(new Set(baselines.map(b => b.sources['app/' + file]).filter(Boolean))),
      allowMissing: baselines.some(b => !b.sources['app/' + file]) })) };
  for (const entry of manifest.files) {
    const destination = path.join(bundle, 'payload', entry.path); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, entry.path), destination);
    const head = fs.readFileSync(destination).subarray(0, 4);
    if (head.equals(Buffer.from([127, 69, 76, 70])) || /\.(node|exe|dll|so|whl)$/i.test(entry.path)) throw new Error('累计补丁不允许架构二进制');
  }
  for (const file of ['install.sh', 'update-files.js']) fs.copyFileSync(path.join(root, 'scripts/hotfix-feature-sync', file), path.join(bundle, file));
  fs.writeFileSync(path.join(bundle, 'ARCH'), arch + '\n');
  fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(bundle, 'audit.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(bundle, 'AUDIT.md'), auditMarkdown);
  const readme = fs.readFileSync(path.join(root, 'scripts/hotfix-feature-sync/README.md'), 'utf8').split('__RELEASE__').join(release).split('__ARCH__').join(arch);
  fs.writeFileSync(path.join(bundle, 'README.md'), readme);
  const checks = ['install.sh', 'update-files.js', 'ARCH', 'manifest.json', 'audit.json', 'AUDIT.md', 'README.md'].concat(files.map(f => 'payload/' + f));
  fs.writeFileSync(path.join(bundle, 'SHA256SUMS'), checks.map(f => sha(path.join(bundle, f)) + '  ' + f).join('\n') + '\n');
  const archive = path.join(root, 'dist', release + '.tar.gz');
  cp.execFileSync('tar', ['-czf', archive, '-C', stagedRoot, release], { stdio: 'inherit' });
  fs.writeFileSync(archive + '.sha256', sha(archive) + '  ' + path.basename(archive) + '\n');
  artifacts.push({ architecture: arch, archive, sha256: sha(archive), payloadFiles: manifest.files.length, bytes: fs.statSync(archive).size });
}
fs.writeFileSync(path.join(root, 'dist', 'webssh-feature-sync-hotfix-' + stamp + '.verification.json'), JSON.stringify({ artifacts, audit: report, productionDeployed: false }, null, 2) + '\n');
fs.writeFileSync(path.join(stagedRoot, 'ARM功能核对报告.md'), auditMarkdown);
console.log(JSON.stringify({ artifacts, auditReport: path.join(stagedRoot, 'ARM功能核对报告.md') }, null, 2));
