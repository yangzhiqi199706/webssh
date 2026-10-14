(function (root) {
  'use strict';
  // Signal semantics from DCIM/Modbus metadata, not the numeric storage format.
  function inferType(point) {
    var value = String(point && (point.dataType || point.DataType) || '').trim().toUpperCase();
    if (['模拟量', '遥测', 'AI', 'ANALOG'].indexOf(value) >= 0) return 'AI';
    if (['开关量', '状态量', '遥信', 'DI', 'DIGITAL'].indexOf(value) >= 0) return 'DI';
    return null;
  }
  var api = { inferType: inferType };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PcPointTypes = api;
})(typeof window !== 'undefined' ? window : globalThis);
