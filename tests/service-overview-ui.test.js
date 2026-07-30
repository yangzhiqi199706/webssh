const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = function (relativePath) {
  const filePath = path.join(root, relativePath);
  assert.ok(fs.existsSync(filePath), relativePath + ' 必须存在');
  return fs.readFileSync(filePath, 'utf8');
};

const mainHtml = read('index.html');
const overviewHtml = read('overview/index.html');
const overviewJs = read('overview/assets/js/overview.js');

assert.ok(mainHtml.includes("id: 'overview'"), '主壳菜单必须含服务总览');
assert.ok(mainHtml.includes('id="overviewView"'), '主壳必须有服务总览视图区');
assert.ok(mainHtml.includes('id="overviewFrame"'), '主壳必须有服务总览 iframe');
assert.ok(mainHtml.includes('./overview/index.html'), '服务总览 iframe 必须指向子站入口');
assert.ok(/function showView\(view\)[\s\S]*?isOverview/.test(mainHtml), 'showView 必须支持服务总览');

[
  'overviewRefresh',
  'overviewUpdatedAt',
  'overviewAlerts',
  'overviewServices',
  'overviewTrend',
].forEach(function (id) {
  assert.ok(overviewHtml.includes('id="' + id + '"'), '服务总览缺少 #' + id);
});
assert.ok(overviewHtml.includes('<h1>服务总览</h1>'), '服务总览页面必须使用“服务总览”标题');

assert.ok(overviewJs.includes('/api/service-overview'), '服务总览必须读取只读快照');
assert.ok(overviewJs.includes('/api/service-overview/refresh'), '服务总览必须支持手动刷新');
assert.ok(overviewJs.includes("getContext('2d')"), '趋势图必须使用 Canvas 2D');
assert.ok(overviewJs.includes('drawTrend'), '服务总览必须绘制趋势图');
assert.ok(overviewJs.includes("setAttribute('aria-busy', 'true')"), '手动刷新必须设置 aria-busy');
assert.ok(overviewJs.includes("setAttribute('aria-busy', 'false')"), '手动刷新结束必须恢复 aria-busy');
assert.ok(overviewJs.includes('renderRequestError'), '请求失败必须展示脱敏服务端消息');
assert.ok(!overviewJs.includes('target && target.error'), '不可达状态不得回显探针错误详情');
assert.ok(overviewJs.includes('负载'), '主机资源必须独立展示负载');
[
  'webssh',
  'webssh-protocol',
  'docker',
  'dcim 容器',
  'dcim 采集',
].forEach(function (name) {
  assert.ok(overviewJs.includes(name), '服务矩阵必须包含 ' + name);
});
assert.ok(overviewJs.includes('filterRecentHistory'), '前端必须只绘制近 7 天历史');
assert.ok(!/(restart|failover|switch|PUT\s|DELETE\s)/i.test(overviewJs), '服务总览不得包含控制类操作');
assert.ok(overviewJs.includes('esc(str(target.load && target.load.oneMinute))'), '负载字段必须经 HTML 转义后再渲染');

function element() {
  return {
    innerHTML: '', textContent: '', hidden: false, disabled: false,
    attributes: {}, addEventListener: function (name, listener) { this[name] = listener; },
    setAttribute: function (name, value) { this.attributes[name] = value; },
    querySelectorAll: function () { return []; },
  };
}

async function runRenderedPageCheck() {
  const hosts = [element(), element()];
  const elements = {
    overviewRefresh: element(), overviewUpdatedAt: element(), overviewHealth: element(),
    overviewRole: element(), overviewRequestError: element(), overviewServices: element(),
    overviewAlerts: element(), overviewTrend: element(),
  };
  elements.overviewHosts = element();
  elements.overviewHosts.querySelectorAll = function () { return hosts; };
  const payload = {
    ok: true,
    snapshot: {
      sampledAt: new Date().toISOString(), selfRole: 'primary',
      local: {
        cpu: { percent: 10 }, memory: { percent: 20, usedKb: 100, totalKb: 200 },
        disk: { percent: 30, usedKb: 100, totalKb: 200 }, load: { oneMinute: '<img src=x onerror=alert(1)>' },
        uptime: { seconds: 3600 }, services: {
          webssh: { state: 'active', healthy: true }, protocol: { state: 'active', healthy: true },
          docker: { state: 'active', healthy: true }, dcim: { state: 'active', healthy: true, container: true },
        },
      },
      peer: { status: 'unknown' },
    }, history: [],
  };
  const browserWindow = { devicePixelRatio: 1, addEventListener: function () {} };
  vm.runInNewContext(overviewJs, {
    window: browserWindow,
    document: { getElementById: function (id) { return elements[id]; } },
    fetch: function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve(payload); } }); },
    Date: Date, Promise: Promise, isNaN: isNaN, isFinite: isFinite,
  });
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.strictEqual(hosts[0].innerHTML.includes('<img'), false, '动态负载值不得作为 HTML 注入');
  assert.ok(hosts[0].innerHTML.includes('&lt;img'), '动态负载值必须显示为转义文本');
}

runRenderedPageCheck().then(function () {
  console.log('service overview UI: OK');
}).catch(function (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
});
