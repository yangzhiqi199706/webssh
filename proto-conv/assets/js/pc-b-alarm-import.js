(function (root) {
  'use strict';
  function merge(devices, candidates) {
    var copy = devices.map(function (d) { return Object.assign({}, d, { params: d.params.map(function (p) { return Object.assign({}, p); }) }); });
    var added = 0, kept = 0, filled = 0, missing = [];
    var chosen = new Map(); copy.forEach(function (d) { if (d.selected) chosen.set(d.deviceId, d); });
    candidates.forEach(function (c) {
      var device = chosen.get(c.deviceId);
      if (!device) throw new Error('已选设备发生变化，请重新读取告警定义');
      if (device.params.some(function (p) { return p.type === 'ALARM' && p.alarmName === c.alarmName; })) { kept++; return; }
      device.params.push({ type: 'ALARM', paraName: '', alarmName: c.alarmName, signalId: '', selected: true }); added++;
    });
    copy.forEach(function (d) {
      if (!d.selected) return;
      if (d.params.filter(function (p) { return p.selected; }).length > 1000) throw new Error('设备 ' + d.deviceId + ' 超过 1000 个已选测点，未导入任何数据');
      var used = new Set(d.params.filter(function (p) { return p.signalId && p.signalId.length >= 10; }).map(function (p) { return p.signalId.slice(0, 10); }));
      var index = 1;
      d.params.forEach(function (p) {
        if (p.type !== 'ALARM' || p.signalId) return;
        if (!/^\d{5}$/.test(d.bDeviceId || '')) { missing.push(d.deviceId); return; }
        var prefix;
        do { prefix = d.bDeviceId + String(index++).padStart(5, '0'); } while (used.has(prefix) && index <= 100000);
        if (index > 100000) throw new Error('设备测试编号容量不足');
        p.signalId = prefix + '00'; used.add(prefix); filled++;
      });
    });
    if (copy.filter(function (d) { return d.selected; }).reduce(function (n, d) { return n + d.params.filter(function (p) { return p.selected; }).length; }, 0) > 10000) throw new Error('已选测点总数超过 10000，未导入任何数据，请减少设备范围');
    return { devices: copy, added: added, kept: kept, filled: filled, missing: Array.from(new Set(missing)) };
  }
  var api = { merge: merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PcBAlarmImport = api;
})(typeof window !== 'undefined' ? window : globalThis);
