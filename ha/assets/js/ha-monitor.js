(function () {
  'use strict';

  var Bus = window.HaBus || { on: function () {}, emit: function () {} };

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    enableSwitch: $('enableSwitch'),
    enableLabel: $('enableLabel'),
    roleTag: $('roleTag'),
    selfDot: $('selfDot'),
    selfKv: $('selfKv'),
    peerDot: $('peerDot'),
    peerKv: $('peerKv'),
    hbDot: $('hbDot'),
    hbKv: $('hbKv'),
    msgList: $('msgList'),
    btnPauseScroll: $('btnPauseScroll'),
    btnClearMsg: $('btnClearMsg'),
  };

  var state = {
    enabled: false,
    selfRole: 'primary',
    peer: null,
    ssh: { status: 'idle', lastError: '' },
    db: { connected: false },
    heartbeat: { ipOk: false, dbPortOk: false, ts: 0 },
    pauseScroll: false,
    msgCount: 0,
  };
  var MAX_MSG = 200;

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function kvRow(k, v, vClass) {
    return '<div class="kv-row"><span class="k">' + escHtml(k) + '</span>' +
      '<span class="v ' + (vClass || '') + '">' + (v == null ? '-' : v) + '</span>' +
      '<span></span></div>';
  }

  function pill(text, klass) {
    return '<span class="pill ' + klass + '">' + escHtml(text) + '</span>';
  }

  function renderTopBar() {
    if (el.enableSwitch) {
      el.enableSwitch.classList.toggle('on', !!state.enabled);
    }
    if (el.enableLabel) {
      el.enableLabel.textContent = state.enabled ? '已启用' : '未启用';
    }
    if (el.roleTag) {
      el.roleTag.textContent = state.selfRole === 'primary' ? '本机：主机' : '本机：备机';
      el.roleTag.classList.remove('primary', 'standby');
      el.roleTag.classList.add(state.selfRole === 'primary' ? 'primary' : 'standby');
    }
  }

  function renderSelf() {
    if (!el.selfKv) return;
    var roleText = state.selfRole === 'primary' ? '主机' : '备机';
    var rows = [];
    rows.push(kvRow('角色', escHtml(roleText)));
    rows.push(kvRow('总开关', state.enabled ? pill('已启用', 'ok') : pill('未启用', 'warn')));
    el.selfKv.innerHTML = rows.join('');
    el.selfDot.className = 'dot ' + (state.enabled ? 'on' : 'off');
  }

  function renderPeer() {
    if (!el.peerKv) return;
    var p = state.peer || {};
    var sshStat = state.ssh && state.ssh.status;
    var sshPill;
    if (sshStat === 'connected') sshPill = pill('已连接', 'ok');
    else if (sshStat === 'connecting') sshPill = pill('连接中', 'warn');
    else if (sshStat === 'broken') sshPill = pill('已断开', 'err');
    else sshPill = pill('待启动', 'warn');

    var dbPill = state.db && state.db.connected
      ? pill('已连接', 'ok')
      : (state.db && state.db.autoRetrying ? pill('重试中(' + (state.db.autoRetryCount || 0) + ')', 'warn') : pill('未连接', 'err'));

    var rows = [];
    rows.push(kvRow('SSH', escHtml((p.sshHost || '-') + ':' + (p.sshPort || '-')), 'mono'));
    rows.push(kvRow('SSH 状态', sshPill));
    rows.push(kvRow('DB', escHtml((p.dbHost || '-') + ':' + (p.dbPort || '-') + '/' + (p.dbDatabase || '-')), 'mono'));
    rows.push(kvRow('DB 状态', dbPill));
    if (state.ssh && state.ssh.lastError) {
      rows.push(kvRow('SSH 错误', '<span class="err">' + escHtml(state.ssh.lastError) + '</span>'));
    }
    if (state.db && state.db.lastError && !state.db.connected) {
      rows.push(kvRow('DB 错误', '<span class="err">' + escHtml(state.db.lastError) + '</span>'));
    }
    el.peerKv.innerHTML = rows.join('');
    el.peerDot.className = 'dot ' + (sshStat === 'connected' && state.db && state.db.connected ? 'on'
      : (sshStat === 'broken' ? 'err' : 'warn'));
  }

  function renderHeartbeat() {
    if (!el.hbKv) return;
    var hb = state.heartbeat || {};
    var ipPill = hb.ipOk ? pill('通', 'ok') : pill('不通', 'err');
    var dbPill = hb.dbPortOk ? pill('通', 'ok') : pill('不通', 'err');
    var rows = [];
    rows.push(kvRow('对端 IP', ipPill));
    rows.push(kvRow('对端 DB 端口', dbPill));
    rows.push(kvRow('最近时间', escHtml(hb.ts || '尚无')));
    el.hbKv.innerHTML = rows.join('');
    var bothOk = hb.ipOk && hb.dbPortOk;
    el.hbDot.className = 'dot ' + (state.enabled ? (bothOk ? 'on' : (hb.ipOk ? 'warn' : 'err')) : 'off');
  }

  function renderAll() {
    renderTopBar();
    renderSelf();
    renderPeer();
    renderHeartbeat();
  }

  function appendMsg(level, msg, ts) {
    if (!el.msgList) return;
    var lvl = (level || 'info').toLowerCase();
    if (['info', 'warn', 'error'].indexOf(lvl) < 0) lvl = 'info';
    var node = document.createElement('div');
    node.className = 'msg-item lvl-' + lvl;
    node.innerHTML = '<span class="ts">[' + escHtml(ts || '') + ']</span>' +
      '<span class="lvl-tag">' + lvl.toUpperCase() + '</span>' +
      escHtml(msg || '');
    el.msgList.appendChild(node);
    state.msgCount += 1;
    while (el.msgList.childElementCount > MAX_MSG) {
      el.msgList.removeChild(el.msgList.firstChild);
      state.msgCount -= 1;
    }
    if (!state.pauseScroll) {
      el.msgList.scrollTop = el.msgList.scrollHeight;
    }
  }

  Bus.on('snapshot', function (data) {
    if (!data) return;
    state.enabled = !!data.enabled;
    state.selfRole = data.selfRole || 'primary';
    state.peer = data.peer || null;
    state.ssh = data.ssh || state.ssh;
    state.db = data.db || state.db;
    state.heartbeat = data.heartbeat || state.heartbeat;
    renderAll();
    // 把后端最近事件回填一次（仅当当前消息列表为空，避免重复）
    if (state.msgCount === 0 && Array.isArray(data.recentEvents)) {
      data.recentEvents.forEach(function (ev) { appendMsg(ev.level, ev.msg, ev.ts); });
    }
  });

  Bus.on('event', function (ev) {
    if (!ev) return;
    appendMsg(ev.level, ev.msg, ev.ts);
  });

  Bus.on('heartbeat', function (hb) {
    if (!hb) return;
    state.heartbeat = hb;
    renderHeartbeat();
  });

  // 顶部「总开关」点击：仅作快速切换，等价于打开「连接信息」并切 enabled
  el.enableSwitch && el.enableSwitch.addEventListener('click', function () {
    if (window.HaConfig && typeof window.HaConfig.toggleEnabled === 'function') {
      window.HaConfig.toggleEnabled();
    } else {
      $('btnOpenConfig') && $('btnOpenConfig').click();
    }
  });

  el.btnPauseScroll && el.btnPauseScroll.addEventListener('click', function () {
    state.pauseScroll = !state.pauseScroll;
    el.btnPauseScroll.textContent = state.pauseScroll ? '继续滚动' : '暂停滚动';
  });
  el.btnClearMsg && el.btnClearMsg.addEventListener('click', function () {
    if (el.msgList) { el.msgList.innerHTML = ''; state.msgCount = 0; }
  });

  // 首屏兜底：调一次 /api/ha/status，避免 ws 还没握手时显示空白
  fetch('/api/ha/status').then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.ok && j.status) Bus.emit('snapshot', j.status);
  }).catch(function () {});

  renderAll();
})();
