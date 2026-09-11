'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert.ok(
  html.includes("{ id: 'ops-management', label: '运维管理'"),
  '左侧功能菜单必须新增运维管理入口',
);
[
  'id="opsManagementView"',
  'id="opsManagementTabs"',
  'id="opsManagementPane"',
  "{ id: 'ops', label: '运维' }",
  "{ id: 'time', label: '时间' }",
  "{ id: 'ip', label: 'IP 管理' }",
  "{ id: 'firewall', label: '防火墙' }",
  'function mountOpsManagementSections()',
  'function openOpsManagement(tab)',
  "const isOpsManagement = view === 'ops-management';",
].forEach(function (needle) {
  assert.ok(html.includes(needle), '运维管理页面缺少：' + needle);
});

const settingsTabsStart = html.indexOf('const settingsTabs = [');
const settingsTabsEnd = html.indexOf('];', settingsTabsStart);
const settingsTabsSource = html.slice(settingsTabsStart, settingsTabsEnd);
['ops', 'time', 'ip', 'firewall'].forEach(function (pane) {
  assert.strictEqual(
    settingsTabsSource.includes("id: '" + pane + "'"),
    false,
    '设置页不得继续保留运维管理标签：' + pane,
  );
});

assert.ok(
  html.includes("{ id: 'account', label: '账号管理' }"),
  '运维管理必须提供账号管理入口',
);
const opsTabsStart = html.indexOf('const opsManagementTabs = [');
const opsTabsEnd = html.indexOf('];', opsTabsStart);
const opsTabsSource = html.slice(opsTabsStart, opsTabsEnd);
assert.ok(
  opsTabsSource.indexOf("{ id: 'firewall', label: '防火墙' }")
    < opsTabsSource.indexOf("{ id: 'account', label: '账号管理' }"),
  '账号管理必须排在防火墙下方',
);

function sectionSource(pane) {
  const start = html.indexOf('data-pane="' + pane + '"');
  const end = html.indexOf('</section>', start);
  return start >= 0 && end >= 0 ? html.slice(start, end) : '';
}

const opsSection = sectionSource('ops');
const accountSection = sectionSource('account');
['accessPasswordHint', 'localAccountProfile', 'accessAdminPanel'].forEach(function (id) {
  assert.ok(accountSection.includes('id="' + id + '"'), '账号管理必须包含：' + id);
  assert.strictEqual(opsSection.includes('id="' + id + '"'), false, '运维不得保留账号控件：' + id);
});

console.log('ops management navigation UI: OK');
