// 单格播放器封装：每格一个 flv.js 实例，错误自愈 + 显式 destroy 防泄漏
(function () {
  'use strict';

  // 渲染单格 DOM 骨架
  function buildTileEl(index) {
    var root = document.createElement('div');
    root.className = 'tile';
    root.dataset.idx = String(index);
    root.innerHTML = [
      '<div class="tile-empty">分屏 ' + (index + 1) + '<br>双击通道可播放</div>',
      '<video muted playsinline></video>',
      '<div class="tile-overlay" hidden>',
      '  <span class="badge tag">LIVE</span>',
      '  <span class="title"></span>',
      '</div>',
      '<div class="tile-actions" hidden>',
      '  <button class="ta-btn btn-stop" type="button" title="关闭">×</button>',
      '</div>',
      '<div class="tile-loader" hidden>载入中…</div>',
    ].join('\n');
    var v = root.querySelector('video');
    v.style.display = 'none';
    return root;
  }

  function Tile(index) {
    this.index = index;
    this.el = buildTileEl(index);
    this.video = this.el.querySelector('video');
    this.elEmpty = this.el.querySelector('.tile-empty');
    this.elOverlay = this.el.querySelector('.tile-overlay');
    this.elTitle = this.el.querySelector('.tile-overlay .title');
    this.elBadge = this.el.querySelector('.tile-overlay .badge');
    this.elActions = this.el.querySelector('.tile-actions');
    this.elLoader = this.el.querySelector('.tile-loader');
    this.player = null;
    this.streamKey = null;
    this.flvUrl = null;
    this.deviceId = null;
    this.channelId = null;
    this.mode = null;        // 'live' | 'playback'
    this._retryTimer = null;
    this._lastParams = null;

    var self = this;
    this.el.addEventListener('click', function () {
      window.VideoBus && window.VideoBus.emit('tile-active', self.index);
    });
    this.el.querySelector('.btn-stop').addEventListener('click', function (e) {
      e.stopPropagation();
      self.stop();
    });
  }

  Tile.prototype._setLoading = function (on) {
    this.elLoader.hidden = !on;
  };
  Tile.prototype._showVideo = function () {
    this.video.style.display = '';
    this.elEmpty.style.display = 'none';
    this.elOverlay.hidden = false;
    this.elActions.hidden = false;
  };
  Tile.prototype._showEmpty = function () {
    this.video.style.display = 'none';
    this.elEmpty.style.display = '';
    this.elOverlay.hidden = true;
    this.elActions.hidden = true;
  };

  // params: { flvUrl, streamKey, deviceId, channelId, channelName, mode }
  Tile.prototype.play = function (params) {
    var self = this;
    this._lastParams = params;
    this.deviceId = params.deviceId;
    this.channelId = params.channelId;
    this.streamKey = params.streamKey;
    this.flvUrl = params.flvUrl;
    this.mode = params.mode || 'live';
    this.elTitle.textContent = (params.channelName || params.channelId || '') + (params.deviceName ? '  @ ' + params.deviceName : '');
    this.elBadge.textContent = this.mode === 'playback' ? '回放' : 'LIVE';
    this.elBadge.classList.toggle('pb', this.mode === 'playback');

    return this._destroyPlayer().then(function () {
      if (!window.flvjs || !window.flvjs.isSupported()) {
        self._showEmpty();
        self.elEmpty.innerHTML = '当前浏览器不支持 MSE / flv.js';
        return;
      }
      self._setLoading(true);
      self._showVideo();
      var p = window.flvjs.createPlayer({
        type: 'flv',
        url: params.flvUrl,
        isLive: self.mode === 'live',
        hasAudio: false,
      }, {
        enableStashBuffer: false,
        stashInitialSize: 128,
        lazyLoad: false,
        autoCleanupSourceBuffer: true,
      });
      p.attachMediaElement(self.video);
      p.on(window.flvjs.Events.ERROR, function (errType, errDetail) {
        self._setLoading(false);
        // 实时流出错按 2s 重试一次（最多 3 次），回放出错只告警不重试
        if (self.mode === 'live') self._scheduleRetry();
        window.VideoBus && window.VideoBus.emit('tile-error', { idx: self.index, errType: errType, errDetail: errDetail });
      });
      p.on(window.flvjs.Events.MEDIA_INFO, function () { self._setLoading(false); });
      try { p.load(); } catch (e) { /* swallow */ }
      try {
        var pr = self.video.play();
        if (pr && pr.catch) pr.catch(function () { /* autoplay 政策 */ });
      } catch (_e) {}
      self.player = p;
    });
  };

  Tile.prototype._scheduleRetry = function () {
    var self = this;
    clearTimeout(this._retryTimer);
    this._retryCount = (this._retryCount || 0) + 1;
    if (this._retryCount > 3) return;
    this._retryTimer = setTimeout(function () {
      if (self._lastParams && self.streamKey) self.play(self._lastParams);
    }, 2000);
  };

  Tile.prototype._destroyPlayer = function () {
    if (this.player) {
      try { this.player.pause(); } catch (_e) {}
      try { this.player.unload(); } catch (_e) {}
      try { this.player.detachMediaElement(); } catch (_e) {}
      try { this.player.destroy(); } catch (_e) {}
      this.player = null;
    }
    try { this.video.removeAttribute('src'); this.video.load(); } catch (_e) {}
    return Promise.resolve();
  };

  Tile.prototype.stop = function () {
    var self = this;
    clearTimeout(this._retryTimer);
    this._retryCount = 0;
    var sk = this.streamKey;
    var mode = this.mode;
    this.streamKey = null;
    this.flvUrl = null;
    return this._destroyPlayer().then(function () {
      self._showEmpty();
      self._setLoading(false);
      if (sk) {
        return fetch('/api/video/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ streamKey: sk, mode: mode }),
        }).catch(function () {});
      }
    });
  };

  // 倍速/暂停/继续/seek（仅回放模式有效）
  Tile.prototype.control = function (action, extra) {
    if (this.mode !== 'playback' || !this.streamKey) {
      return Promise.resolve({ ok: false, message: '当前不是回放模式' });
    }
    var body = Object.assign({ streamKey: this.streamKey, action: action }, extra || {});
    return fetch('/api/video/playback/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); }).catch(function (e) {
      return { ok: false, message: e.message };
    });
  };

  window.VideoTile = Tile;
})();
