(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DcimVideoRuntime = factory();
  }
}(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  function toTime(value) {
    var time = new Date(value).getTime();
    return isNaN(time) ? NaN : time;
  }

  function validatePlaybackRange(start, end) {
    var from = toTime(start);
    var to = toTime(end);
    if (!isFinite(from) || !isFinite(to) || to <= from || (to - from) > 24 * 60 * 60 * 1000) {
      return { ok: false, message: '播放时间范围必须有效、顺序正确且不超过24小时' };
    }
    return { ok: true, startTime: start, endTime: end };
  }

  function stopPath(source, mode, deviceId, channelId, streamKey) {
    if (mode === 'live') {
      return '/api/' + source + '-video/play/stop/' + encodeURIComponent(deviceId) + '/' + encodeURIComponent(channelId);
    }
    if (mode === 'playback') {
      return '/api/' + source + '-video/playback/stop/' + encodeURIComponent(streamKey);
    }
    throw new Error('Unsupported video stop mode');
  }

  return {
    validatePlaybackRange: validatePlaybackRange,
    stopPath: stopPath,
  };
}));
