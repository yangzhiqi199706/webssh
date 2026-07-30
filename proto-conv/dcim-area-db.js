'use strict';

const SUPPORTED_TYPES = ['mysql', 'opengauss', 'dm'];

function isSupportedType(value) {
  return SUPPORTED_TYPES.indexOf(String(value || '').toLowerCase()) >= 0;
}

function normalizeType(value) {
  const type = String(value || '').toLowerCase();
  return isSupportedType(type) ? type : 'mysql';
}

function defaultPort(type) {
  switch (normalizeType(type)) {
    case 'opengauss': return 5432;
    case 'dm': return 5236;
    default: return 3333;
  }
}

function mergeConnectionConfig(input, saved) {
  const draft = input && typeof input === 'object' ? input : {};
  const current = saved && typeof saved === 'object' ? saved : {};
  const type = isSupportedType(draft.type) ? normalizeType(draft.type) : normalizeType(current.type);
  const requestedPort = draft.port != null ? Number(draft.port) : Number(current.port);
  const port = requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : defaultPort(type);
  const password = typeof draft.password === 'string' && draft.password !== '' && draft.password !== '***'
    ? draft.password
    : String(current.password || '');
  const host = typeof draft.host === 'string' ? draft.host.trim() : String(current.host || '').trim();
  const user = typeof draft.user === 'string' ? draft.user.trim() : String(current.user || '').trim();
  const database = typeof draft.database === 'string' && draft.database.trim()
    ? draft.database.trim()
    : (String(current.database || '').trim() || 'dcim');

  return { type: type, host: host, port: port, user: user, password: password, database: database };
}

function areaQuery(type) {
  switch (normalizeType(type)) {
    case 'opengauss':
      return 'SELECT id, "AreaName" FROM public."dcim-area" WHERE status = 1 ORDER BY id';
    case 'dm':
      // 达梦表和列的实际大小写会随迁移工具而不同，后续在 Node 侧做字段归一化。
      return 'SELECT * FROM "dcim-area"';
    default:
      return 'SELECT id, AreaName FROM `dcim-area` WHERE status = 1 ORDER BY id';
  }
}

function readValue(row, names) {
  if (!row || typeof row !== 'object') return undefined;
  const actual = {};
  Object.keys(row).forEach(function (key) { actual[key.toLowerCase()] = row[key]; });
  for (let i = 0; i < names.length; i += 1) {
    const key = String(names[i]).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(actual, key)) return actual[key];
  }
  return undefined;
}

function isEnabled(value) {
  if (value == null || value === '') return true;
  return String(value).trim() === '1';
}

function normalizeAreaRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(function (row) {
    const id = readValue(row, ['id']);
    const areaName = readValue(row, ['AreaName']);
    const status = readValue(row, ['status']);
    if (id == null || !isEnabled(status)) return null;
    return { id: String(id), areaName: String(areaName == null ? '' : areaName) };
  }).filter(Boolean);
}

module.exports = {
  SUPPORTED_TYPES: SUPPORTED_TYPES,
  isSupportedType: isSupportedType,
  normalizeType: normalizeType,
  defaultPort: defaultPort,
  mergeConnectionConfig: mergeConnectionConfig,
  areaQuery: areaQuery,
  normalizeAreaRows: normalizeAreaRows,
};
