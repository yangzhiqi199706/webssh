'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const rules = require('../lib/opengauss-access-rules');

const source = [
  '# local rule is not managed by WebSSH',
  'local all all trust',
  'host all all 0.0.0.0/0 sha256',
  'host dcim dcim 192.168.0.0/24 sha256',
  'host dcim dcim 192.168.50.0/24 sha256',
  'host otherapp otherdb 198.51.100.0/24 scram-sha-256',
  ''
].join('\n');

assert.strictEqual(rules.normalizeIpv4Cidr('192.168.50.0/24'), '192.168.50.0/24');
assert.strictEqual(rules.normalizeIpv4Cidr('0.0.0.0/0'), '0.0.0.0/0');
assert.throws(() => rules.normalizeIpv4Cidr('192.168.50.12/24'), /网络地址/);
assert.throws(() => rules.normalizeIpv4Cidr('192.168.50.0/33'), /CIDR/);
assert.throws(() => rules.normalizeIpv4Cidr('192.168.256.0/24'), /CIDR/);
assert.throws(() => rules.normalizeIpv4Cidr('192.168.50/24'), /CIDR/);
assert.throws(() => rules.normalizeIpv4Cidr('01.2.3.0/24'), /CIDR/);
assert.throws(() => rules.normalizeIpv4Cidr('192.168.0.0/08'), /CIDR/);

const legacy = rules.readManagedRules(source);
assert.deepStrictEqual(legacy.rules, ['192.168.0.0/24', '192.168.50.0/24']);
assert.strictEqual(legacy.hasManagedBlock, false);
assert.strictEqual(legacy.globalAllowWarning, true);
assert.strictEqual(rules.readManagedRules('local all all trust\n').globalAllowWarning, false);
assert.strictEqual(rules.readManagedRules('host all all 0.0.0.0/0 sha256 # temporary\n').globalAllowWarning, true);
assert.strictEqual(rules.readManagedRules('host all all 0.0.0.0/0 sha256x # not sha256\n').globalAllowWarning, false);

const replaced = rules.writeManagedRules(source, ['192.168.50.0/24', '192.168.50.0/24']);
assert.match(replaced, /# webssh:dcim-cidr-begin/);
assert.match(replaced, /host    dcim    dcim    192\.168\.50\.0\/24    sha256/);
assert.doesNotMatch(replaced, /^host\s+dcim\s+dcim\s+192\.168\.0\.0\/24\s+sha256/m);
assert.match(replaced, /^host\s+all\s+all\s+0\.0\.0\.0\/0\s+sha256/m);
assert.match(replaced, /^host otherapp otherdb 198\.51\.100\.0\/24 scram-sha-256$/m);
assert.deepStrictEqual(rules.readManagedRules(replaced).rules, ['192.168.50.0/24']);

const appended = rules.writeManagedRules(replaced, ['192.168.50.0/24', '192.0.2.0/24']);
assert.deepStrictEqual(rules.readManagedRules(appended).rules, ['192.168.50.0/24', '192.0.2.0/24']);

assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-begin\n'), /标记块/);
assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-end\n'), /标记块/);
assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-begin\n# webssh:dcim-cidr-end\n# webssh:dcim-cidr-begin\n# webssh:dcim-cidr-end\n'), /多个/);
assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-end\n# webssh:dcim-cidr-begin\n'), /顺序错误/);
assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-begin\nhost all all 10.0.0.0/8 sha256\n# webssh:dcim-cidr-end\n'), /只允许/);

const spacedMarkers = '  # webssh:dcim-cidr-begin  \n' +
  'host dcim dcim 203.0.113.0/24 sha256\n' +
  '\t# webssh:dcim-cidr-end\t\n';
assert.strictEqual(rules.readManagedRules(spacedMarkers).hasManagedBlock, true);
assert.deepStrictEqual(rules.readManagedRules(spacedMarkers).rules, ['203.0.113.0/24']);
assert.throws(() => rules.readManagedRules(' # webssh:dcim-cidr-begin\n# webssh:dcim-cidr-end\n # webssh:dcim-cidr-begin\n# webssh:dcim-cidr-end\n'), /多个/);
assert.throws(() => rules.writeManagedRules(' # webssh:dcim-cidr-begin\nhost dcim dcim 203.0.113.0/24 sha256\n', ['192.0.2.0/24']), /标记块/);

const crlfSource = 'header comment\r\n' +
  'host dcim dcim 192.168.0.0/24 sha256\r\n' +
  'host otherapp otherdb 198.51.100.0/24 scram-sha-256\r\n\r\n';
const crlfReplaced = rules.writeManagedRules(crlfSource, ['192.0.2.0/24']);
assert.strictEqual(crlfReplaced, 'header comment\r\n' +
  '# webssh:dcim-cidr-begin\r\n' +
  'host    dcim    dcim    192.0.2.0/24    sha256\r\n' +
  '# webssh:dcim-cidr-end\r\n' +
  'host otherapp otherdb 198.51.100.0/24 scram-sha-256\r\n\r\n');

assert.strictEqual(rules.writeManagedRules('local all all trust\n', ['192.0.2.0/24']),
  'local all all trust\n' +
  '# webssh:dcim-cidr-begin\n' +
  'host    dcim    dcim    192.0.2.0/24    sha256\n' +
  '# webssh:dcim-cidr-end');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const deploySource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy-upgrade.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(__dirname, '..', 'db', 'index.html'), 'utf8');

assert.match(serverSource, /const accessRules = require\('\.\/lib\/opengauss-access-rules'\);/);
assert.match(serverSource, /app\.get\('\/api\/db-manager\/opengauss\/access-rules'/);
assert.match(serverSource, /app\.put\('\/api\/db-manager\/opengauss\/access-rules'/);
assert.match(serverSource, /app\.delete\('\/api\/db-manager\/opengauss\/access-rules\/:cidr'/);
assert.match(serverSource, /files\.gsCtlPath[\s\S]{0,100}reload -D/);
assert.match(serverSource, /const cidr = accessRules\.normalizeIpv4Cidr\(opts\.cidr \|\| '192\.168\.0\.0\/24'\);/);
assert.match(serverSource, /queueOpenGaussAccessUpdate/);
assert.match(serverSource, /mode === 'append' && parsed\.rules\.indexOf\(normalizedCidr\) >= 0/);
assert.match(serverSource, /statusCode = 404/);
const accessUpdateSource = serverSource.slice(
  serverSource.indexOf('async function updateOpenGaussAccessRules('),
  serverSource.indexOf('// ===== openGauss 一键启用'));
assert.match(accessUpdateSource, /shellEscape\(backupPath\)[\s\S]{0,220}reloadOpenGaussAccessRules\(files\)/);
assert.match(accessUpdateSource, /Math\.random\(\)/);
assert.doesNotMatch(accessUpdateSource, /systemctl\s+restart|ALTER USER|gs_guc/);
assert.match(serverSource, /async function initOpenGauss\(opts\)\s*\{\s*return queueOpenGaussAccessUpdate\(\(\) => initOpenGaussLocked\(opts\)\);/);
assert.match(deploySource, /'lib',/);

assert.match(uiSource, /btnGaussAccessRules/,
  'openGauss 卡片应提供独立的访问 CIDR 管理入口');
assert.match(uiSource, /gaussAccessModal/,
  '页面应提供访问 CIDR 管理弹窗');
assert.match(uiSource, /openGaussAccessRules/,
  '页面应加载 openGauss 的受管访问 CIDR 规则');
assert.match(uiSource, /saveOpenGaussAccessRules\('replace'\)/,
  '页面应支持替换受管访问 CIDR');
assert.match(uiSource, /saveOpenGaussAccessRules\('append'\)/,
  '页面应支持追加受管访问 CIDR');
assert.match(uiSource, /opengauss\/access-rules/,
  '页面应调用固定的 openGauss 访问 CIDR 接口');
assert.match(uiSource, /ga\.disabled = !info\.serviceRunning/,
  '访问 CIDR 入口必须按 openGauss 服务状态禁用');
assert.match(uiSource, /<button class="btn primary" id="btnGaussReplaceCidr"[^>]*>替换为此 CIDR<\/button>/,
  '替换当前 CIDR 应是默认的主操作');
assert.match(uiSource, /<button class="btn" id="btnGaussAppendCidr"[^>]*>添加 CIDR<\/button>/,
  '添加 CIDR 应是次要操作');
assert.match(uiSource, /id="btnGaussInit" title="仅首次使用：[^\"]*后续 CIDR 请使用访问 CIDR 按钮[^\"]*">首次启用<\/button>/,
  '首次启用按钮必须明确只用于初始化，后续 CIDR 修改走独立入口');
assert.match(uiSource, /function setOpenGaussAccessBusy\(busy\)[\s\S]{0,800}gaAccessCidr[\s\S]{0,800}data-remove-cidr/,
  '统一 busy 状态必须禁用输入、操作按钮和全部删除按钮');
const accessSaveSource = uiSource.slice(
  uiSource.indexOf('async function saveOpenGaussAccessRules'),
  uiSource.indexOf('async function removeOpenGaussAccessRule'));
assert.match(accessSaveSource, /setOpenGaussAccessBusy\(true\)[\s\S]*finally\s*\{\s*setOpenGaussAccessBusy\(false\);\s*\}/,
  '保存 CIDR 时必须用统一 busy 状态，并在 finally 恢复到服务状态');
const accessRemoveSource = uiSource.slice(
  uiSource.indexOf('async function removeOpenGaussAccessRule'),
  uiSource.indexOf("$('btnCloseGaussAccess')"));
assert.match(accessRemoveSource, /setOpenGaussAccessBusy\(true\)[\s\S]*finally\s*\{\s*setOpenGaussAccessBusy\(false\);\s*\}/,
  '删除 CIDR 时必须用统一 busy 状态，并在 finally 恢复到服务状态');
assert.match(uiSource, /encodeURIComponent\(cidr\)/,
  '删除 CIDR 时必须对路径参数编码');
assert.match(uiSource, /danger-banner">⚠ 存在全网段规则，当前 CIDR 不能构成严格限制/,
  '全网段规则必须用红色风险提示说明无法形成严格限制');
assert.match(uiSource, /最后一个 WebSSH 受管 CIDR/,
  '删除最后一条受管规则前必须明确提示');
assert.match(uiSource, /该网段已存在，未修改配置/,
  '重复添加必须说明配置未变更');
assert.match(uiSource, /await refreshStatus\(\)/,
  'CIDR 成功变更后必须刷新数据库状态');
const accessUiSource = uiSource.slice(
  uiSource.indexOf('// openGauss 已启用后的受管访问 CIDR'),
  uiSource.indexOf('// ========== openGauss 一键建 WVP 表 =========='));
assert.match(accessUiSource, /let openGaussAccessLoadRequestId = 0;/,
  '访问 CIDR 读取必须维护递增请求编号，避免旧响应覆盖新数据');
const accessLoadSource = accessUiSource.slice(
  accessUiSource.indexOf('async function openGaussAccessRules'),
  accessUiSource.indexOf('async function saveOpenGaussAccessRules'));
assert.match(accessLoadSource, /const requestId = \+\+openGaussAccessLoadRequestId;/,
  '每次打开访问 CIDR 弹窗必须生成新的读取请求编号');
assert.match(accessLoadSource, /if \(requestId !== openGaussAccessLoadRequestId\) return;/,
  '旧读取请求的响应、错误和 finally 都不得更新当前弹窗');
assert.match(accessUiSource, /btnCloseGaussAccess[^\n]*[\s\S]{0,160}\+\+openGaussAccessLoadRequestId/,
  '关闭访问 CIDR 弹窗必须使未完成的读取请求失效');
assert.match(accessUiSource, /function formatOpenGaussAccessSuccess[\s\S]{0,1800}backupPath[\s\S]{0,1800}reloadOutput[\s\S]{0,1800}sqlCheck/,
  '保存和删除结果必须展示备份、重载和 SQL 验证信息');
assert.match(accessUiSource, /function limitOpenGaussAccessStatusText[\s\S]{0,600}slice\(0, OPEN_GAUSS_ACCESS_STATUS_LIMIT\)/,
  '回显的运行输出必须限长');
assert.match(accessUiSource, /function setOpenGaussAccessStatus[\s\S]{0,400}esc\(text\)/,
  '回显的运行输出必须通过现有转义函数渲染');
assert.match(accessSaveSource, /const successText = formatOpenGaussAccessSuccess[\s\S]{0,1200}setOpenGaussAccessStatus\(successText, false\)[\s\S]{0,1200}refreshOpenGaussAccessOverview\(successText\)/,
  '保存成功后必须先保留成功结果，再单独刷新概览');
assert.match(accessRemoveSource, /const successText = formatOpenGaussAccessSuccess[\s\S]{0,1200}setOpenGaussAccessStatus\(successText, false\)[\s\S]{0,1200}refreshOpenGaussAccessOverview\(successText\)/,
  '删除成功后必须先保留成功结果，再单独刷新概览');
assert.match(accessUiSource, /async function refreshOpenGaussAccessOverview\(successText\)[\s\S]{0,1000}概览刷新失败/,
  '概览刷新失败不能把已生效或已删除的操作误报为失败');
assert.match(accessUiSource, /数据库不会重启/,
  'CIDR 管理必须明确说明不会重启数据库');
assert.doesNotMatch(accessUiSource, /opengauss\/init/,
  'CIDR 管理不得调用首次启用接口');

console.log('openGauss access rules: OK');
