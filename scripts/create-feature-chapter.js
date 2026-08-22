#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const CHAPTER_PATTERN = /^第(\d+)章-.*\.md$/;

function splitList(value) {
  return String(value || '')
    .split(',')
    .map(function (item) { return item.trim(); })
    .filter(Boolean);
}

function dateInChina(now) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function chapterDirectory(rootDir) {
  return path.join(rootDir, 'docs', 'development-chapters');
}

function nextChapterNumber(directory) {
  if (!fs.existsSync(directory)) return 1;
  return fs.readdirSync(directory).reduce(function (maximum, fileName) {
    const match = fileName.match(CHAPTER_PATTERN);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0) + 1;
}

function safeTitle(title) {
  const normalized = String(title || '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) throw new Error('章节标题不能为空，且不能只包含文件名保留字符。');
  return normalized;
}

function listSection(items, fallback) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  return values.length ? values.map(function (item) { return '- `' + item + '`'; }).join('\n') : '- ' + fallback;
}

function renderChapter(options) {
  const scope = options.scope || [];
  const files = options.files || [];
  const verification = options.verification || [];
  return [
    '# 第' + String(options.number).padStart(2, '0') + '章 - ' + options.title,
    '',
    '日期：' + options.date,
    '状态：功能记录',
    '',
    '## 功能目标',
    '',
    options.summary,
    '',
    '## 开发范围',
    '',
    listSection(scope, '未提供范围说明。'),
    '',
    '## 关联文件',
    '',
    listSection(files, '未提供关联文件。'),
    '',
    '## 验证记录',
    '',
    listSection(verification, '待补充实际验证结果。'),
    '',
    '## 后续注意事项',
    '',
    '- 后续扩展本功能时，新增下一章记录具体变更，不回写本章的已交付结论。',
    '',
  ].join('\n');
}

function chapterEntries(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .map(function (fileName) {
      const match = fileName.match(CHAPTER_PATTERN);
      if (!match) return null;
      return { fileName: fileName, number: Number(match[1]) };
    })
    .filter(Boolean)
    .sort(function (left, right) { return left.number - right.number; });
}

function renderIndex(entries) {
  const links = entries.length
    ? entries.map(function (entry) { return '- [' + entry.fileName.replace(/\.md$/, '') + '](./' + entry.fileName + ')'; }).join('\n')
    : '- 暂无功能章节。';
  return [
    '# WebSSH 功能章节档案',
    '',
    '本目录按“第NN章-日期-主题.md”保存功能交付记录。第 01 至 16 章是 2026-08-03 对现有软件的基线整理；后续功能从下一章开始按实际交付日期递增记录。',
    '',
    '## 章节目录',
    '',
    links,
    '',
    '## 新功能自动归档',
    '',
    '完成新功能、功能性修复或运维能力扩展后，在提交或部署前执行：',
    '',
    '```powershell',
    'npm run docs:chapter -- --title "功能名称" --summary "本次交付的结果" --scope "能力一,能力二" --files "server.js,index.html" --verification "npm test,手工验证步骤"',
    '```',
    '',
    '命令会自动分配章节编号、创建标准模板并刷新本目录。随后必须把“验证记录”和“后续注意事项”补充为实际结果。仅修改排版、拼写或不改变行为的锁文件时，不创建章节。',
    '',
  ].join('\n');
}

function rebuildIndex(rootDir) {
  const directory = chapterDirectory(rootDir);
  fs.mkdirSync(directory, { recursive: true });
  const indexPath = path.join(directory, 'README.md');
  fs.writeFileSync(indexPath, renderIndex(chapterEntries(directory)), 'utf8');
  return indexPath;
}

function createFeatureChapter(options) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const title = safeTitle(options.title);
  const summary = String(options.summary || '').trim();
  if (!summary) throw new Error('章节摘要不能为空。');
  const directory = chapterDirectory(rootDir);
  fs.mkdirSync(directory, { recursive: true });
  const number = nextChapterNumber(directory);
  const date = options.date || dateInChina(new Date());
  const fileName = '第' + String(number).padStart(2, '0') + '章-' + date + '-' + title + '.md';
  const outputPath = path.join(directory, fileName);
  fs.writeFileSync(outputPath, renderChapter({
    number: number,
    date: date,
    title: title,
    summary: summary,
    scope: options.scope || [],
    files: options.files || [],
    verification: options.verification || [],
  }), 'utf8');
  rebuildIndex(rootDir);
  return { number: number, fileName: fileName, outputPath: outputPath };
}

function parseCliArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.indexOf('--') !== 0) continue;
    const key = token.slice(2);
    const nextValue = argv[index + 1];
    if (!nextValue || nextValue.indexOf('--') === 0) {
      options[key] = true;
      continue;
    }
    options[key] = nextValue;
    index += 1;
  }
  return options;
}

function runCli() {
  const args = parseCliArguments(process.argv.slice(2));
  if (args.help || !args.title || !args.summary) {
    console.log('用法：npm run docs:chapter -- --title "功能名称" --summary "交付结果" [--scope "范围一,范围二"] [--files "文件一,文件二"] [--verification "npm test,手工验证"]');
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  try {
    const result = createFeatureChapter({
      title: args.title,
      summary: args.summary,
      scope: splitList(args.scope),
      files: splitList(args.files),
      verification: splitList(args.verification),
    });
    console.log('已创建功能章节：' + result.outputPath);
  } catch (error) {
    console.error('创建功能章节失败：' + error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli();

module.exports = {
  createFeatureChapter: createFeatureChapter,
  rebuildIndex: rebuildIndex,
};
