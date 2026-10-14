'use strict';
const alarmSource = require('./wecom-alarms');
const records = require('./assets/js/pc-area-utils');
const pointTypes = require('./assets/js/pc-point-types');
const sessionUtils = require('./proto-conv-session');
function first(row, names) { return records.firstRecordValue ? records.firstRecordValue(row, names) : names.map(k => row[k]).find(v => v != null && String(v).trim()) || ''; }
async function read(helper, key, body) {
  const r = await helper.callUpstream({ key, method: 'POST', body: Object.assign({ UserLsh: helper.getCfg().userLsh }, body) });
  if (!r || !r.ok) {
    const error = new Error(key + ' DCIM 请求失败');
    error.upstreamUnavailable = !r || r.status === 0 || r.status === 401 || r.status === 403 || sessionUtils.isSessionExpired(r.data);
    throw error;
  }
  return alarmSource.extract(r.data).rows;
}
async function loadDevice(helper, id, groupId, serverCode) {
  const list = groupId ? await read(helper, 'GetDeviceByGroupKey', { GroupId: String(groupId) }) : [];
  const row = list.find(d => records.getDeviceId(d) === String(id));
  const params = await read(helper, 'GetDeviceParasKey', { DeviceId: String(id), serverCode: String(serverCode || '1') });
  return { deviceId: String(id), groupId: String(groupId || ''), serverCode: String(serverCode || '1'), deviceName: String(row && row.DeviceName || id),
    params: params.map(p => ({ paraName: String(p.ParaName || ''), unit: String(p.Unit || ''), dataType: String(p.DataType || ''), type: pointTypes.inferType(p) })).filter(p => p.paraName) };
}
function numeric(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const match = String(raw).trim().match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
  const value = match ? Number(match[0]) : NaN;
  return Number.isFinite(value) ? value : null;
}
async function collect(helper, config, since, now) {
  now = now == null ? Date.now() : now;
  const samples = [], groupMap = new Map(), warnings = [], errors = [];
  let deviceReads = 0, successfulReads = 0, upstreamUnavailable = false;
  for (const d of config.devices) {
    const points = d.params.filter(p => p.type !== 'ALARM'); if (!points.length) continue;
    deviceReads++;
    try {
      if (upstreamUnavailable) throw new Error('DCIM 连接不可用，本轮跳过设备查询');
      let device;
      if (d.groupId) {
        if (!groupMap.has(d.groupId)) {
          const result = await read(helper, 'GetDeviceByGroupKey', { GroupId: d.groupId }).then(rows => ({ rows }), error => ({ error }));
          groupMap.set(d.groupId, result);
        }
        const group = groupMap.get(d.groupId);
        if (group.error && group.error.upstreamUnavailable) throw group.error;
        device = group.rows && group.rows.find(row => records.getDeviceId(row) === d.deviceId);
        if (!device) warnings.push('设备 ' + d.deviceId + '：分组 ' + d.groupId + (group.error ? '查询失败' : '未返回该设备') + '，已改按设备 ID 查询');
      }
      let params = records.normalizeRecords(device && device.ParaList);
      if (!params.length) params = await read(helper, 'GetDeviceParasKey', { DeviceId: d.deviceId, serverCode: d.serverCode || '1' });
      if (!params.length) throw new Error('未读取到设备测点，请核对设备 ID 和 serverCode');
      successfulReads++;
      points.forEach(point => {
        const row = params.find(r => String(r.ParaName) === point.paraName);
        samples.push({ deviceId: d.deviceId, paraName: point.paraName, value: row ? numeric(row.CurValue) : null });
      });
    } catch (error) {
      if (error.upstreamUnavailable) upstreamUnavailable = true;
      errors.push('设备 ' + d.deviceId + '：' + error.message);
      // Invalidate only this device; never refresh an old value as if it were new.
      points.forEach(point => samples.push({ deviceId: d.deviceId, paraName: point.paraName, value: null }));
    }
  }
  if (deviceReads && !successfulReads) throw new Error('所有设备采集失败：' + errors.slice(0, 3).join('；'));
  const alarms = [];
  if (config.devices.some(d => d.params.some(p => p.type === 'ALARM'))) {
    const raw = new Map(), fields = config.alarmFields || {};
    const wrapped = { getCfg: helper.getCfg, callUpstream: async r => {
      const reply = await helper.callUpstream(r);
      if (reply && reply.ok && /AlarmsKey$/.test(r.key)) {
        alarmSource.extract(reply.data).rows.forEach(row => {
          const normalized = alarmSource.normalize(row, fields, now);
          const previous = raw.get(normalized.key) || {};
          const name = String(first(row, fields.alarmName ? [fields.alarmName] : ['AlarmName', 'eventName', 'AlarmContent', 'TypeName', 'TextMessage']));
          const oldName = fields.alarmName ? '' : String(first(row, ['AlarmName', 'AlarmContent', 'TextMessage', 'TypeName', 'eventName']));
          const legacyNames = Array.from(new Set((previous.legacyNames || []).concat(oldName ? [oldName] : [])));
          raw.set(normalized.key, {
            deviceId: String(first(row, fields.deviceId ? [fields.deviceId] : ['DeviceId', 'DeviceID', 'DevId', 'deviceId', 'device_id'])) || previous.deviceId || '',
            name: name || previous.name || '', legacyNames,
            value: numeric(first(row, fields.value ? [fields.value] : ['TriggerVal', 'AlarmValue', 'CurValue', 'ParamValue']))
          });
        });
      }
      return reply;
    } };
    const result = await alarmSource.collect(wrapped, { fields, recovery: true }, since, now);
    if (result.historyError) throw new Error('历史告警读取失败，保留原队列：' + result.historyError);
    const unique = new Map();
    const recent = result.history.filter(a => since && (Date.parse(a.startedAt) >= since - 60000 || Date.parse(a.recoveredAt) >= since - 60000));
    result.live.concat(recent).forEach(a => unique.set(a.key, Object.assign({}, a, raw.get(a.key), { deviceName: a.device, desc: a.content })));
    unique.forEach(a => alarms.push(a));
  }
  return { samples, alarms, warnings, errors };
}
module.exports = { read, collect, loadDevice, numeric };
