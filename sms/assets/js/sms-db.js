(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    dbHost: $('dbHost'),
    dbPort: $('dbPort'),
    dbDatabase: $('dbDatabase'),
    dbUser: $('dbUser'),
    dbPassword: $('dbPassword'),
    dbRememberPassword: $('dbRememberPassword'),
    btnConnect: $('btnConnect'),
    btnDisconnect: $('btnDisconnect'),
    btnRefresh: $('btnRefresh'),
    dbDot: $('dbDot'),
    dbState: $('dbState'),
    statusBox: $('statusBox'),
    saveHint: $('saveHint'),
    driverHint: $('driverHint'),
    modal: $('dbModal'),
    btnOpen: $('btnOpenDbModal'),
    btnClose: $('btnCloseDbModal'),
  };

  function openModal() {
    if (!el.modal) return;
    el.modal.classList.add('open');
    el.modal.setAttribute('aria-hidden', 'false');
  }
  function closeModal() {
    if (!el.modal) return;
    el.modal.classList.remove('open');
    el.modal.setAttribute('aria-hidden', 'true');
  }
  el.btnOpen && el.btnOpen.addEventListener('click', openModal);
  el.btnClose && el.btnClose.addEventListener('click', closeModal);

  var userEditedPassword = false;
  var formInitialized = false;
  el.dbPassword.addEventListener('input', function () { userEditedPassword = true; });

  function setButtonsBusy(busy) {
    el.btnConnect.disabled = busy;
    el.btnDisconnect.disabled = busy;
    el.btnRefresh.disabled = busy;
  }

  function fillForm(s) {
    // 只在首次加载时用服务端值回填，避免轮询把用户正在输入的内容冲掉
    if (formInitialized) return;
    formInitialized = true;
    if (s.host) el.dbHost.value = s.host;
    if (s.port) el.dbPort.value = s.port;
    if (s.database != null) el.dbDatabase.value = s.database;
    if (s.user != null) el.dbUser.value = s.user;
    if (s.connected && !userEditedPassword) {
      el.dbPassword.placeholder = '••••••（保持上次保存的密码）';
    }
    // 复选框初始态：autoStart=true 说明上次勾了"记住密码"；否则不勾
    if (el.dbRememberPassword) {
      el.dbRememberPassword.checked = !!s.autoStart;
    }
  }

  function renderStatus(s) {
    el.dbDot.classList.remove('on', 'off', 'err');
    if (s.connected) {
      el.dbDot.classList.add('on');
      el.dbState.textContent = '已连接' + (s.autoStart ? '（开机自启已开启）' : '');
    } else if (s.autoRetrying) {
      el.dbDot.classList.add('err');
      el.dbState.textContent = '后台重试中（已尝试 ' + (s.autoRetryCount || 0) + ' 次）';
    } else if (s.lastError) {
      el.dbDot.classList.add('err');
      el.dbState.textContent = '未连接 · 上次错误';
    } else {
      el.dbDot.classList.add('off');
      el.dbState.textContent = s.autoStart ? '未连接（已标记自启，等待重试）' : '未连接';
    }
    var lines = [];
    lines.push('驱动：' + (s.driverReady ? 'mysql2 已加载' : '未安装 mysql2'));
    lines.push('目标：' + (s.user || '(空)') + '@' + (s.host || '-') + ':' + (s.port || '-') + '/' + (s.database || '-'));
    lines.push('开机自启：' + (s.autoStart ? '开启' : '关闭'));
    if (s.autoRetrying) lines.push('后台重试：每 5s 试一次，已尝试 ' + (s.autoRetryCount || 0) + ' 次');
    if (s.lastConnectedAt) lines.push('上次成功时间：' + s.lastConnectedAt);
    if (s.lastError) lines.push('上次错误：' + s.lastError);
    el.statusBox.innerHTML = '';
    el.statusBox.textContent = lines.join('\n');
    el.driverHint.textContent = s.driverReady ? '' : '⚠ 未安装 mysql2';
  }

  function hint(text, color) {
    el.saveHint.textContent = text || '';
    el.saveHint.style.color = color || '#94a3b8';
    if (text) setTimeout(function () {
      if (el.saveHint.textContent === text) el.saveHint.textContent = '';
    }, 3000);
  }

  async function loadStatus() {
    try {
      var resp = await fetch('/api/sms/db/status');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      fillForm(data);
      renderStatus(data);
      return data;
    } catch (err) {
      el.statusBox.textContent = '加载状态失败：' + err.message;
      el.dbDot.classList.remove('on', 'off');
      el.dbDot.classList.add('err');
      el.dbState.textContent = '离线';
    }
  }

  async function doConnect() {
    var rememberPassword = el.dbRememberPassword ? !!el.dbRememberPassword.checked : true;
    var body = {
      host: (el.dbHost.value || '').trim(),
      port: Number(el.dbPort.value) || 3306,
      database: (el.dbDatabase.value || '').trim(),
      user: (el.dbUser.value || '').trim(),
      password: el.dbPassword.value,
      rememberPassword: rememberPassword,
    };
    if (!body.user) { hint('用户名不能为空', '#fca5a5'); return; }
    // 不记住密码时，必须当场输入；不允许"沿用上次落盘密码"——后端也不会有
    if (!rememberPassword && body.password === '') {
      hint('未勾选记住密码时，必须输入密码', '#fca5a5');
      return;
    }
    // 如果用户留空密码且已经连过：让后端沿用存盘的；这里空串原样传，后端收到空串会当空密码尝试
    // 为避免误操作，没改过密码时提示让用户确认
    if (rememberPassword && !userEditedPassword && body.password === '') {
      if (!confirm('密码框为空，是否以空密码连接？如果想沿用上次的密码请"断开"后再连接。')) return;
    }
    setButtonsBusy(true);
    hint('连接中…');
    try {
      var resp = await fetch('/api/sms/db/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      if (!resp.ok || !data.ok) {
        hint('连接失败', '#fca5a5');
        renderStatus(data && data.status ? data.status : { connected: false, lastError: data && data.message });
        return;
      }
      userEditedPassword = false;
      el.dbPassword.value = '';
      hint('连接成功，已开启自启', '#a7f3d0');
      renderStatus(data.status);
      setTimeout(closeModal, 600);
    } catch (err) {
      hint('请求失败：' + err.message, '#fca5a5');
    } finally {
      setButtonsBusy(false);
    }
  }

  async function doDisconnect() {
    if (!confirm('断开连接后，下次开机/重启将不再自动连接数据库。是否继续？')) return;
    setButtonsBusy(true);
    hint('断开中…');
    try {
      var resp = await fetch('/api/sms/db/disconnect', { method: 'POST' });
      var data = await resp.json();
      if (!resp.ok || !data.ok) {
        hint('断开失败', '#fca5a5');
        return;
      }
      hint('已断开，自启已关闭', '#fcd34d');
      renderStatus(data.status);
    } catch (err) {
      hint('请求失败：' + err.message, '#fca5a5');
    } finally {
      setButtonsBusy(false);
    }
  }

  el.btnConnect.addEventListener('click', doConnect);
  el.btnDisconnect.addEventListener('click', doDisconnect);
  el.btnRefresh.addEventListener('click', function () { loadStatus(); });

  loadStatus();
  // 轻量轮询，给 autoStart 失败后的重试留个入口
  setInterval(loadStatus, 15000);
})();
