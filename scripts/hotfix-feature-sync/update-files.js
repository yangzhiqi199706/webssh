'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
function allowed(file) {
  return ['server.js', 'package.json', 'package-lock.json', 'proto-conv/index.html',
    'node_modules/sax/package.json', 'node_modules/sax/LICENSE', 'node_modules/sax/README.md', 'node_modules/sax/lib/sax.js'].includes(file) ||
    /^proto-conv\/b-interface-[a-z-]+\.js$/.test(file) ||
    /^proto-conv\/assets\/js\/pc-(?:b-[a-z-]+|point-types)\.js$/.test(file) ||
    file === 'proto-conv/assets/css/pc-b-interface.css';
}
function plainPath(root, relative) {
  if (typeof relative !== 'string' || relative.split('/').some(p => !p || p === '.' || p === '..') || /[\\\x00-\x1f:]/.test(relative)) throw new Error('路径不安全');
  let current = root;
  const parts = relative.split('/');
  parts.forEach((part, index) => {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('路径含符号链接：' + relative);
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('父路径不是目录：' + relative);
      if (index === parts.length - 1 && !stat.isFile()) throw new Error('目标不是普通文件：' + relative);
    } else {
      // lstat also catches dangling symlinks, which existsSync deliberately ignores.
      try { fs.lstatSync(current); throw new Error('路径含失效符号链接：' + relative); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  });
  return current;
}
function entries(bundle) {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100) throw new Error('补丁文件清单无效');
  const seen = new Set();
  manifest.files.forEach(entry => {
    if (!entry || typeof entry.path !== 'string' || !allowed(entry.path)) throw new Error('文件超出累计热更新范围或路径不安全');
    if (seen.has(entry.path)) throw new Error('补丁清单存在重复文件');
    seen.add(entry.path);
    if (!hashPattern.test(entry.sha256) || !Array.isArray(entry.allowedBeforeHashes) ||
        entry.allowedBeforeHashes.some(h => !hashPattern.test(h)) || typeof entry.allowMissing !== 'boolean') throw new Error('补丁清单校验字段无效');
  });
  return manifest.files;
}
function preflight(app, bundle) {
  for (const entry of entries(bundle)) {
    const payload = plainPath(bundle, 'payload/' + entry.path), target = plainPath(app, entry.path);
    if (!fs.existsSync(payload) || digest(payload) !== entry.sha256) throw new Error('补丁文件校验失败：' + entry.path);
    if (fs.existsSync(target)) {
      if (![entry.sha256].concat(entry.allowedBeforeHashes).includes(digest(target))) throw new Error('目标含未知版本或定制修改，拒绝覆盖：' + entry.path);
    } else if (!entry.allowMissing) throw new Error('目标缺少基线必需文件：' + entry.path);
  }
}
function backupPath(app, backup) {
  const base = path.resolve(app, '.hotfix-backups');
  if (path.dirname(path.resolve(backup)) !== base || !/^feature-sync-[A-Za-z0-9-]+$/.test(path.basename(backup))) throw new Error('备份路径不安全');
  for (const dir of [base, backup]) if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory())) throw new Error('备份目录异常');
  return backup;
}
function prepare(app, bundle, backup) {
  preflight(app, bundle); backupPath(app, backup);
  if (fs.existsSync(backup)) throw new Error('备份编号已存在');
  const state = { files: [], createdDirectories: [] }, directories = new Set();
  for (const entry of entries(bundle)) {
    const target = plainPath(app, entry.path), exists = fs.existsSync(target);
    const stat = exists ? fs.statSync(target) : null;
    state.files.push({ path: entry.path, existed: exists, originalSha256: exists ? digest(target) : null,
      installedSha256: entry.sha256, mode: stat ? stat.mode & 0o777 : 0o644,
      uid: stat ? stat.uid : (process.getuid ? process.getuid() : 0), gid: stat ? stat.gid : (process.getgid ? process.getgid() : 0) });
    let parent = path.dirname(entry.path);
    while (parent !== '.') {
      if (!fs.existsSync(path.join(app, parent))) directories.add(parent.split(path.sep).join('/'));
      parent = path.dirname(parent);
    }
  }
  state.createdDirectories = Array.from(directories).sort((a, b) => b.length - a.length);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 }); fs.chmodSync(backup, 0o700);
  for (const entry of state.files) if (entry.existed) {
    const destination = path.join(backup, 'original', entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(app, entry.path), destination);
    if (digest(destination) !== entry.originalSha256) throw new Error('备份时文件发生变化：' + entry.path);
  }
  fs.writeFileSync(path.join(backup, 'state.json'), JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
function stateOf(app, backup) {
  backupPath(app, backup);
  const state = JSON.parse(fs.readFileSync(plainPath(backup, 'state.json'), 'utf8'));
  if (!Array.isArray(state.files) || !state.files.length || state.files.length > 100 || !Array.isArray(state.createdDirectories)) throw new Error('备份清单无效');
  const seen = new Set();
  state.files.forEach(entry => {
    if (!entry || !allowed(entry.path) || seen.has(entry.path) || typeof entry.existed !== 'boolean' ||
        !hashPattern.test(entry.installedSha256) || (entry.existed && !hashPattern.test(entry.originalSha256)) ||
        !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 ||
        !Number.isInteger(entry.uid) || entry.uid < 0 || !Number.isInteger(entry.gid) || entry.gid < 0) throw new Error('备份清单字段无效');
    seen.add(entry.path); plainPath(app, entry.path);
  });
  const parents = new Set();
  state.files.forEach(entry => { let parent = path.dirname(entry.path); while (parent !== '.') { parents.add(parent.split(path.sep).join('/')); parent = path.dirname(parent); } });
  if (state.createdDirectories.some(dir => !parents.has(dir))) throw new Error('备份目录清单路径不安全');
  return state;
}
function atomicWrite(app, entry, data) {
  const target = plainPath(app, entry.path);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  const temp = target + '.feature-sync-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temp, data, { flag: 'wx', mode: entry.mode });
    if (process.platform !== 'win32') fs.chownSync(temp, entry.uid, entry.gid);
    fs.chmodSync(temp, entry.mode);
    fs.renameSync(temp, target);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function apply(app, bundle, backup) {
  const state = stateOf(app, backup), files = entries(bundle);
  if (files.length !== state.files.length || files.some((e, i) => e.path !== state.files[i].path || e.sha256 !== state.files[i].installedSha256)) throw new Error('补丁与备份清单不一致');
  for (const entry of state.files) {
    const target = plainPath(app, entry.path);
    if (entry.existed ? !fs.existsSync(target) || digest(target) !== entry.originalSha256 : fs.existsSync(target)) throw new Error('备份后目标文件发生变化：' + entry.path);
  }
  preflight(app, bundle);
  for (const entry of state.files) atomicWrite(app, entry, fs.readFileSync(plainPath(bundle, 'payload/' + entry.path)));
}
function checkCurrent(app, backup) {
  for (const entry of stateOf(app, backup).files) {
    const target = plainPath(app, entry.path);
    if (!fs.existsSync(target) || digest(target) !== entry.installedSha256) throw new Error('程序存在后续更新或文件缺失，拒绝覆盖：' + entry.path);
  }
}
function restore(app, backup) {
  const state = stateOf(app, backup);
  // Validate every backup/current file before restoring any file.
  for (const entry of state.files) {
    if (entry.existed) {
      const original = plainPath(backup, 'original/' + entry.path);
      if (!fs.existsSync(original) || digest(original) !== entry.originalSha256) throw new Error('原文件备份校验失败：' + entry.path);
    }
    const target = plainPath(app, entry.path);
    if (fs.existsSync(target) && ![entry.originalSha256, entry.installedSha256].includes(digest(target))) throw new Error('程序存在后续更新，拒绝覆盖：' + entry.path);
  }
  for (const entry of state.files) {
    const target = plainPath(app, entry.path);
    if (entry.existed) atomicWrite(app, entry, fs.readFileSync(plainPath(backup, 'original/' + entry.path)));
    else if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  for (const dir of state.createdDirectories) {
    const destination = path.join(app, dir);
    if (fs.existsSync(destination)) {
      if (fs.lstatSync(destination).isSymbolicLink()) throw new Error('新增目录已变为符号链接，拒绝清理');
      try { fs.rmdirSync(destination); } catch (e) { if (!['ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; }
    }
  }
}
module.exports = { preflight, prepare, apply, checkCurrent, restore };
if (require.main === module) {
  try {
    const command = process.argv[2], args = process.argv.slice(3);
    if (!Object.prototype.hasOwnProperty.call(module.exports, command)) throw new Error('未知更新命令');
    module.exports[command].apply(null, args);
    console.log(command + ': OK');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
