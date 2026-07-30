'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  logRotation: {
    enabled: true,
    retentionDays: 30,
    lastRotationDate: '',
    lastResult: null,
  },
  idleDisconnect: {
    enabled: false,
    timeoutMinutes: 30,
  },
};

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function normalize(value) {
  const source = value && typeof value === 'object' ? value : {};
  const logRotation = source.logRotation && typeof source.logRotation === 'object' ? source.logRotation : {};
  const idleDisconnect = source.idleDisconnect && typeof source.idleDisconnect === 'object' ? source.idleDisconnect : {};
  const rotationDate = String(logRotation.lastRotationDate || '');

  return {
    logRotation: {
      enabled: toBoolean(logRotation.enabled, DEFAULTS.logRotation.enabled),
      retentionDays: clamp(logRotation.retentionDays, 1, 3650, DEFAULTS.logRotation.retentionDays),
      lastRotationDate: /^\d{4}-\d{2}-\d{2}$/.test(rotationDate) ? rotationDate : '',
      lastResult: logRotation.lastResult && typeof logRotation.lastResult === 'object' ? logRotation.lastResult : null,
    },
    idleDisconnect: {
      enabled: toBoolean(idleDisconnect.enabled, DEFAULTS.idleDisconnect.enabled),
      timeoutMinutes: clamp(idleDisconnect.timeoutMinutes, 1, 1440, DEFAULTS.idleDisconnect.timeoutMinutes),
    },
  };
}

function localDateKey(date) {
  const d = date || new Date();
  const pad = function (value) { return String(value).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function writeJsonAtomic(fileSystem, filePath, value, pathModule) {
  const fileOps = fileSystem || fs;
  const pathOps = pathModule || path;
  const directory = pathOps.dirname(filePath);
  const tempPath = pathOps.join(directory, pathOps.basename(filePath) + '.tmp-' + process.pid + '-' + Date.now());
  let fd = null;

  try {
    fileOps.mkdirSync(directory, { recursive: true });
    fd = fileOps.openSync(tempPath, 'wx', 0o600);
    fileOps.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    if (typeof fileOps.fsyncSync === 'function') fileOps.fsyncSync(fd);
    fileOps.closeSync(fd);
    fd = null;
    fileOps.chmodSync(tempPath, 0o600);
    fileOps.renameSync(tempPath, filePath);
    fileOps.chmodSync(filePath, 0o600);
  } catch (error) {
    if (fd !== null) {
      try { fileOps.closeSync(fd); } catch (_closeError) {}
    }
    try { fileOps.unlinkSync(tempPath); } catch (_unlinkError) {}
    throw error;
  }
}

function writeJsonThenCommit(fileSystem, filePath, value, commit, pathModule) {
  writeJsonAtomic(fileSystem, filePath, value, pathModule);
  if (typeof commit === 'function') commit(value);
  return value;
}

function recordLogRotation(value, dateKey, result) {
  const next = normalize(value);
  const date = String(dateKey || '');
  if (result && result.ok === true && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    next.logRotation.lastRotationDate = date;
  }
  next.logRotation.lastResult = result && typeof result === 'object' ? result : null;
  return next;
}

module.exports = {
  DEFAULTS,
  normalize,
  localDateKey,
  writeJsonAtomic,
  writeJsonThenCommit,
  recordLogRotation,
};
