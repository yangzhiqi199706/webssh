'use strict';
const crypto = require('crypto');

const FIELDS = {
  id: ['AlarmID', 'AlarmId', 'alarmId', 'alarm_id', 'eventId', 'ID', 'id'],
  startedAt: ['AlarmTime', 'AlarmDateTime', 'StartTime', 'start_time', 'updatedate', 'create_time', 'alarm_time'],
  recoveredAt: ['RecoverTime', 'RecoveryTime', 'ResumeTime', 'CancelTime', 'DateOnRes', 'recover_time', 'recovery_time', 'resume_time'],
  device: ['DeviceName', 'DevName', 'deviceName', 'device_name'],
  area: ['ZoneSubName', 'Zonesubname', 'ZoneName', 'AreaName', 'alarmAreaName', 'zoneName', 'area_name'],
  level: ['AlarmLevel', 'alarmLevel', 'LevelNo', 'alarm_level', 'AlarmLevelName', 'LevelName'],
  content: ['AlarmContent', 'AlarmName', 'eventName', 'TextMessage', 'TypeName', 'alarm_content', 'content']
};
function field(row, name, mapping) {
  const keys = mapping[name] ? [mapping[name]] : FIELDS[name];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] != null && String(row[key]).trim() !== '') return String(row[key]).trim();
  }
  return '';
}
function timestamp(value) {
  if (!value || /^0{4}-|^0$/.test(value)) return NaN;
  // DCIM local timestamps use China standard time, independent of the Node host timezone.
  const iso = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? value.replace(' ', 'T') + '+08:00' : value;
  return /^\d{4}-\d\d-\d\d[T ]/.test(value) ? Date.parse(iso) : NaN;
}
function normalize(row, mapping, now) {
  mapping = mapping || {};
  now = now == null ? Date.now() : now;
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('告警记录格式错误');
  const item = {};
  Object.keys(FIELDS).forEach(k => { item[k] = field(row, k, mapping); });
  const started = timestamp(item.startedAt);
  if (!item.id || !Number.isFinite(started)) throw new Error('告警缺少唯一 ID 或有效发生时间，请核对字段映射');
  item.startedAt = new Date(started).toISOString();
  item.serverCode = String(row.serverCode || row.ServerCode || '');
  const recovered = timestamp(item.recoveredAt);
  item.recoveredAt = Number.isFinite(recovered) && recovered >= started && recovered <= now ? new Date(recovered).toISOString() : '';
  item.key = crypto.createHash('sha256').update(JSON.stringify([item.id, item.startedAt])).digest('hex');
  return item;
}
function extract(data) {
  let total = null;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_e) { throw new Error('告警接口返回的不是 JSON 列表'); } }
    if (Array.isArray(data)) return { rows: data, total };
    if (!data || typeof data !== 'object') break;
    if (data.ok === false || data.success === false || (data.status != null && !['ok', 'success', '200'].includes(String(data.status).toLowerCase())) || (data.code != null && ![0, 100, 200].includes(Number(data.code)))) throw new Error('告警接口业务失败，请检查登录会话');
    for (const key of ['total', 'Total', 'totalCount', 'recordCount', 'count', 'Count']) {
      if (data[key] != null && data[key] !== '' && Number.isInteger(Number(data[key])) && Number(data[key]) >= 0) total = Number(data[key]);
    }
    const key = ['rows', 'list', 'records', 'info', 'data', 'Data'].find(k => Object.prototype.hasOwnProperty.call(data, k));
    if (!key) break;
    data = data[key];
  }
  throw new Error('无法识别告警列表，未将异常响应视为空列表');
}
async function readPages(invoke, key, body, mapping, pageSize, now) {
  pageSize = pageSize || 200;
  const rows = [], pages = new Set();
  for (let page = 1; page <= 100; page++) {
    const reply = await invoke({ key, method: 'POST', body: Object.assign({}, body, { pageIndex: page, pageSize }) });
    if (!reply || !reply.ok) throw new Error(key + ' 请求失败');
    const result = extract(reply.data);
    const normalized = result.rows.map(row => normalize(row, mapping, now));
    const signature = JSON.stringify(normalized.map(row => [row.key, row.recoveredAt]));
    if (pages.has(signature) && normalized.length) throw new Error('告警分页重复，采集已中止');
    pages.add(signature);
    rows.push.apply(rows, normalized);
    if (result.total != null && rows.length >= result.total) return rows;
    // Legacy 8082 returns a complete array with status=ok, ignoring page size.
    if (result.total == null && reply.data && reply.data.status === 'ok' && Array.isArray(reply.data.data)) {
      Object.defineProperty(rows, 'legacy8082', { value: true });
      return rows;
    }
    if (result.total == null && normalized.length < pageSize) return rows;
    if (!normalized.length) throw new Error('告警分页未完成，返回条数少于总数');
  }
  throw new Error('告警分页超过 100 页，采集已中止');
}
function localDate(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '); }
async function collect(helper, config, since, now) {
  now = now || Date.now();
  const cfg = helper.getCfg();
  const live = await readPages(helper.callUpstream, 'GetRealAlarmsKey', { UserLsh: cfg.userLsh, ComboBox: 'all' }, config.fields, 200, now);
  let history = [], historyError = '';
  if ((config.recovery && since) || live.legacy8082) {
    const start = localDate(since - 60000), end = localDate(now);
    try {
      if (live.legacy8082) {
        const reply = await helper.callUpstream({ key: 'GetNewAllAreasKey', method: 'POST', body: { UserLsh: cfg.userLsh } });
        if (!reply || !reply.ok) throw new Error('区域服务器列表读取失败');
        const servers = new Set(live.map(a => a.serverCode).filter(Boolean));
        extract(reply.data).rows.forEach(a => { const code = a.ServerCode || a.serverCode; if (code != null) servers.add(String(code)); });
        if (!servers.size) throw new Error('无法确定历史告警服务器编号');
        // Legacy history filters create_time, not the displayed event timestamp.
        for (const serverCode of servers) {
          const rows = await readPages(helper.callUpstream, 'GetHistoryAlarmsKey', { UserLsh: cfg.userLsh, serverCode }, config.fields, 200, now);
          history.push.apply(history, rows);
        }
        const recovered = new Map(history.filter(a => a.recoveredAt).map(a => [a.key, a.recoveredAt]));
        live.forEach(a => { if (recovered.has(a.key)) a.recoveredAt = recovered.get(a.key); });
      } else history = await readPages(helper.callUpstream, 'GetHistoryAlarmsKey', {
        UserLsh: cfg.userLsh, StartDate: start, EndDate: end, startDateTime: start, endDateTime: end, ComboBox: 'all'
      }, config.fields, 200, now);
    } catch (error) {
      if (live.legacy8082) throw error;
      historyError = error.message;
    }
  }
  return { live, history, historyError };
}
function matches(alarm, filters) {
  return [['areas', 'area'], ['devices', 'device'], ['levels', 'level']].every(pair => !filters[pair[0]].length || filters[pair[0]].includes(alarm[pair[1]])) &&
    (!filters.keyword || [alarm.area, alarm.device, alarm.content].join(' ').toLowerCase().includes(filters.keyword.toLowerCase()));
}
module.exports = { FIELDS, normalize, extract, readPages, collect, matches };
