'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const stream = require('stream');
const util = require('util');

const pipeline = util.promisify(stream.pipeline);
const ACTIVE_LOG_RE = /\.log$/;
const ARCHIVE_LOG_RE = /\.log\.\d{8}(?:-\d{6}(?:-\d+)?)?\.gz$/;

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateStamp(date) {
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
}

function timeStamp(date) {
  return pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
}

function archivePath(logPath, date, force) {
  const base = logPath + '.' + dateStamp(date);
  const standard = base + '.gz';
  if (!force && !fs.existsSync(standard)) return standard;
  if (!fs.existsSync(standard)) return standard;

  const timestamped = base + '-' + timeStamp(date);
  let candidate = timestamped + '.gz';
  let sequence = 2;
  while (fs.existsSync(candidate)) {
    candidate = timestamped + '-' + sequence + '.gz';
    sequence += 1;
  }
  return candidate;
}

async function compressAndTruncate(logPath, outputPath) {
  await pipeline(
    fs.createReadStream(logPath),
    zlib.createGzip(),
    fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }),
  );
  fs.truncateSync(logPath, 0);
}

async function rotateLogs(options) {
  const settings = options || {};
  const logDir = settings.logDir;
  const now = settings.now || new Date();
  const retentionDays = Math.max(1, Math.floor(Number(settings.retentionDays) || 30));
  const rotated = [];
  const deleted = [];

  if (!logDir) throw new Error('logDir 必填');
  fs.mkdirSync(logDir, { recursive: true });

  const names = fs.readdirSync(logDir).sort();
  for (const name of names) {
    if (!ACTIVE_LOG_RE.test(name)) continue;
    const logPath = path.join(logDir, name);
    const stat = fs.lstatSync(logPath);
    if (!stat.isFile() || stat.size <= 0) continue;
    const outputPath = archivePath(logPath, now, Boolean(settings.force));
    await compressAndTruncate(logPath, outputPath);
    rotated.push(name);
  }

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(logDir).sort()) {
    if (!ARCHIVE_LOG_RE.test(name)) continue;
    const archive = path.join(logDir, name);
    const stat = fs.lstatSync(archive);
    if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
    fs.unlinkSync(archive);
    deleted.push(name);
  }

  return {
    rotated: rotated,
    deleted: deleted,
    finishedAt: now.toISOString(),
  };
}

module.exports = {
  rotateLogs,
};
