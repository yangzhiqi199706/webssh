// 协议转换共享 dcim 响应处理：兼容旧数组与新分页响应。
(function (root) {
  'use strict';

  function normalizeRecords(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.info)) return value.info;
    return [];
  }

  function normalizeAreaRecords(value) {
    return normalizeRecords(value);
  }

  function firstRecordValue(record, keys) {
    if (!record || typeof record !== 'object') return '';
    for (var i = 0; i < keys.length; i++) {
      var value = record[keys[i]];
      if (value == null) continue;
      var text = String(value).trim();
      if (text) return text;
    }
    return '';
  }

  function getDeviceId(record) {
    return firstRecordValue(record, ['DeviceId', 'DeviceID', 'id']);
  }

  function getZoneNo(record) {
    return firstRecordValue(record, ['Zonesubno', 'ZoneSubNo', 'AreaId']);
  }

  function belongsToGroup(record, groupId) {
    var expected = String(groupId == null ? '' : groupId).trim();
    if (!expected) return true;
    var actual = firstRecordValue(record, ['GroupId', 'groupId']);
    if (!actual) actual = firstRecordValue(record, ['DeviceClass', 'deviceClass']);
    return !actual || actual === expected;
  }

  function getControlId(record) {
    return firstRecordValue(record, ['ControlId', 'controlId', 'id']);
  }

  function getControlName(record) {
    return firstRecordValue(record, ['CommandName', 'commandName', 'CommandDesc', 'label', 'Command']);
  }

  function mergeAreaRecords(areaMap, value) {
    normalizeRecords(value).forEach(function (record) {
      if (!record) return;
      var areaId = record.Zonesubno != null ? record.Zonesubno : record.id;
      if (areaId == null) return;
      var key = String(areaId);
      if (areaMap[key]) return;
      var areaName = record.Zonesubname != null ? record.Zonesubname : record.AreaName;
      areaMap[key] = String(areaName == null ? '' : areaName);
    });
    return areaMap;
  }

  var api = {
    normalizeRecords: normalizeRecords,
    normalizeAreaRecords: normalizeAreaRecords,
    mergeAreaRecords: mergeAreaRecords,
    getDeviceId: getDeviceId,
    getZoneNo: getZoneNo,
    belongsToGroup: belongsToGroup,
    getControlId: getControlId,
    getControlName: getControlName,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PcAreaUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
