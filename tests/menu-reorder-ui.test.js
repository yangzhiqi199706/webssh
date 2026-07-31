'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const reorderCode = /const MENU_ORDER_KEY[\s\S]*?(?=\n\s*state\.activeMenu = 'ssh';)/.exec(html);
const renderMenuCode = /function renderMenu\(\)[\s\S]*?(?=\n\s*function showView\(view\))/.exec(html);
assert.ok(reorderCode, '菜单排序逻辑必须可独立加载');
assert.ok(renderMenuCode, '菜单渲染逻辑必须可独立加载');

const noTargetContext = {
  el: { menuBar: { querySelectorAll: function () { return []; } } },
  localStorage: { getItem: function () { return null; }, setItem: function () {} },
  clearTimeout: function () {},
  setTimeout: function () { return 1; },
};

vm.runInNewContext(reorderCode[0] + "\nmenuDrag = { started: true, drop: null, itemId: 'sms', node: { classList: { remove: function () {} } } };\nfinishMenuDrag();\nresult = { suppressMenuClick: suppressMenuClick, menuDrag: menuDrag };", noTargetContext);
assert.strictEqual(noTargetContext.result.suppressMenuClick, true, '长按后未落在有效目标上释放也不得误触菜单切换');
assert.strictEqual(noTargetContext.result.menuDrag, null, '无效拖放后必须清理拖动状态');

const storedOrders = [];
const dragHandlers = {};
const sourceClasses = new Set();
const targetClasses = new Set();
const sourceNode = {
  dataset: { menu: 'sms' },
  addEventListener: function (type, handler) { dragHandlers[type] = handler; },
  setPointerCapture: function () {},
  classList: { add: function (name) { sourceClasses.add(name); }, remove: function (name) { sourceClasses.delete(name); }, contains: function (name) { return sourceClasses.has(name); } },
};
const targetNode = {
  dataset: { menu: 'ha' },
  closest: function () { return this; },
  getBoundingClientRect: function () { return { top: 0, height: 100 }; },
  classList: { add: function (name) { targetClasses.add(name); }, remove: function (name) { targetClasses.delete(name); }, contains: function (name) { return targetClasses.has(name); } },
};
const dragTimers = [];
const validDragContext = {
  menuItems: [{ id: 'ssh' }, { id: 'sms' }, { id: 'ha' }],
  el: { menuBar: { contains: function (node) { return node === sourceNode || node === targetNode; }, querySelectorAll: function () { return [sourceNode, targetNode]; } } },
  document: { elementFromPoint: function () { return targetNode; } },
  localStorage: { getItem: function () { return null; }, setItem: function (_key, value) { storedOrders.push(JSON.parse(value)); } },
  clearTimeout: function () {},
  setTimeout: function (callback, delay) { dragTimers.push({ callback: callback, delay: delay }); return dragTimers.length; },
  renderMenu: function () { validDragContext.rendered = (validDragContext.rendered || 0) + 1; },
};
Object.assign(validDragContext, { sourceNode: sourceNode, targetNode: targetNode, dragHandlers: dragHandlers, dragTimers: dragTimers, storedOrders: storedOrders });
validDragContext.validDragContext = validDragContext;

vm.runInNewContext(reorderCode[0] + "\nbindMenuDrag(sourceNode);\ndragHandlers.pointerdown({ button: 0, pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 10 });\nconst touchIgnored = menuDrag === null;\ndragHandlers.pointerdown({ button: 2, pointerType: 'mouse', pointerId: 2, clientX: 10, clientY: 10 });\nconst rightClickIgnored = menuDrag === null;\ndragHandlers.pointerdown({ button: 0, pointerType: 'mouse', pointerId: 3, clientX: 10, clientY: 10 });\ndragTimers[0].callback();\nconst longPressStarted = sourceNode.classList.contains('menu-drag-source');\ndragHandlers.pointermove({ pointerId: 3, clientX: 20, clientY: 75, preventDefault: function () { validDragContext.prevented = true; } });\nconst dropIndicatorShown = targetNode.classList.contains('menu-drop-after');\ndragHandlers.pointerup({ pointerId: 3 });\nresult = { touchIgnored: touchIgnored, rightClickIgnored: rightClickIgnored, longPressStarted: longPressStarted, dropIndicatorShown: dropIndicatorShown, dragDelay: dragTimers[0].delay, reorderDelay: MENU_REORDER_DELAY_MS, savedOrder: storedOrders[0], rendered: validDragContext.rendered, prevented: validDragContext.prevented };", validDragContext);
assert.strictEqual(validDragContext.result.touchIgnored, true, '触摸指针不得启动菜单排序');
assert.strictEqual(validDragContext.result.rightClickIgnored, true, '非左键不得启动菜单排序');
assert.strictEqual(validDragContext.result.longPressStarted, true, '达到长按延迟后必须进入拖动状态');
assert.strictEqual(validDragContext.result.reorderDelay, 450, '菜单排序长按延迟必须固定为 450ms');
assert.strictEqual(validDragContext.result.dragDelay, validDragContext.result.reorderDelay, '长按计时器必须使用菜单排序延迟常量');
assert.strictEqual(validDragContext.result.dropIndicatorShown, true, '拖动到目标下半区必须显示后插入标记');
assert.deepStrictEqual(validDragContext.result.savedOrder, ['ssh', 'ha', 'sms'], '有效拖放必须按目标位置保存排序');
assert.strictEqual(validDragContext.result.rendered, 1, '有效拖放后必须重绘功能菜单');
assert.strictEqual(validDragContext.result.prevented, true, '拖动过程中必须阻止默认指针行为');

const clickNode = { dataset: { menu: 'serial' }, addEventListener: function () {}, classList: { add: function () {}, remove: function () {} } };
const clickContext = {
  menuItems: [{ id: 'serial', label: '串口调试', icon: 'COM', title: '串口调试' }],
  el: { menuBar: { querySelectorAll: function () { return [clickNode]; } } },
  state: { activeMenu: 'ssh' },
  esc: function (value) { return value; },
  localStorage: { getItem: function () { return null; }, setItem: function () {} },
  clearTimeout: function () {},
  setTimeout: function () { return 1; },
  showView: function (id) { clickContext.shownView = id; },
};
clickContext.clickNode = clickNode;
clickContext.clickContext = clickContext;

vm.runInNewContext(reorderCode[0] + "\n" + renderMenuCode[0] + "\nrenderMenu();\nclickNode.onclick({ preventDefault: function () { clickContext.prevented = true; } });\nresult = { shownView: clickContext.shownView, prevented: clickContext.prevented || false };", clickContext);
assert.strictEqual(clickContext.result.shownView, 'serial', '普通菜单点击必须继续调用原有功能切换');
assert.strictEqual(clickContext.result.prevented, false, '普通菜单点击不得被拖动抑制逻辑拦截');
assert.ok(html.includes("const MENU_ORDER_KEY = 'webssh.menu-order.v1';"), '功能排序必须使用独立的本地持久化键');
assert.ok(/function getMenuItemsInDisplayOrder\(\)/.test(html), '功能菜单必须根据已保存顺序渲染');
assert.ok(/function saveMenuOrder\(items\)/.test(html), '拖动排序必须写回本地存储');
assert.ok(html.includes("addEventListener('pointerdown'"), '菜单项必须支持鼠标左键长按启动');
assert.ok(html.includes("addEventListener('pointermove'"), '菜单项必须支持拖动中的目标计算');
assert.ok(html.includes("addEventListener('pointerup'"), '菜单项必须在释放鼠标时提交排序');
assert.ok(html.includes('MENU_REORDER_DELAY_MS'), '长按排序必须有明确延迟，避免影响普通单击');
assert.ok(html.includes('menu-drag-source'), '拖动源必须有可见状态');
assert.ok(html.includes('menu-drop-before') && html.includes('menu-drop-after'), '放置位置必须有明确提示');
assert.ok(html.includes('suppressMenuClick'), '拖动释放后不得误触功能切换');
assert.ok(html.includes("event.pointerType !== 'mouse'"), '功能排序仅接受鼠标左键手势');
assert.ok(html.includes('const byId = Object.create(null);') && html.includes('const seen = Object.create(null);'), '菜单 ID 映射必须避免对象原型键冲突');
console.log('menu reorder UI: OK');
