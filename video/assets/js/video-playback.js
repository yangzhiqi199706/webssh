// 回放面板：选时间段触发 INVITE Playback；倍速/暂停/继续
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var bar = $('playbackBar');
  var btnToggle = $('btnTogglePlayback');
  var startEl = $('pbStart');
  var endEl = $('pbEnd');
  var speedEl = $('pbSpeed');
  var btnStart = $('btnPbStart');
  var btnPause = $('btnPbPause');
  var btnResume = $('btnPbResume');
  var hintEl = $('pbHint');
  var titleEl = $('gridTitle');

  var lastSelectedChannel = null; // {deviceId, channelId, deviceName, channelName}

  function setHint(text, cls) {
    hintEl.textContent = text || '';
    hintEl.className = 'hint' + (cls ? ' ' + cls : '');
  }

  function setMode(playback) {
    bar.hidden = !playback;
    btnToggle.classList.toggle('primary', playback);
    titleEl.textContent = playback ? '历史回放' : '实时预览';
    document.documentElement.dataset.mode = playback ? 'playback' : 'live';
  }

  function defaultRange() {
    var now = new Date();
    var end = new Date(now.getTime());
    var start = new Date(now.getTime() - 5 * 60 * 1000);
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function fmt(d) {
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    if (!startEl.value) startEl.value = fmt(start);
    if (!endEl.value) endEl.value = fmt(end);
  }

  btnToggle.addEventListener('click', function () {
    var on = bar.hidden;
    setMode(on);
    if (on) defaultRange();
  });

  // 记录最近一次双击的通道（实时模式直接播；回放模式只记录）
  window.VideoBus && window.VideoBus.on('play-channel', function (ch) {
    lastSelectedChannel = ch;
    if (!bar.hidden) {
      setHint('已选择通道：' + (ch.channelName || ch.channelId) + '。设好时间后点「开始回放」', 'ok');
    }
  });

  btnStart.addEventListener('click', function () {
    var grid = window.VideoApp && window.VideoApp.grid;
    if (!grid) return;
    if (!lastSelectedChannel) {
      setHint('请先在左侧双击一个通道', 'err');
      return;
    }
    if (!startEl.value || !endEl.value) {
      setHint('请填写开始和结束时间', 'err');
      return;
    }
    var start = new Date(startEl.value);
    var end = new Date(endEl.value);
    if (!(start.getTime() < end.getTime())) {
      setHint('开始时间需早于结束时间', 'err');
      return;
    }
    setHint('请求回放中…');
    grid.playPlayback({
      deviceId: lastSelectedChannel.deviceId,
      channelId: lastSelectedChannel.channelId,
      deviceName: lastSelectedChannel.deviceName,
      channelName: lastSelectedChannel.channelName,
      start: start, end: end,
    }).then(function (resp) {
      if (resp.ok) setHint('回放流已起播：' + resp.streamKey, 'ok');
      else setHint('回放失败：' + (resp.message || '未知错误'), 'err');
    });
  });

  btnPause.addEventListener('click', function () {
    var t = window.VideoApp && window.VideoApp.grid && window.VideoApp.grid.activeTile();
    if (!t) return;
    t.control('pause').then(function (r) { setHint(r.ok ? '已暂停' : '暂停失败：' + r.message, r.ok ? 'ok' : 'err'); });
  });

  btnResume.addEventListener('click', function () {
    var t = window.VideoApp && window.VideoApp.grid && window.VideoApp.grid.activeTile();
    if (!t) return;
    t.control('play').then(function (r) { setHint(r.ok ? '已继续' : '继续失败：' + r.message, r.ok ? 'ok' : 'err'); });
  });

  speedEl.addEventListener('change', function () {
    var t = window.VideoApp && window.VideoApp.grid && window.VideoApp.grid.activeTile();
    if (!t) return;
    var speed = Number(speedEl.value) || 1;
    t.control(speed === 1 ? 'play' : 'fastforward', { speed: speed }).then(function (r) {
      setHint(r.ok ? '倍速已切到 ' + speed + '×' : '切换失败：' + r.message, r.ok ? 'ok' : 'err');
    });
  });

  setMode(false);
  window.VideoPlayback = { setMode: setMode };
})();
