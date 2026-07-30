(function () {
  'use strict';

  var READ_URL = '/api/service-overview';
  var REFRESH_URL = '/api/service-overview/refresh';
  var HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  var state = { snapshot: null, history: [] };
  var el = {
    refresh: document.getElementById('overviewRefresh'),
    updatedAt: document.getElementById('overviewUpdatedAt'),
    health: document.getElementById('overviewHealth'),
    role: document.getElementById('overviewRole'),
    requestError: document.getElementById('overviewRequestError'),
    hosts: document.getElementById('overviewHosts'),
    services: document.getElementById('overviewServices'),
    alerts: document.getElementById('overviewAlerts'),
    trend: document.getElementById('overviewTrend')
  };

  function str(value, fallback) {
    return value === undefined || value === null || value === '' ? (fallback || '--') : String(value);
  }

  function esc(value) {
    return str(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function timeText(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return '暂无数据';
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
      + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') + ':' + String(date.getSeconds()).padStart(2, '0');
  }

  function percent(value) {
    return typeof value === 'number' && isFinite(value) ? value + '%' : '--';
  }

  function size(kb) {
    if (typeof kb !== 'number' || !isFinite(kb)) return '--';
    return kb >= 1024 * 1024 ? (kb / (1024 * 1024)).toFixed(1) + ' GB' : (kb / 1024).toFixed(1) + ' MB';
  }

  function uptime(seconds) {
    if (typeof seconds !== 'number' || seconds < 0) return '--';
    var days = Math.floor(seconds / 86400);
    var hours = Math.floor((seconds % 86400) / 3600);
    return days ? days + ' 天 ' + hours + ' 小时' : hours + ' 小时';
  }

  function isKnown(target) {
    return !!(target && target.status !== 'unknown');
  }

  function hostMarkup(name, target) {
    if (!isKnown(target)) {
      return '<div class="host-panel-head"><h3>' + name + '</h3><span class="status unknown">暂无数据</span></div>'
        + '<div class="resource-grid"><div class="metric"><span class="metric-name">状态</span><span class="metric-meta">暂无数据</span></div></div>';
    }
    var rows = [
      ['CPU', percent(target.cpu && target.cpu.percent), '使用率'],
      ['内存', percent(target.memory && target.memory.percent), size(target.memory && target.memory.usedKb) + ' / ' + size(target.memory && target.memory.totalKb)],
      ['磁盘', percent(target.disk && target.disk.percent), size(target.disk && target.disk.usedKb) + ' / ' + size(target.disk && target.disk.totalKb)],
      ['负载', esc(str(target.load && target.load.oneMinute)), '1 分钟平均'],
      ['运行时长', uptime(target.uptime && target.uptime.seconds), '系统启动至今']
    ];
    return '<div class="host-panel-head"><h3>' + name + '</h3><span class="status ok">正常</span></div><div class="resource-grid">'
      + rows.map(function (row) {
        return '<div class="metric"><span class="metric-name">' + row[0] + '</span><strong class="metric-value">' + row[1] + '</strong><span class="metric-meta">' + row[2] + '</span></div>';
      }).join('') + '</div>';
  }

  function renderHosts(snapshot) {
    var panels = el.hosts.querySelectorAll('[data-host]');
    panels[0].innerHTML = hostMarkup('本机', snapshot && snapshot.local);
    panels[1].innerHTML = hostMarkup('HA 对端', snapshot && snapshot.peer);
  }

  function serviceName(name) {
    return { webssh: 'webssh', protocol: 'webssh-protocol', docker: 'docker' }[name] || name;
  }

  function serviceRow(label, service) {
    var state = service && service.state;
    return {
      label: label,
      state: state || '暂无数据',
      className: !service || state === 'unknown' ? 'unknown' : service.healthy ? 'ok' : 'bad'
    };
  }

  function serviceRows(snapshot) {
    var rows = [];
    [{ label: '本机', target: snapshot && snapshot.local }, { label: 'HA 对端', target: snapshot && snapshot.peer }].forEach(function (host) {
      if (!isKnown(host.target)) {
        ['webssh', 'webssh-protocol', 'docker', 'dcim 容器', 'dcim 采集'].forEach(function (name) {
          rows.push({ label: host.label + ' / ' + name, state: '暂无数据', className: 'unknown' });
        });
        return;
      }
      ['webssh', 'protocol', 'docker'].forEach(function (name) {
        var service = host.target && host.target.services && host.target.services[name];
        var row = serviceRow(host.label + ' / ' + serviceName(name), service);
        rows.push(row);
      });
      var dcim = host.target.services && host.target.services.dcim;
      rows.push({
        label: host.label + ' / dcim 容器',
        state: dcim && dcim.container === true ? '运行中' : dcim ? '未运行' : '暂无数据',
        className: !dcim ? 'unknown' : dcim.container === true ? 'ok' : 'bad'
      });
      rows.push(serviceRow(host.label + ' / dcim 采集', dcim));
    });
    return rows;
  }

  function renderServices(snapshot) {
    var rows = serviceRows(snapshot);
    if (!snapshot) {
      el.services.innerHTML = '<p class="empty-state">暂无数据</p>';
      return;
    }
    el.services.innerHTML = rows.map(function (row) {
      return '<div class="service-item"><span class="service-name">' + esc(row.label) + '</span><span class="status ' + row.className + '">' + esc(row.state) + '</span></div>';
    }).join('');
  }

  function alerts(snapshot) {
    var result = [];
    if (!snapshot) return result;
    [{ label: '本机', target: snapshot.local }, { label: 'HA 对端', target: snapshot.peer }].forEach(function (host) {
      if (!isKnown(host.target)) {
        result.push({ host: host.label, message: '暂无数据' });
        return;
      }
      ['webssh', 'protocol', 'docker'].forEach(function (name) {
        var service = host.target.services && host.target.services[name];
        if (!service || !service.healthy) {
          result.push({ host: host.label, message: serviceName(name) + ' 状态：' + str(service && service.state, '暂无数据') });
        }
      });
      var dcim = host.target.services && host.target.services.dcim;
      if (!dcim || dcim.container !== true) result.push({ host: host.label, message: 'dcim 容器状态：' + (dcim ? '未运行' : '暂无数据') });
      if (!dcim || !dcim.healthy) result.push({ host: host.label, message: 'dcim 采集状态：' + str(dcim && dcim.state, '暂无数据') });
    });
    return result;
  }

  function renderAlerts(snapshot) {
    var rows = alerts(snapshot);
    if (!rows.length) {
      el.alerts.innerHTML = '<p class="empty-state">' + (snapshot ? '暂无异常' : '暂无数据') + '</p>';
      return;
    }
    el.alerts.innerHTML = rows.map(function (row) {
      return '<div class="alert-item"><span class="status bad">异常</span><span class="alert-host">' + esc(row.host) + '</span><span>' + esc(row.message) + '</span></div>';
    }).join('');
  }

  function metric(target, name) {
    var group = target && target[name];
    return group && typeof group.percent === 'number' && isFinite(group.percent) ? group.percent : null;
  }

  function drawLine(context, values, width, height, color) {
    if (!values.length) return false;
    context.beginPath();
    values.forEach(function (value, index) {
      var x = values.length === 1 ? width / 2 : index * width / (values.length - 1);
      var y = height - value * height / 100;
      if (index) context.lineTo(x, y); else context.moveTo(x, y);
    });
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.stroke();
    return true;
  }

  function drawTrend(canvas, records, metricName, color) {
    var context = canvas.getContext('2d');
    var box = canvas.getBoundingClientRect();
    var ratio = window.devicePixelRatio || 1;
    var width = Math.max(1, Math.round(box.width * ratio));
    var height = Math.max(1, Math.round(box.height * ratio));
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = '#26334a';
    context.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(function (part) {
      var y = Math.round(height * part) + 0.5;
      context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
    });
    var local = [];
    var peer = [];
    (Array.isArray(records) ? records : []).forEach(function (record) {
      var localValue = metric(record.local, metricName);
      var peerValue = metric(record.peer, metricName);
      if (localValue !== null) local.push(localValue);
      if (peerValue !== null) peer.push(peerValue);
    });
    var hasData = drawLine(context, local, width, height, color) || drawLine(context, peer, width, height, '#fbbf24');
    canvas.parentNode.querySelector('.canvas-empty').hidden = hasData;
  }

  function filterRecentHistory(records) {
    var cutoff = Date.now() - HISTORY_RETENTION_MS;
    return (Array.isArray(records) ? records : []).filter(function (record) {
      var sampledAt = Date.parse(record && record.sampledAt);
      return !isNaN(sampledAt) && sampledAt >= cutoff;
    });
  }

  function renderTrends(history) {
    var recentHistory = filterRecentHistory(history);
    el.trend.querySelectorAll('canvas').forEach(function (canvas) {
      drawTrend(canvas, recentHistory, canvas.getAttribute('data-metric'), '#22d3ee');
    });
  }

  function renderRequestError(error) {
    if (!error) {
      el.requestError.hidden = true;
      el.requestError.textContent = '';
      return;
    }
    el.requestError.textContent = '总览请求失败：' + str(error.message, '暂无数据');
    el.requestError.hidden = false;
  }

  function render(payload) {
    state.snapshot = payload && payload.snapshot || null;
    state.history = payload && Array.isArray(payload.history) ? payload.history : [];
    var currentAlerts = alerts(state.snapshot);
    el.updatedAt.textContent = '最后采样：' + timeText(state.snapshot && state.snapshot.sampledAt);
    el.role.textContent = state.snapshot ? (state.snapshot.selfRole === 'primary' ? '主机' : '备机') : '--';
    el.health.className = state.snapshot ? (currentAlerts.length ? 'warn' : 'ok') : 'unknown';
    el.health.textContent = state.snapshot ? (currentAlerts.length ? '存在异常' : '运行正常') : '暂无数据';
    renderHosts(state.snapshot);
    renderServices(state.snapshot);
    renderAlerts(state.snapshot);
    renderTrends(state.history);
    if (payload) renderRequestError(null);
  }

  function request(url, options) {
    return fetch(url, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok || !data.ok) throw new Error(data.message || ('HTTP ' + response.status));
        return data;
      });
    });
  }

  function load() {
    return request(READ_URL, { credentials: 'same-origin' }).then(render).catch(function (error) {
      if (!state.snapshot) render(null);
      renderRequestError(error);
    });
  }

  el.refresh.addEventListener('click', function () {
    el.refresh.disabled = true;
    el.refresh.setAttribute('aria-busy', 'true');
    el.refresh.textContent = '刷新中';
    request(REFRESH_URL, { method: 'POST', credentials: 'same-origin' }).then(render).catch(function (error) {
      if (!state.snapshot) render(null);
      renderRequestError(error);
    }).then(function () {
      el.refresh.disabled = false;
      el.refresh.setAttribute('aria-busy', 'false');
      el.refresh.textContent = '刷新';
    });
  });

  window.addEventListener('resize', function () { renderTrends(state.history); });
  load();
  window.drawTrend = drawTrend;
}());
