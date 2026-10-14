(function (root) {
  'use strict';
  // Lab IDs only: device code + 1-based five-digit point index + state 00.
  function fill(device) {
    if (!device || !/^\d{5}$/.test(device.bDeviceId) || !Array.isArray(device.params)) return 0;
    if (device.params.length > 99999) throw new Error('测试测点序号最多支持 99999 个');
    var changed = 0;
    device.params.forEach(function (point, index) {
      var id = device.bDeviceId + String(index + 1).padStart(5, '0') + '00';
      if (point.signalId !== id) { point.signalId = id; changed++; }
    });
    return changed;
  }
  var api = { fill: fill };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PcBTestIds = api;
})(typeof window !== 'undefined' ? window : globalThis);
