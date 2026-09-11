'use strict';

function toTimeMs(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function createCancelCursor(timeMs, id) {
  let currentTimeMs = Number(timeMs) > 0 ? Number(timeMs) : 0;
  let currentId = Number(id) > 0 ? Number(id) : 0;

  return {
    value: function () {
      return { timeMs: currentTimeMs, id: currentId };
    },
    update: function (nextTimeMs, nextId) {
      currentTimeMs = Number(nextTimeMs) > 0 ? Number(nextTimeMs) : 0;
      currentId = Number(nextId) > 0 ? Number(nextId) : 0;
    },
  };
}

function buildCancelQuery(table, cursor, limit) {
  const name = String(table || 'dcim-alarmlist');
  const value = cursor && typeof cursor.value === 'function' ? cursor.value() : { timeMs: 0, id: 0 };
  const time = new Date(value.timeMs || 0);
  const maxRows = Number.isInteger(limit) && limit > 0 ? limit : 200;
  return {
    sql: 'SELECT * FROM `' + name + '` WHERE CancelTime IS NOT NULL AND (CancelTime > ? OR (CancelTime = ? AND id > ?)) ORDER BY CancelTime ASC, id ASC LIMIT ' + maxRows,
    params: [time, time, value.id || 0],
  };
}

function acceptCancelRow(cursor, row) {
  if (!cursor || !row) return false;
  const timeMs = toTimeMs(row.CancelTime);
  const id = Number(row.id);
  if (!timeMs || !Number.isFinite(id) || id <= 0) return false;
  const current = cursor.value();
  if (timeMs < current.timeMs || (timeMs === current.timeMs && id <= current.id)) return false;
  cursor.update(timeMs, id);
  return true;
}

function pushPendingWithLimit(pending, row, firstSeenMs, maxSize, onFlush) {
  if (!pending || !row) return;
  const id = Number(row.id);
  if (!Number.isFinite(id) || id <= 0) return;
  if (pending.has(id)) {
    const existing = pending.get(id);
    pending.set(id, { firstSeenMs: existing.firstSeenMs, row: row });
    return;
  }
  const limit = Number.isInteger(maxSize) && maxSize > 0 ? maxSize : 1000;
  if (pending.size >= limit) {
    let oldestId = null;
    let oldest = null;
    pending.forEach(function (entry, entryId) {
      if (!oldest || entry.firstSeenMs < oldest.firstSeenMs ||
        (entry.firstSeenMs === oldest.firstSeenMs && entryId < oldestId)) {
        oldestId = entryId;
        oldest = entry;
      }
    });
    if (oldestId !== null) {
      pending.delete(oldestId);
      if (typeof onFlush === 'function') onFlush(oldest.row, 'pending-cap');
    }
  }
  pending.set(id, { firstSeenMs: Number(firstSeenMs) || Date.now(), row: row });
}

function chunk(items, size) {
  const values = Array.isArray(items) ? items : [];
  const width = Number.isInteger(size) && size > 0 ? size : 200;
  const result = [];
  for (let index = 0; index < values.length; index += width) result.push(values.slice(index, index + width));
  return result;
}

module.exports = {
  createCancelCursor: createCancelCursor,
  buildCancelQuery: buildCancelQuery,
  acceptCancelRow: acceptCancelRow,
  pushPendingWithLimit: pushPendingWithLimit,
  chunk: chunk,
  toTimeMs: toTimeMs,
};
