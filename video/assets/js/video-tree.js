// 设备树：拉 /api/video/devices，渲染设备 → 通道；双击通道触发实时点播
(function () {
  'use strict';

  var rootEl = document.getElementById('deviceTree');
  var hintEl = document.getElementById('treeHint');
  var searchEl = document.getElementById('treeSearch');
  var devices = {};

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function render(filter) {
    var keys = Object.keys(devices);
    if (!keys.length) {
      rootEl.innerHTML = '';
      if (hintEl) {
        hintEl.style.display = '';
        hintEl.textContent = '尚无设备。让 NVR/IPC 主动注册到本机即可。';
        rootEl.appendChild(hintEl);
      }
      return;
    }
    if (hintEl) hintEl.style.display = 'none';
    var f = (filter || '').trim().toLowerCase();

    var html = '';
    keys.sort().forEach(function (devId) {
      var d = devices[devId];
      var devName = d.name || devId;
      var channels = (d.channels || []).filter(function (c) {
        if (!f) return true;
        return (c.id || '').toLowerCase().indexOf(f) >= 0
          || (c.name || '').toLowerCase().indexOf(f) >= 0
          || devId.toLowerCase().indexOf(f) >= 0
          || devName.toLowerCase().indexOf(f) >= 0;
      });
      if (f && !channels.length && devId.toLowerCase().indexOf(f) < 0 && devName.toLowerCase().indexOf(f) < 0) return;

      var statusCls = d.online ? 'on' : 'off';
      var statusTxt = d.online ? '在线' : '离线';
      html += '<div class="dev-node" data-dev="' + esc(devId) + '">';
      html += '  <div class="dev-head" data-toggle>';
      html += '    <span class="arrow">▾</span>';
      html += '    <span class="dev-name" title="' + esc(devId) + '">' + esc(devName) + '</span>';
      html += '    <span class="dev-status ' + statusCls + '">' + statusTxt + '</span>';
      html += '  </div>';
      html += '  <div class="dev-children">';
      if (!channels.length) {
        html += '<div class="hint" style="padding:4px 6px">无通道（点刷新或等待 catalog）</div>';
      } else {
        channels.forEach(function (c) {
          var chSt = c.status === 'ON' || c.status === 'on' || c.online ? 'on' : (c.status === 'OFF' ? 'off' : '');
          html += '<div class="ch-leaf" data-dev="' + esc(devId) + '" data-ch="' + esc(c.id) + '" title="' + esc(c.id) + '">';
          html += '  <span class="ch-status ' + chSt + '"></span>';
          html += '  <span class="ch-name">' + esc(c.name || c.id) + '</span>';
          html += '</div>';
        });
      }
      html += '  </div>';
      html += '</div>';
    });
    rootEl.innerHTML = html;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  rootEl.addEventListener('click', function (e) {
    var head = e.target.closest('[data-toggle]');
    if (head) {
      head.parentNode.classList.toggle('collapsed');
    }
  });

  rootEl.addEventListener('dblclick', function (e) {
    var leaf = e.target.closest('.ch-leaf');
    if (!leaf) return;
    var devId = leaf.dataset.dev;
    var chId = leaf.dataset.ch;
    var d = devices[devId] || {};
    var c = (d.channels || []).find(function (x) { return x.id === chId; }) || {};
    window.VideoBus && window.VideoBus.emit('play-channel', {
      deviceId: devId, channelId: chId,
      deviceName: d.name || devId, channelName: c.name || chId,
    });
  });

  searchEl && searchEl.addEventListener('input', function () { render(searchEl.value); });

  function refresh() {
    return fetch('/api/video/devices').then(function (r) { return r.json(); })
      .then(function (resp) {
        if (resp && resp.ok) {
          devices = resp.devices || {};
          render(searchEl ? searchEl.value : '');
          window.VideoBus && window.VideoBus.emit('devices-updated', devices);
        }
      }).catch(function () {});
  }

  document.getElementById('btnRefreshTree').addEventListener('click', function () {
    fetch('/api/video/devices/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .catch(function () {})
      .then(function () { return refresh(); });
  });

  // SSE 推流（后端 webhook 转发）
  function startSse() {
    try {
      var es = new EventSource('/api/video/events');
      es.onmessage = function (e) {
        try {
          var msg = JSON.parse(e.data);
          if (msg.type === 'device-online' || msg.type === 'device-offline' || msg.type === 'catalog-updated') {
            refresh();
          }
        } catch (_e) {}
      };
      es.onerror = function () { /* EventSource 自动重连 */ };
    } catch (_e) {}
  }

  // 启动
  refresh();
  startSse();
  setInterval(refresh, 15000);

  window.VideoTree = { refresh: refresh, get: function () { return devices; } };
})();
