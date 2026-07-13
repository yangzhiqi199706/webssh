(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DcimVideoRuntime = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toTime(value) {
    var time = new Date(value).getTime();
    return isNaN(time) ? NaN : time;
  }

  function validatePlaybackRange(start, end) {
    var from = toTime(start);
    var to = toTime(end);
    return isFinite(from) && isFinite(to) && to > from && (to - from) <= 24 * 60 * 60 * 1000;
  }

  function stopPath(options) {
    var value = options || {};
    if (typeof options === 'string') {
      value = { provider: arguments[0], kind: arguments[1], deviceId: arguments[2], channelId: arguments[3], streamKey: arguments[3] };
    }
    var provider = value.provider || 'dcim';
    var kind = value.kind || 'live';
    if (kind === 'live') {
      return '/api/' + provider + '-video/play/stop/' + encodeURIComponent(value.deviceId) + '/' + encodeURIComponent(value.channelId);
    }
    return '/api/' + (provider === 'dcim' ? 'dcim-video' : provider) + '/playback/stop/' + encodeURIComponent(value.streamKey);
  }

  return {
    validatePlaybackRange: validatePlaybackRange,
    stopPath: stopPath,
  };
}));
