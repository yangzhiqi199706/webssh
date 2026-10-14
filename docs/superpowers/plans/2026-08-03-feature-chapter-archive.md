# Feature Chapter Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前 WebSSH 软件建立可检索的功能章节档案，并让后续新增功能能以命令和仓库规则自动形成下一章记录。

**Architecture:** 在 `docs/development-chapters/` 中保存以“第NN章-日期-主题”命名的长期交付文档，`README.md` 作为总目录。一个无依赖 Node 脚本负责分配下一章编号、创建统一模板并重建目录；`AGENTS.md` 将该脚本纳入后续功能交付的必经步骤。

**Tech Stack:** Markdown、Node.js 12 CommonJS、Node 内置 `fs/path/assert`。

---

### Task 1: 建立章节创建命令

**Files:**
- Create: `tests/feature-chapter-tools.test.js`
- Create: `scripts/create-feature-chapter.js`
- Modify: `package.json`

- [ ] **Step 1: 写出失败测试**

```js
const result = createFeatureChapter({
  rootDir: sandbox,
  title: '串口稳定性优化',
  summary: '清理残留桥接进程',
  scope: ['串口转网口'],
  files: ['serial/bridge-manager.js'],
  verification: ['npm test'],
});

assert.strictEqual(result.number, 1);
assert.match(result.fileName, /^第01章-\d{4}-\d{2}-\d{2}-串口稳定性优化\.md$/);
```

- [ ] **Step 2: 运行失败测试**

Run: `node tests/feature-chapter-tools.test.js`

Expected: 因 `scripts/create-feature-chapter.js` 尚不存在而失败。

- [ ] **Step 3: 实现最小创建器**

```js
function createFeatureChapter(options) {
  const number = nextChapterNumber(chapterDir);
  const fileName = formatFileName(number, date, title);
  fs.writeFileSync(path.join(chapterDir, fileName), renderChapter(options));
  rebuildIndex(chapterDir);
  return { number, fileName };
}
```

脚本应接受 `--title`、`--summary`、`--scope`、`--files`、`--verification` 参数，并在成功时输出创建的文件路径。

- [ ] **Step 4: 验证测试通过**

Run: `node tests/feature-chapter-tools.test.js`

Expected: 新建第 01 章与第 02 章，且 `README.md` 同时列出二者。

- [ ] **Step 5: 加入 npm 入口**

```json
"docs:chapter": "node scripts/create-feature-chapter.js"
```

### Task 2: 归档当前软件基线

**Files:**
- Create: `docs/development-chapters/README.md`
- Create: `docs/development-chapters/第01章-2026-08-03-WebSSH主壳与会话管理.md`
- Create: `docs/development-chapters/第02章-2026-08-03-SSH终端与SFTP文件管理.md`
- Create: `docs/development-chapters/第03章-2026-08-03-串口调试与串口转网口.md`
- Create: `docs/development-chapters/第04章-2026-08-03-TCP调试与网络会话.md`
- Create: `docs/development-chapters/第05章-2026-08-03-服务总览与运维指挥台.md`
- Create: `docs/development-chapters/第06章-2026-08-03-系统设置与网络防护.md`
- Create: `docs/development-chapters/第07章-2026-08-03-本地账号与访问控制.md`
- Create: `docs/development-chapters/第08章-2026-08-03-信创短信猫告警与推送.md`
- Create: `docs/development-chapters/第09章-2026-08-03-双机热备与故障切换.md`
- Create: `docs/development-chapters/第10章-2026-08-03-协议转换接口工作台.md`
- Create: `docs/development-chapters/第11章-2026-08-03-工业协议转发服务.md`
- Create: `docs/development-chapters/第12章-2026-08-03-协议助手文档处理平台.md`
- Create: `docs/development-chapters/第13章-2026-08-03-数据库管理与数据源切换.md`
- Create: `docs/development-chapters/第14章-2026-08-03-视频监控与GB28181接入.md`
- Create: `docs/development-chapters/第15章-2026-08-03-离线部署升级与回滚.md`
- Create: `docs/development-chapters/第16章-2026-08-03-测试质量与交付规范.md`

- [ ] **Step 1: 按现有模块撰写 16 章基线**

每章统一包含功能目标、能力范围、核心文件、配置/运行约定、验证方式和后续注意事项；不写账号密码、令牌或真实敏感配置。

- [ ] **Step 2: 建立目录与模板说明**

`README.md` 列出 16 章、命名规则、章节必填字段，以及创建下一章的完整命令。

### Task 3: 固化后续自动记录规则

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 增加“功能章节归档”规则**

在完成新功能、功能性修复或运维能力扩展时，先运行 `npm run docs:chapter -- ...`，补充实际验证结果后，才能提交或部署。纯排版、拼写修正、无行为变化的依赖锁定调整不需要新章。

- [ ] **Step 2: 复核内容与链接**

Run: `node tests/feature-chapter-tools.test.js; npm test; git diff --check`

Expected: 创建器测试、现有回归测试、空白错误检查均通过。
