// 极简事件总线（与 HaBus 同款）。当前协议转换不需要 ws，仅作模块间解耦用。
(function () {
  'use strict';
  var listeners = {};
  window.PcBus = {
    on: function (type, fn) {
      if (!type || typeof fn !== 'function') return;
      (listeners[type] = listeners[type] || []).push(fn);
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
