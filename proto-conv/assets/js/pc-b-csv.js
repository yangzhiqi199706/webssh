(function (root) {
  'use strict';
  function cell(value) {
    var text = value == null ? '' : String(value);
    // Names and asset codes can come from an external DCIM source.
    if (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function generate(devices) {
    var rows = [['DCIM 设备 ID', '设备名称', 'DCIM 分组 ID', 'DCIM serverCode', '联通五位设备编码', '设备资管编码', '测点类型', 'DCIM 参数名', '告警名称', '联通十二位监控信息 ID']];
    var deviceCount = 0;
    devices.forEach(function (device) {
      if (!device.selected) return;
      var points = device.params.filter(function (point) { return point.selected; });
      if (points.length) deviceCount++;
      points.forEach(function (point) {
        rows.push([device.deviceId, device.deviceName, device.groupId, device.serverCode, device.bDeviceId, device.rId, point.type,
          point.type === 'ALARM' ? '' : point.paraName, point.type === 'ALARM' ? point.alarmName : '', point.signalId]);
      });
    });
    return { text: '\uFEFF' + rows.map(function (row) { return row.map(cell).join(','); }).join('\r\n') + '\r\n', pointCount: rows.length - 1, deviceCount: deviceCount };
  }
  var api = { generate: generate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PcBCsv = api;
})(typeof window !== 'undefined' ? window : globalThis);
