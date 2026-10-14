'use strict';
const alarms = require('./wecom-alarms');
async function loadOptions(helper, fields) {
  const result = { areas: [], devices: [], levels: [], warnings: [] };
  const cfg = helper.getCfg();
  async function read(key, body) {
    const reply = await helper.callUpstream({ key, method: 'POST', body: Object.assign({ UserLsh: cfg.userLsh, ComboBox: 'all' }, body) });
    if (!reply || !reply.ok) throw new Error(key + ' 请求失败');
    return alarms.extract(reply.data).rows;
  }
  function add(kind, value) { if (value != null && String(value).trim()) result[kind].push(String(value).trim()); }
  let areas = [];
  for (const entry of [
    ['GetNewAllAreasKey', 'areas', ['Zonesubname', 'ZoneSubName', 'AreaName']],
    ['GetDeviceListKey', 'devices', ['DeviceName', 'DevName', 'deviceName']]
  ]) {
    try { const rows = await read(entry[0]); if (entry[1] === 'areas') areas = rows; rows.forEach(row => { const k = entry[2].find(k => row[k] != null); if (k) add(entry[1], row[k]); }); }
    catch (e) {
      if (entry[1] !== 'devices' || !areas.length) { result.warnings.push(e.message); continue; }
      const groups = new Map();
      for (const area of areas) {
        const zone = area.Zonesubno == null ? area.id : area.Zonesubno;
        if (zone == null) continue;
        const serverCode = String(area.ServerCode || area.serverCode || '1');
        try { (await read('GetGroupByZonesubnoKey', { Zonesubno: String(zone), serverCode })).forEach(g => {
          if (g.GroupId != null) groups.set(serverCode + ':' + g.GroupId, { GroupId: String(g.GroupId), serverCode });
        }); } catch (error) { result.warnings.push('区域 ' + zone + ' 分组读取失败'); }
      }
      for (const group of groups.values()) {
        try { (await read('GetDeviceByGroupKey', group)).forEach(d => add('devices', d.DeviceName || d.deviceName)); }
        catch (error) { result.warnings.push('分组 ' + group.GroupId + ' 设备读取失败'); }
      }
      if (!groups.size) result.warnings.push('未获取到设备分组');
    }
  }
  try {
    const rows = await alarms.readPages(helper.callUpstream, 'GetRealAlarmsKey', { UserLsh: cfg.userLsh, ComboBox: 'all' }, fields);
    rows.forEach(a => { add('areas', a.area); add('devices', a.device); add('levels', a.level); });
  } catch (e) { result.warnings.push('告警选项读取失败：' + e.message); }
  ['areas', 'devices', 'levels'].forEach(k => { result[k] = Array.from(new Set(result[k])).sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })); });
  if (!result.levels.length) result.warnings.push('当前没有可提取的告警等级，保留已保存的等级选择');
  return result;
}
module.exports = { loadOptions };
