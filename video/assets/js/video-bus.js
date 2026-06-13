// 极简事件总线（与 PcBus 同款）
(function () {
  'use strict';
  var listeners = {};
  window.VideoBus = {
    on: function (type, fn) {
      if (!type || typeof fn !== 'function') return;
      (listeners[type] = listeners[type] || []).push(fn);
    },
    off: function (type, fn) {
      var arr = listeners[type];
      if (!arr) return;
      listeners[type] = arr.filter(function (f) { return f !== fn; });
    },
    emit: function (type, data) {
      var arr = listeners[type];
      if (!arr) return;
      arr.slice().forEach(function (fn) {
        try { fn(data); } catch (e) { /* swallow */ }
      });
    },
  };
})();
