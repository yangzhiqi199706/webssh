const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'serial', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'serial', 'assets', 'css', 'serial-bridge.css'), 'utf8');
let ui = '';
try { ui = fs.readFileSync(path.join(root, 'serial', 'assets', 'js', 'serial-bridge.js'), 'utf8'); } catch (_err) {}

assert.ok(html.includes('id="button-bridge-settings"'), '串口调试工具栏必须提供串口转网口入口');
assert.ok(html.includes('id="serial-bridge-drawer"'), '串口转网口必须使用独立配置面板');
assert.ok(html.includes('id="serial-bridge-port-table"'), '配置面板必须展示端口参数表');
assert.ok(html.includes('id="serial-bridge-communication"'), '配置面板必须展示通信设置');
assert.ok(ui.includes('/api/serial/bridge/config'), '配置面板必须读取并保存服务端配置');
assert.ok(ui.includes('/api/serial/bridge/status'), '配置面板必须刷新桥接运行状态');
assert.ok(ui.includes("'/api/serial/ports?probe=1'"), '扫描按钮必须复用现有串口扫描接口');
assert.ok(!/serial-bridge-drawer[^\n]*addEventListener\(['"]click/.test(ui), '不得通过点击面板外区域自动关闭');
assert.ok(
  /drawer\.addEventListener\(['"]change['"][\s\S]*?state\.dirty = true;[\s\S]*?state\.config = collectConfig\(\)/.test(ui),
  '未保存的勾选或参数变更必须同步到内存配置，避免状态轮询重新渲染时丢失'
);
const refreshStatusSource = /async function refreshStatus\(\) \{([\s\S]*?)\n  \}/.exec(ui);
assert.ok(refreshStatusSource, '配置面板必须实现状态刷新函数');
assert.ok(refreshStatusSource[1].includes('renderPortStatuses()'), '状态轮询只能更新运行状态，不能重绘正在编辑的字段');
assert.ok(!refreshStatusSource[1].includes('renderPorts()'), '状态轮询不得重绘整张端口配置表');
assert.ok(
  /async function invokePortAction\(id, action\) \{[\s\S]*?if \(action === 'start' && state\.dirty\) \{[\s\S]*?await saveConfig\(false\)[\s\S]*?\}[\s\S]*?正在启动端口/.test(ui),
  '逐路启动前必须保存当前编辑的配置，不能使用过期参数启动'
);
assert.ok(
  /if \(action === 'stop' && state\.dirty\) \{[\s\S]*?当前配置尚未保存/.test(ui),
  '停止运行中的端口不得被未保存配置拦截，页面必须提示配置仍待保存'
);
assert.ok(ui.includes('serial-bridge-port-card'), '端口配置必须使用自适应配置块呈现全部字段');
assert.ok(ui.includes('migrateDetectedDevicePaths'), '扫描后必须将旧 ttyO 默认值映射为实际可用的 ttyS 设备');
assert.ok(!css.includes('min-width: 1060px'), '端口配置不得使用固定最小宽度挤出横向滚动条');
assert.ok(/\.serial-bridge-table-wrap\s*\{\s*overflow-x:\s*(?:hidden|clip)/.test(css), '端口配置容器必须禁止横向滚动');

console.log('serial bridge UI contract: passed');
