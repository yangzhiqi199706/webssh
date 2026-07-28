# openGauss CIDR 管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 将 openGauss 首次启用与后续 CIDR 白名单维护拆开，使替换、追加和删除网段只重载 HBA 配置，不重启数据库、不修改账号或内存参数。

**Architecture:** 新建一个无副作用的 HBA 文本规则模块，负责严格 CIDR 校验、受管标记块解析/生成、遗留 dcim 规则迁移和全网段规则告警。server.js 通过现有 SSH + docker exec 通道完成备份、原子替换、gs_ctl reload、SQL 验证与回滚；db/index.html 在 openGauss 卡片中增加独立的访问 CIDR 模态框。

**Tech Stack:** Node.js 12 CommonJS、Express、原生 HTML/JavaScript、openGauss gs_ctl/gsql、Node assert 测试。

---

## 文件结构

- Create: lib/opengauss-access-rules.js - 纯文本 HBA 规则解析与生成。
- Create: tests/db-manager-opengauss-access-rules.test.js - 规则真实单元测试，以及 API/UI/部署契约。
- Modify: server.js:10239-10255,11083-11482 - 使用规则模块，实现 CIDR 路由和容器内可回滚事务。
- Modify: db/index.html:531-569,946-971,1058-1107 - 新增弹窗、卡片按钮和事件。
- Modify: scripts/deploy-upgrade.js:36-52 - 打包新增 lib 目录。

### Task 1: 建立可测试的 HBA 规则模块

**Files:**
- Create: lib/opengauss-access-rules.js
- Create: tests/db-manager-opengauss-access-rules.test.js

- [ ] **Step 1: 写失败的单元测试。**

创建 tests/db-manager-opengauss-access-rules.test.js：

~~~js
'use strict';

const assert = require('assert');
const rules = require('../lib/opengauss-access-rules');

const source = [
  'local all all trust',
  'host all all 0.0.0.0/0 sha256',
  'host dcim dcim 192.168.0.0/24 sha256',
  'host dcim dcim 192.168.50.0/24 sha256',
  '',
].join('\n');

assert.strictEqual(rules.normalizeIpv4Cidr('192.168.50.0/24'), '192.168.50.0/24');
assert.throws(() => rules.normalizeIpv4Cidr('192.168.50.12/24'), /网络地址/);
assert.throws(() => rules.normalizeIpv4Cidr('192.168.50.0/33'), /CIDR/);

const legacy = rules.readManagedRules(source);
assert.deepStrictEqual(legacy.rules, ['192.168.0.0/24', '192.168.50.0/24']);
assert.strictEqual(legacy.hasManagedBlock, false);
assert.strictEqual(legacy.globalAllowWarning, true);

const replaced = rules.writeManagedRules(source, ['192.168.50.0/24']);
assert.match(replaced, /# webssh:dcim-cidr-begin/);
assert.match(replaced, /host    dcim    dcim    192\.168\.50\.0\/24    sha256/);
assert.doesNotMatch(replaced, /^host\s+dcim\s+dcim\s+192\.168\.0\.0\/24\s+sha256/m);
assert.match(replaced, /^host\s+all\s+all\s+0\.0\.0\.0\/0\s+sha256/m);

const appended = rules.writeManagedRules(replaced, ['192.168.50.0/24', '192.0.2.0/24']);
assert.deepStrictEqual(rules.readManagedRules(appended).rules, ['192.168.50.0/24', '192.0.2.0/24']);
assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-begin\n'), /标记块/);
assert.throws(() => rules.readManagedRules('# webssh:dcim-cidr-begin\n# webssh:dcim-cidr-end\n# webssh:dcim-cidr-begin\n# webssh:dcim-cidr-end\n'), /多个/);

console.log('openGauss access rules: OK');
~~~

- [ ] **Step 2: 运行测试确认失败。**

Run: node tests/db-manager-opengauss-access-rules.test.js

Expected: 失败并提示找不到 ../lib/opengauss-access-rules。

- [ ] **Step 3: 实现纯函数模块。**

创建 lib/opengauss-access-rules.js。使用以下固定常量和 API，模块不得执行 SSH 或文件操作：

~~~js
'use strict';

const BEGIN = '# webssh:dcim-cidr-begin';
const END = '# webssh:dcim-cidr-end';
const LEGACY_RE = /^\s*host\s+dcim\s+dcim\s+([0-9.]+\/\d+)\s+sha256\s*$/i;
const GLOBAL_ALLOW_RE = /^\s*host\s+all\s+all\s+0\.0\.0\.0\/0\s+sha256\s*$/im;

function normalizeIpv4Cidr(value) {
  const text = String(value || '').trim();
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text);
  if (!match) throw new Error('CIDR 必须是 IPv4 网络地址，例如 192.168.50.0/24');
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((part) => part > 255) || prefix > 32) throw new Error('CIDR 非法');
  const address = (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]);
  if (address % Math.pow(2, 32 - prefix) !== 0) throw new Error('CIDR 必须使用网络地址，主机位必须为 0');
  return octets.join('.') + '/' + prefix;
}

function uniqueCidrs(values) {
  const seen = Object.create(null);
  return (values || []).map(normalizeIpv4Cidr).filter((cidr) => {
    if (seen[cidr]) return false;
    seen[cidr] = true;
    return true;
  });
}

function readManagedRules(contents) {
  const lines = String(contents || '').replace(/\r\n/g, '\n').split('\n');
  const begins = lines.filter((line) => line === BEGIN).length;
  const ends = lines.filter((line) => line === END).length;
  if ((begins || ends) && (begins !== 1 || ends !== 1)) throw new Error('HBA 受管标记块存在多个或不完整标记');
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (begin >= 0 && begin >= end) throw new Error('HBA 受管标记块顺序错误');
  const candidates = begin >= 0 ? lines.slice(begin + 1, end) : lines;
  const found = [];
  candidates.forEach((line) => {
    if (!line.trim()) return;
    const match = LEGACY_RE.exec(line);
    if (match) found.push(match[1]);
    else if (begin >= 0) throw new Error('HBA 受管标记块只允许 dcim sha256 CIDR 规则');
  });
  return { rules: uniqueCidrs(found), hasManagedBlock: begin >= 0, globalAllowWarning: GLOBAL_ALLOW_RE.test(String(contents || '')) };
}

function writeManagedRules(contents, values) {
  const lines = String(contents || '').replace(/\r\n/g, '\n').split('\n');
  const current = readManagedRules(contents);
  const rules = uniqueCidrs(values);
  const block = [BEGIN].concat(rules.map((cidr) => 'host    dcim    dcim    ' + cidr + '    sha256'), [END]);
  if (current.hasManagedBlock) {
    const begin = lines.indexOf(BEGIN);
    const end = lines.indexOf(END);
    return lines.slice(0, begin).concat(block, lines.slice(end + 1)).join('\n');
  }
  const retained = lines.filter((line) => !LEGACY_RE.test(line));
  while (retained.length && retained[retained.length - 1] === '') retained.pop();
  return retained.concat([''], block, ['']).join('\n');
}

module.exports = { normalizeIpv4Cidr, readManagedRules, writeManagedRules };
~~~

- [ ] **Step 4: 运行单元测试。**

Run: node tests/db-manager-opengauss-access-rules.test.js

Expected: openGauss access rules: OK。

- [ ] **Step 5: 提交模块。**

~~~bash
git add lib/opengauss-access-rules.js tests/db-manager-opengauss-access-rules.test.js
git commit -m "feat: add openGauss access rule parser"
~~~

### Task 2: 实现无重启的 CIDR API

**Files:**
- Modify: server.js:10239-10255,11083-11482
- Modify: scripts/deploy-upgrade.js:36-52
- Modify: tests/db-manager-opengauss-access-rules.test.js

- [ ] **Step 1: 追加后端契约测试。**

在现有测试后追加：

~~~js
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const deploy = fs.readFileSync(path.join(root, 'scripts', 'deploy-upgrade.js'), 'utf8');

assert.match(server, /require\('\.\/lib\/opengauss-access-rules'\)/);
assert.match(server, /app\.get\('\/api\/db-manager\/opengauss\/access-rules'/);
assert.match(server, /app\.put\('\/api\/db-manager\/opengauss\/access-rules'/);
assert.match(server, /app\.delete\('\/api\/db-manager\/opengauss\/access-rules\/:cidr'/);
assert.match(server, /files\.gsCtlPath[\s\S]{0,120}reload -D/);
assert.match(deploy, /'lib'/);
~~~

- [ ] **Step 2: 运行测试确认契约失败。**

Run: node tests/db-manager-opengauss-access-rules.test.js

Expected: 第一个 server.js 路由契约断言失败。

- [ ] **Step 3: 在 server.js 接入模块和容器文件事务。**

在 setupDbManager 的依赖区加入：

~~~js
const accessRules = require('./lib/opengauss-access-rules');
~~~

在 initOpenGauss 前实现以下五个函数，名称必须保持一致：locateOpenGaussAccessFiles、readContainerText、replaceContainerText、reloadOpenGaussAccessRules、updateOpenGaussAccessRules。

~~~js
async function locateOpenGaussAccessFiles() {
  const hba = await sshRun(runInContainerCmd(cfg.container,
    "find /opt/software/openGauss/data -maxdepth 3 -name pg_hba.conf -type f 2>/dev/null | head -1"));
  const hbaPath = hba.stdout.trim();
  if (!hbaPath) throw new Error('未找到 openGauss pg_hba.conf');
  const ctl = await sshRun(runInContainerCmd(cfg.container,
    "find /opt/software/openGauss -maxdepth 4 -name gs_ctl -type f 2>/dev/null | head -1"));
  const gsCtlPath = ctl.stdout.trim();
  if (!gsCtlPath) throw new Error('未找到 openGauss gs_ctl 工具');
  return { hbaPath, dataDir: hbaPath.replace(/\/pg_hba\.conf$/, ''), gsCtlPath };
}

async function readContainerText(filePath) {
  const result = await sshRun(runInContainerCmd(cfg.container, 'cat ' + shellEscape(filePath)));
  if (result.code !== 0) throw new Error('读取 HBA 配置失败: ' + (result.stderr || result.stdout).slice(0, 300));
  return result.stdout;
}

async function replaceContainerText(filePath, contents, backupPath) {
  const tempPath = filePath + '.webssh-tmp-' + stampForFile();
  const encoded = Buffer.from(contents, 'utf8').toString('base64');
  const command = [
    'cp -a ' + shellEscape(filePath) + ' ' + shellEscape(backupPath),
    'cp -a ' + shellEscape(filePath) + ' ' + shellEscape(tempPath),
    'printf %s ' + shellEscape(encoded) + ' | base64 -d > ' + shellEscape(tempPath),
    'mv -f ' + shellEscape(tempPath) + ' ' + shellEscape(filePath),
  ].join(' && ');
  const result = await sshRun(runInContainerCmd(cfg.container, command));
  if (result.code !== 0) throw new Error('写入 HBA 配置失败: ' + (result.stderr || result.stdout).slice(0, 300));
}

async function reloadOpenGaussAccessRules(files) {
  const command = shellEscape(files.gsCtlPath) + ' reload -D ' + shellEscape(files.dataDir) + ' 2>&1';
  const result = await sshRun(runInContainerAs(cfg.container, 'omm', command));
  if (result.code !== 0) throw new Error('重载 openGauss 配置失败: ' + (result.stderr || result.stdout).slice(0, 300));
  const sqlCheck = await runOpenGaussGsql('SELECT 1;');
  if (sqlCheck !== '1') throw new Error('openGauss SQL 验证失败: ' + sqlCheck);
  return { sqlCheck: sqlCheck, reloadOutput: (result.stdout || result.stderr || '').trim() };
}

async function updateOpenGaussAccessRules(mode, cidr, removeCidr) {
  const service = await probeServiceRunning('opengauss');
  if (!service.running) throw new Error('openGauss 未运行，不能修改访问 CIDR');
  const files = await locateOpenGaussAccessFiles();
  const original = await readContainerText(files.hbaPath);
  const parsed = accessRules.readManagedRules(original);
  const target = removeCidr
    ? parsed.rules.filter((rule) => rule !== accessRules.normalizeIpv4Cidr(removeCidr))
    : mode === 'replace'
      ? [accessRules.normalizeIpv4Cidr(cidr)]
      : parsed.rules.concat([accessRules.normalizeIpv4Cidr(cidr)]);
  if (removeCidr && target.length === parsed.rules.length) throw new Error('指定 CIDR 不存在');
  const next = accessRules.writeManagedRules(original, target);
  const backupPath = files.hbaPath + '.bak.webssh-cidr.' + stampForFile();
  await replaceContainerText(files.hbaPath, next, backupPath);
  try {
    const verification = await reloadOpenGaussAccessRules(files);
    const after = accessRules.readManagedRules(next);
    return { ok: true, rules: after.rules, globalAllowWarning: after.globalAllowWarning, backupPath: backupPath, verification: verification };
  } catch (err) {
    const rollback = await sshRun(runInContainerCmd(cfg.container,
      'cp -a ' + shellEscape(backupPath) + ' ' + shellEscape(files.hbaPath)));
    try { await reloadOpenGaussAccessRules(files); } catch (_e) {}
    throw new Error((err.message || err) + '；已恢复备份：' + (rollback.code === 0 ? '是' : '否'));
  }
}
~~~

- [ ] **Step 4: 让首次启用写入受管块，并添加路由。**

在 initOpenGauss 中将 CIDR 校验替换为：

~~~js
const cidr = accessRules.normalizeIpv4Cidr(opts.cidr || '192.168.0.0/24');
~~~

用以下逻辑替换原先直接 echo HBA 行的步骤：

~~~js
const currentHba = await readContainerText(pgHbaPath);
const currentRules = accessRules.readManagedRules(currentHba).rules;
const nextHba = accessRules.writeManagedRules(currentHba, currentRules.concat([cidr]));
const initHbaBackup = pgHbaPath + '.bak.webssh-init.' + stampForFile();
await replaceContainerText(pgHbaPath, nextHba, initHbaBackup);
step('pg_hba', '受管 CIDR=' + accessRules.readManagedRules(nextHba).rules.join(', ') + '；备份=' + initHbaBackup);
~~~

在现有 opengauss/init 路由前添加：

~~~js
app.get('/api/db-manager/opengauss/access-rules', async (_req, res) => {
  try {
    const files = await locateOpenGaussAccessFiles();
    const parsed = accessRules.readManagedRules(await readContainerText(files.hbaPath));
    const service = await probeServiceRunning('opengauss');
    res.json({ ok: true, rules: parsed.rules, hasManagedBlock: parsed.hasManagedBlock,
      globalAllowWarning: parsed.globalAllowWarning, serviceRunning: service.running,
      systemdState: service.raw || 'unknown', hbaPath: files.hbaPath });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.put('/api/db-manager/opengauss/access-rules', async (req, res) => {
  const body = req.body || {};
  if (body.mode !== 'replace' && body.mode !== 'append') {
    return res.status(400).json({ ok: false, message: 'mode 必须为 replace 或 append' });
  }
  try { res.json(await updateOpenGaussAccessRules(body.mode, body.cidr, '')); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.delete('/api/db-manager/opengauss/access-rules/:cidr', async (req, res) => {
  try { res.json(await updateOpenGaussAccessRules('', '', decodeURIComponent(req.params.cidr))); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
~~~

在 scripts/deploy-upgrade.js 的 PAYLOAD_ENTRIES 中加入：

~~~js
  'lib',
~~~

- [ ] **Step 5: 验证后端。**

Run:

~~~powershell
node tests/db-manager-opengauss-access-rules.test.js
node tests/db-manager-health-probe.test.js
node tests/db-manager-opengauss-command.test.js
node --check server.js
~~~

Expected: 全部退出码为 0。

- [ ] **Step 6: 提交后端。**

~~~bash
git add server.js scripts/deploy-upgrade.js tests/db-manager-opengauss-access-rules.test.js
git commit -m "feat: manage openGauss CIDR without restart"
~~~

### Task 3: 增加独立 CIDR 管理界面

**Files:**
- Modify: db/index.html:531-569,946-971,1058-1107
- Modify: tests/db-manager-opengauss-access-rules.test.js

- [ ] **Step 1: 追加 UI 失败契约。**

在测试末尾追加：

~~~js
const ui = fs.readFileSync(path.join(root, 'db', 'index.html'), 'utf8');
assert.match(ui, /btnGaussAccessRules/);
assert.match(ui, /gaussAccessModal/);
assert.match(ui, /openGaussAccessRules/);
assert.match(ui, /saveOpenGaussAccessRules\('replace'\)/);
assert.match(ui, /saveOpenGaussAccessRules\('append'\)/);
assert.match(ui, /opengauss\/access-rules/);
~~~

- [ ] **Step 2: 运行测试确认失败。**

Run: node tests/db-manager-opengauss-access-rules.test.js

Expected: btnGaussAccessRules 断言失败。

- [ ] **Step 3: 添加弹窗、按钮和事件处理。**

在 gaussInitModal 后新增 gaussAccessModal，包含以下稳定 DOM ID：gaAccessCidr、gaAccessRules、gaAccessStatus、btnCloseGaussAccess、btnGaussReplaceCidr、btnGaussAppendCidr。卡片 openGauss 按钮区加入：

~~~js
btns += '<button class="btn sm primary" id="btnGaussInit" title="首次启用 openGauss、创建 dcim 应用账号并设置初始访问网段">首次启用</button>';
btns += '<button class="btn sm" id="btnGaussAccessRules" title="替换、添加或删除 openGauss 的受管访问 CIDR">访问 CIDR</button>';
~~~

绑定按钮并在服务未运行时禁用：

~~~js
const ga = $('btnGaussAccessRules');
if (ga) {
  ga.disabled = !info.serviceRunning;
  ga.addEventListener('click', openGaussAccessRules);
}
~~~

插入以下模态框 HTML：

~~~html
<div class="modal-mask" id="gaussAccessModal" aria-hidden="true">
  <div class="modal">
    <div class="modal-head"><h3>openGauss 访问 CIDR</h3><button class="btn" id="btnCloseGaussAccess" type="button">关闭</button></div>
    <div class="modal-body">
      <div class="form-grid"><label class="field"><span>IPv4 CIDR</span><input id="gaAccessCidr" placeholder="192.168.50.0/24" autocomplete="off" /></label></div>
      <div class="status-box" id="gaAccessRules" style="display:none"></div>
      <div class="status-box" id="gaAccessStatus" style="display:none;max-height:240px;overflow:auto"></div>
      <div class="actions" style="justify-content:flex-end"><button class="btn" id="btnGaussAppendCidr" type="button">添加网段</button><button class="btn primary" id="btnGaussReplaceCidr" type="button">替换当前网段</button></div>
    </div>
  </div>
</div>
~~~

实现以下事件代码。替换固定为 PUT + mode replace，追加为 PUT + mode append，删除使用 DELETE + encodeURIComponent；成功后刷新概览，所有操作都声明不会重启数据库：

~~~js
function setOpenGaussAccessStatus(text, isError) {
  const box = $('gaAccessStatus');
  box.style.display = '';
  box.innerHTML = isError ? '<span class="err">' + esc(text) + '</span>' : esc(text);
}
function renderOpenGaussAccessRules(result) {
  const box = $('gaAccessRules');
  const rows = (result.rules || []).map((cidr) => '<div class="kv-row"><span class="k">CIDR</span><span class="v mono">' + esc(cidr) + '</span><button class="btn sm danger" type="button" data-remove-cidr="' + esc(cidr) + '" title="删除 ' + esc(cidr) + '">×</button></div>');
  if (result.globalAllowWarning) rows.unshift('<div class="kv-row"><span class="k">提示</span><span class="v err">存在全网段规则，当前 CIDR 不能构成严格限制</span><span></span></div>');
  box.style.display = ''; box.innerHTML = rows.length ? rows.join('') : '<span class="v">暂无受管 CIDR</span>';
  box.querySelectorAll('[data-remove-cidr]').forEach((button) => button.addEventListener('click', () => removeOpenGaussAccessRule(button.dataset.removeCidr)));
}
async function openGaussAccessRules() {
  $('gaAccessCidr').value = ''; $('gaussAccessModal').classList.add('open'); setOpenGaussAccessStatus('读取中…', false);
  try {
    const result = await jfetch(API + '/opengauss/access-rules');
    if (!result.ok) throw new Error(result.message || '读取失败');
    renderOpenGaussAccessRules(result);
    setOpenGaussAccessStatus(result.serviceRunning ? '服务运行中；CIDR 变更将仅重载配置。' : '服务未运行，不能修改 CIDR。', !result.serviceRunning);
  } catch (e) { setOpenGaussAccessStatus(e.message || String(e), true); }
}
async function saveOpenGaussAccessRules(mode) {
  const cidr = $('gaAccessCidr').value.trim();
  if (!cidr) return setOpenGaussAccessStatus('请输入 IPv4 CIDR。', true);
  if (!confirm(mode === 'replace' ? '确定替换当前受管 CIDR？数据库不会重启。' : '确定添加该 CIDR？数据库不会重启。')) return;
  $('btnGaussReplaceCidr').disabled = true; $('btnGaussAppendCidr').disabled = true; setOpenGaussAccessStatus('保存并重载配置…', false);
  try {
    const result = await jfetch(API + '/opengauss/access-rules', { method: 'PUT', body: { mode: mode, cidr: cidr } });
    if (!result.ok) throw new Error(result.message || '保存失败');
    renderOpenGaussAccessRules(result); setOpenGaussAccessStatus('已生效；SELECT 1 = ' + ((result.verification || {}).sqlCheck || '—'), false); await refreshStatus();
  } catch (e) { setOpenGaussAccessStatus(e.message || String(e), true); }
  finally { $('btnGaussReplaceCidr').disabled = false; $('btnGaussAppendCidr').disabled = false; }
}
async function removeOpenGaussAccessRule(cidr) {
  const count = $('gaAccessRules').querySelectorAll('[data-remove-cidr]').length;
  if (!confirm(count === 1 ? '删除最后一个受管 CIDR？数据库不会重启。' : '确定删除 ' + cidr + '？数据库不会重启。')) return;
  try {
    const result = await jfetch(API + '/opengauss/access-rules/' + encodeURIComponent(cidr), { method: 'DELETE' });
    if (!result.ok) throw new Error(result.message || '删除失败');
    renderOpenGaussAccessRules(result); setOpenGaussAccessStatus('已生效；SELECT 1 = ' + ((result.verification || {}).sqlCheck || '—'), false); await refreshStatus();
  } catch (e) { setOpenGaussAccessStatus(e.message || String(e), true); }
}
$('btnCloseGaussAccess').addEventListener('click', () => $('gaussAccessModal').classList.remove('open'));
$('btnGaussReplaceCidr').addEventListener('click', () => saveOpenGaussAccessRules('replace'));
$('btnGaussAppendCidr').addEventListener('click', () => saveOpenGaussAccessRules('append'));
~~~

- [ ] **Step 4: 运行 UI 和脚本验证。**

Run:

~~~powershell
node tests/db-manager-opengauss-access-rules.test.js
node --check server.js
node -e "const fs=require('fs'); const html=fs.readFileSync('db/index.html','utf8'); const script=html.match(/<script>([\s\S]*)<\/script>/); new Function(script[1]); console.log('db inline script: OK');"
~~~

Expected: 访问规则测试与语法检查均退出码为 0。

- [ ] **Step 5: 提交前端。**

~~~bash
git add db/index.html tests/db-manager-opengauss-access-rules.test.js
git commit -m "feat: add openGauss CIDR management UI"
~~~

### Task 4: 回归、部署与目标机验收

**Files:**
- Verify: lib/opengauss-access-rules.js
- Verify: server.js
- Verify: db/index.html
- Verify: tests/db-manager-opengauss-access-rules.test.js
- Deploy: scripts/deploy-upgrade.js

- [ ] **Step 1: 执行数据库管理全量回归。**

Run:

~~~powershell
Get-ChildItem tests -Filter 'db-manager-*.test.js' | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
node --check server.js
~~~

Expected: 每个测试打印 OK，退出码为 0。

- [ ] **Step 2: 部署到 192.168.50.197。**

Run:

~~~powershell
$env:WEBSSH_HOST = '192.168.50.197'
$env:WEBSSH_PORT = '22'
$env:WEBSSH_USER = 'root'
$credential = Get-Credential -UserName 'root' -Message '输入 192.168.50.197 的部署密码'
try {
  $env:WEBSSH_DEPLOY_PASS = $credential.GetNetworkCredential().Password
  node scripts/deploy-upgrade.js
} finally {
  Remove-Item Env:WEBSSH_DEPLOY_PASS -ErrorAction SilentlyContinue
}
~~~

Expected: 部署脚本备份 app、上传 lib、重启 webssh 并通过 /health 200；任何失败自动回滚。

- [ ] **Step 3: 验证 API 和无重启保证。**

在目标机记录以下值：

~~~bash
systemctl is-active webssh
curl -fsS http://127.0.0.1:3010/health
docker exec dcim systemctl is-active opengauss.service
docker exec dcim systemctl show opengauss.service -p ActiveEnterTimestamp --value
curl -fsS http://127.0.0.1:3010/api/db-manager/opengauss/access-rules
~~~

在界面执行“替换当前网段”为 192.168.50.0/24。再次读取 ActiveEnterTimestamp；它必须保持不变，API 响应 verification.sqlCheck 必须为 1，rules 仅含该网段。

- [ ] **Step 4: 验证追加、删除和最终状态。**

在界面添加 192.0.2.0/24，确认两个 CIDR 共存且 ActiveEnterTimestamp 不变；随后删除 192.0.2.0/24，确认仅保留 192.168.50.0/24。最后执行：

~~~bash
docker exec dcim su - omm -c "source /home/omm/.bashrc && /opt/software/openGauss/app/bin/gsql -d postgres -At -c 'SELECT 1;'"
~~~

Expected: 返回 1，openGauss 未重启。

- [ ] **Step 5: 检查提交边界。**

Run: git status --short

Expected: Task 1-3 的功能文件均已在各自任务中提交；Task 4 只做部署和验收，不创建重复提交。工作区中其他用户修改保持未暂存且未回退。
