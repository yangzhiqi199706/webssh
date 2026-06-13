// 多分屏管理器：1/4/9/16 切换、激活格、双击通道分配
(function () {
  'use strict';

  var LAYOUT_CAPS = { 1: 1, 4: 4, 9: 9, 16: 16 };

  function Grid(rootEl) {
    this.root = rootEl;
    this.tiles = [];
    this.activeIdx = 0;
    this.layout = 4;
    this._build(this.layout);

    var self = this;
    window.VideoBus && window.VideoBus.on('tile-active', function (idx) {
      self.setActive(idx);
    });
    window.addEventListener('beforeunload', function () { self.stopAll(); });
  }

  Grid.prototype._build = function (n) {
    // 先 stop 多余的，再补齐
    var cap = LAYOUT_CAPS[n] || 4;
    if (this.tiles.length > cap) {
      for (var i = this.tiles.length - 1; i >= cap; i--) {
        this.tiles[i].stop();
        this.tiles[i].el.remove();
      }
      this.tiles.length = cap;
    }
    while (this.tiles.length < cap) {
      var t = new window.VideoTile(this.tiles.length);
      this.tiles.push(t);
      this.root.appendChild(t.el);
    }
    this.root.className = 'video-grid layout-' + n;
    this.layout = n;
    if (this.activeIdx >= cap) this.activeIdx = 0;
    this.setActive(this.activeIdx);
  };

  Grid.prototype.setLayout = function (n) {
    if (!LAYOUT_CAPS[n]) return;
    this._build(n);
  };

  Grid.prototype.setActive = function (idx) {
    if (idx < 0 || idx >= this.tiles.length) idx = 0;
    this.activeIdx = idx;
    this.tiles.forEach(function (t, i) {
      t.el.classList.toggle('active', i === idx);
    });
  };

  Grid.prototype.activeTile = function () {
    return this.tiles[this.activeIdx] || null;
  };

  // 找一个空闲格子（player==null），找不到返回 active 格
  Grid.prototype.firstEmpty = function () {
    for (var i = 0; i < this.tiles.length; i++) {
      if (!this.tiles[i].streamKey) return this.tiles[i];
    }
    return this.activeTile();
  };

  Grid.prototype.stopAll = function () {
    this.tiles.forEach(function (t) { t.stop(); });
  };

  // 把通道实时点播到指定格（默认 active）
  Grid.prototype.playLive = function (params, tile) {
    tile = tile || this.activeTile();
    if (!tile) return Promise.resolve({ ok: false, message: '无可用分屏' });
    return fetch('/api/video/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: params.deviceId,
        channelId: params.channelId,
      }),
    }).then(function (r) { return r.json(); }).then(function (resp) {
      if (!resp.ok) return resp;
      return tile.play({
        flvUrl: resp.flvUrl,
        streamKey: resp.streamKey,
        deviceId: params.deviceId,
        channelId: params.channelId,
        channelName: params.channelName,
        deviceName: params.deviceName,
        mode: 'live',
      }).then(function () { return resp; });
    }).catch(function (e) { return { ok: false, message: e.message }; });
  };

  // 回放：start/end 是 Date 对象或 Unix 秒
  Grid.prototype.playPlayback = function (params, tile) {
    tile = tile || this.activeTile();
    if (!tile) return Promise.resolve({ ok: false, message: '无可用分屏' });
    var startSec = params.start instanceof Date ? Math.floor(params.start.getTime() / 1000) : Number(params.start);
    var endSec = params.end instanceof Date ? Math.floor(params.end.getTime() / 1000) : Number(params.end);
    return fetch('/api/video/playback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: params.deviceId,
        channelId: params.channelId,
        start: startSec,
        end: endSec,
      }),
    }).then(function (r) { return r.json(); }).then(function (resp) {
      if (!resp.ok) return resp;
      return tile.play({
        flvUrl: resp.flvUrl,
        streamKey: resp.streamKey,
        deviceId: params.deviceId,
        channelId: params.channelId,
        channelName: params.channelName,
        deviceName: params.deviceName,
        mode: 'playback',
      }).then(function () { return resp; });
    }).catch(function (e) { return { ok: false, message: e.message }; });
  };

  window.VideoGrid = Grid;
})();
