(function () {
  'use strict';

  // 简单事件总线：ha-monitor / ha-config 通过 window.HaBus 订阅 ws 推送
  var listeners = {};
  var Bus = {
    on: function (type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    emit: function (type, payload) {
      (listeners[type] || []).forEach(function (fn) {
        try { fn(payload); } catch (_e) {}
      });
    },
  };
  window.HaBus = Bus;

  var ws = null;
  var reconnectDelay = 1000;
  var reconnectTimer = null;
  var pingTimer = null;
  var lastHeartbeatAt = 0;
  var aliveCheckTimer = null;

  function setHbBar(alive, hint) {
    var bar = document.getElementById('heartbeatBar');
    var hintEl = document.getElementById('heartbeatHint');
    if (bar) bar.classList.toggle('alive', !!alive);
    if (hintEl) hintEl.textContent = hint || (alive ? '运行中' : '未连接');
  }

  function scheduleReconnect(why) {
    if (reconnectTimer) return;
    setHbBar(false, 'WS 已断开，' + Math.round(reconnectDelay / 1000) + 's 后重连');
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      reconnectDelay = Math.min(10000, reconnectDelay + 1000);
      connect();
    }, reconnectDelay);
  }

  function connect() {
    try {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var url = proto + '//' + location.host + '/ws/ha';
      ws = new WebSocket(url);
    } catch (err) {
      scheduleReconnect('ws 构造失败：' + err.message);
      return;
    }
    ws.onopen = function () {
      reconnectDelay = 1000;
      setHbBar(true, '已连接');
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(function () {
        if (ws && ws.readyState === 1) {
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_e) {}
        }
      }, 25000);
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (_e) { return; }
      if (!msg || !msg.type) return;
      if (msg.type === 'heartbeat') {
        lastHeartbeatAt = Date.now();
        setHbBar(true, '运行中（心跳 ' + new Date().toLocaleTimeString() + '）');
      }
      Bus.emit(msg.type, msg.data);
    };
    ws.onclose = function () {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      scheduleReconnect('connection-closed');
    };
    ws.onerror = function () {
      try { ws.close(); } catch (_e) {}
    };
  }

  // 6 秒没收到心跳就标记 WS 假死（后端可能挂了，但 socket 还在）
  aliveCheckTimer = setInterval(function () {
    if (lastHeartbeatAt === 0) return;
    if (Date.now() - lastHeartbeatAt > 6000) {
      setHbBar(false, '后端心跳超时');
    }
  }, 2000);

  connect();
})();
