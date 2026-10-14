(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PcBMappingView = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';
  function text(value) { return String(value == null ? '' : value).trim().toLowerCase(); }
  function matches(values, query) { return values.some(function (value) { return text(value).indexOf(query) !== -1; }); }
  function filterDevices(devices, query) {
    query = text(query);
    return devices.filter(function (d) { return !query || matches([d.deviceName,d.deviceId,d.groupId,d.bDeviceId,d.rId], query); });
  }
  function filterPoints(points, type, query) {
    query = text(query);
    return points.filter(function (p) { return (!type || type === 'ALL' || p.type === type) && (!query || matches([p.paraName,p.alarmName,p.signalId],query)); });
  }
  function summary(devices) {
    var result = { devices: devices.length, selectedDevices: 0, points: 0, AI: 0, DI: 0, ALARM: 0, missingIds: 0 };
    devices.forEach(function (d) {
      if (!d.selected) return;
      result.selectedDevices++;
      d.params.forEach(function (p) {
        if (!p.selected) return;
        result.points++; if (['AI','DI','ALARM'].indexOf(p.type) !== -1) result[p.type]++;
        if (!text(p.signalId)) result.missingIds++;
      });
    });
    return result;
  }
  return { filterDevices: filterDevices, filterPoints: filterPoints, summary: summary };
});
