// 主入口：连接所有子模块，挂全局 VideoApp，处理顶部按钮
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var grid = new window.VideoGrid($('videoGrid'));

  // 顶部分屏切换
  var lbs = document.querySelectorAll('.layout-switcher .lb');
  function setLayoutBtn(n) {
    lbs.forEach(function (b) {
      b.classList.toggle('active', Number(b.dataset.layout) === n);
    });
  }
  lbs.forEach(function (b) {
    b.addEventListener('click', function () {
      var n = Number(b.dataset.layout);
      grid.setLayout(n);
      setLayoutBtn(n);
    });
  });
  setLayoutBtn(grid.layout);

  // 双击通道触发实时点播（仅当不在回放模式时）
  window.VideoBus.on('play-channel', function (ch) {
    if (document.documentElement.dataset.mode === 'playback') return;
    grid.playLive(ch).then(function (resp) {
      var hint = $('gridHint');
      if (hint) hint.textContent = resp.ok ? '已播放：' + (ch.channelName || ch.channelId) : '播放失败：' + (resp.message || '');
    });
  });

  // 关闭全部
  $('btnStopAll').addEventListener('click', function () { grid.stopAll(); });

  // 全屏
  $('btnFullscreen').addEventListener('click', function () {
    var doc = document;
    if (doc.fullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen || function () {}).call(doc);
    } else {
      var t = grid.activeTile();
      var target = t ? t.el : document.getElementById('videoGrid');
      var fn = target.requestFullscreen || target.webkitRequestFullscreen;
      if (fn) fn.call(target);
    }
  });

  // 服务状态轮询
  var dot = $('serverDot');
  var tag = $('serverTag');
  function refreshStatus() {
    fetch('/api/video/status').then(function (r) { return r.json(); }).then(function (resp) {
      if (!resp || !resp.ok) {
        dot.className = 'dot err';
        tag.title = '查询失败';
        return;
      }
      var ok = resp.mediaserverRunning && resp.zlmReachable;
      dot.className = 'dot ' + (ok ? 'on' : (resp.mediaserverRunning ? 'warn' : 'err'));
      tag.title = '设备 ' + (resp.deviceCount || 0) + ' · 流 ' + (resp.streamCount || 0)
        + (resp.lastError ? '\n最近错误: ' + resp.lastError : '');
    }).catch(function () {
      dot.className = 'dot err';
    });
  }
  refreshStatus();
  setInterval(refreshStatus, 8000);

  window.VideoApp = { grid: grid };
})();
