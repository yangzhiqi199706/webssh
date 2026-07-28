(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DcimVideoRuntime = factory();
  }
}(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  function toLocalDateTime(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value));
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var hour = Number(match[4]);
    var minute = Number(match[5]);
    var second = match[6] == null ? 0 : Number(match[6]);
    if (year < 1000 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
    var date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(hour, minute, second, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
    return date.getTime();
  }

  function validatePlaybackRange(start, end) {
    var from = toLocalDateTime(start);
    var to = toLocalDateTime(end);
    if (!isFinite(from) || !isFinite(to) || to <= from || (to - from) > 24 * 60 * 60 * 1000) {
      return { ok: false, message: '播放时间范围必须有效、顺序正确且不超过24小时' };
    }
    return { ok: true, startTime: start, endTime: end };
  }

  function stopPath(source, mode, deviceId, channelId, streamKey) {
    var encodedSource = encodeURIComponent(source);
    if (mode === 'live') {
      return '/api/' + encodedSource + '-video/play/stop/' + encodeURIComponent(deviceId) + '/' + encodeURIComponent(channelId);
    }
    if (mode === 'playback') {
      return '/api/' + encodedSource + '-video/playback/stop/' + encodeURIComponent(streamKey);
    }
    throw new Error('Unsupported video stop mode');
  }

  return {
    validatePlaybackRange: validatePlaybackRange,
    stopPath: stopPath,
  };
}));
