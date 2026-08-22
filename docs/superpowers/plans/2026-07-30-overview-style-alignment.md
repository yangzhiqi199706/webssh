# 运维指挥台视觉统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让运维指挥台复用双机热备、数据库管理和协议转换的深色运维界面规范，不改变只读监控能力或数据接口。

**Architecture:** 保持现有 iframe、DOM ID、数据渲染脚本与 API 不变。仅通过 `overview/index.html` 统一顶栏语义和组件类名，通过 `overview/assets/css/style.css` 引入同源的 token、顶栏、按钮、卡片、状态与响应式规范；在已有 UI 静态测试中固定这些跨子站设计契约。

**Tech Stack:** 原生 HTML、CSS、JavaScript、Node `assert` 测试。

---

## 文件结构

- 修改：`overview/index.html` — 使用与现有子站一致的 44px 顶栏、按钮和信息卡类名，保留全部 DOM ID。
- 修改：`overview/assets/css/style.css` — 复用 `#020617/#0f172a/#111827`、8px 按钮、12px 卡片与状态光晕规范，补齐可访问焦点、减少动画和响应式布局。
- 修改：`tests/service-overview-ui.test.js` — 断言共享的视觉基元，防止将来重新漂移成孤立样式。

### Task 1: 统一运维指挥台视觉基元

**Files:**
- Modify: `tests/service-overview-ui.test.js`
- Modify: `overview/index.html`
- Modify: `overview/assets/css/style.css`

- [ ] **Step 1: 编写失败的视觉契约测试**

在 `tests/service-overview-ui.test.js` 读取 `overview/assets/css/style.css`，新增以下断言：

```js
assert.ok(overviewHtml.includes('class="top-bar"'), '服务总览必须使用子站统一的 top-bar 顶栏');
assert.ok(overviewHtml.includes('class="btn primary refresh-button"'), '刷新操作必须复用子站 primary 按钮');
[
  '--bg:#020617', '--panel:#0f172a', '--panel-2:#111827', '--border:#1f2937',
  '.top-bar {', 'height:44px', '.btn {', 'border-radius:8px',
  '.overview-card {', 'border-radius:12px', '@media (prefers-reduced-motion:reduce)',
].forEach(function (needle) {
  assert.ok(overviewCss.includes(needle), '服务总览缺少统一视觉基元：' + needle);
});
```

- [ ] **Step 2: 确认测试因当前孤立样式失败**

运行：`node tests/service-overview-ui.test.js`

预期：以“服务总览必须使用子站统一的 top-bar 顶栏”失败。

- [ ] **Step 3: 实现最小样式统一**

在 `overview/index.html` 把顶部结构改为 `top-bar`，为刷新按钮加 `btn primary refresh-button`，并把内容纳入 `dashboard-content`。保留 `overviewRefresh`、`overviewUpdatedAt`、`overviewHealth`、`overviewRole`、`overviewHosts`、`overviewServices`、`overviewAlerts`、`overviewTrend` 与所有标题、ARIA 属性和脚本地址。

在 `overview/assets/css/style.css`：

```css
:root {
  --bg:#020617;
  --panel:#0f172a;
  --panel-2:#111827;
  --border:#1f2937;
  --cyan:#22d3ee;
  --green:#34d399;
  --amber:#fbbf24;
  --red:#f87171;
}
.top-bar { height:44px; background:#0f172a; border-bottom:1px solid var(--border); }
.btn { border:1px solid #334155; border-radius:8px; background:#0b1220; }
.overview-card { border:1px solid var(--border); border-radius:12px; background:rgba(2,6,23,.5); }
```

使用现有子站的深色表面、分割线、按钮状态和状态光晕；`focus-visible` 使用青色 ring；动效限制为颜色/透明度 160ms，并在 `prefers-reduced-motion: reduce` 下关闭。桌面保持主机双列、趋势三列，1024px 以下按可读密度换行，620px 以下堆叠且不得出现横向滚动。不得修改 `overview/assets/js/overview.js`，不得增加控制接口、自动刷新或新的外部依赖。

- [ ] **Step 4: 验证视觉契约与回归**

运行：`node tests/service-overview-ui.test.js`

预期：输出 `service overview UI: OK`。

运行：`npm test`

预期：退出码为 0，所有既有测试继续通过。

- [ ] **Step 5: 检查桌面和窄屏视觉表现**

在 `http://192.168.0.60:3010/overview/index.html` 分别以 1440px、1024px、375px 宽度检查：顶栏、刷新按钮、资源卡、服务矩阵、告警列表与趋势图无溢出、无重叠、文字不被裁切；刷新时保留现有 loading 状态。
