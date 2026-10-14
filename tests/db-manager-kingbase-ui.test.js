'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(require('path').join(__dirname, '../db/index.html'), 'utf8');
const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]);
assert.equal(ids.length, new Set(ids).size, 'DOM ID 不得重复');
assert(html.slice(html.indexOf('data-pane="overview"'), html.indexOf('data-pane="console"')).includes('id="cardKingbase"'), '金仓卡片必须位于概览内');
['kingbaseDot', 'kingbaseKv', 'kingbaseActions', 'cfKingbaseHost', 'cfKingbasePort', 'cfKingbaseUser', 'cfKingbasePass', 'cfKingbaseDb', 'cfKingbaseSchema', 'cfKingbaseUnit', 'cfKingbaseBinDir', 'cfKingbaseContainerPort', 'cfKingbaseSshHost', 'cfKingbaseSshPort', 'cfKingbaseSshUser', 'cfKingbaseSshPass', 'cfKingbaseContainer', 'btnTestKingbase'].forEach(id => assert(ids.includes(id), '缺少控件 ' + id));
assert.equal((html.match(/data-db="kingbase"/g) || []).length, 2, '控制台与库表浏览均应可选金仓');
for (const id of ['bkDbId', 'rsDbId']) {
  const select = html.slice(html.indexOf('id="' + id + '"')).split('</select>')[0];
  assert(select.includes('value="kingbase"'), id + ' 应支持金仓');
}
assert(html.includes('b.dataset.schema'), '查看表应传递 Schema');
assert(html.includes('encodeURIComponent(schema)'), 'Schema 必须进行 URL 编码');
assert(html.includes("testTarget('kingbase', 'hintKingbase')"));
assert(html.includes("renderDbCard('kingbase'"));
['kingbaseLicenseModal', 'kingbaseLicenseKv', 'kingbaseLicenseFileKv', 'kingbaseLicenseFile', 'btnUploadKingbaseLicense', 'btnRefreshKingbaseLicense'].forEach(id => assert(ids.includes(id), '缺少授权控件 ' + id));
assert(html.includes('btnKingbaseLicense'), '金仓卡片应有授权入口');
assert(html.includes('/kingbase/upload-license'));
assert(html.includes('confirmRestart: true'));
for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
console.log('kingbase UI: OK');
