// SIP 配置弹窗
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    btnOpen: $('btnOpenConfig'),
    btnClose: $('btnCloseConfig'),
    modal: $('configModal'),
    localPort: $('cfgLocalPort'),
    transport: $('cfgTransport'),
    protocolVersion: $('cfgProtocolVersion'),
    streamIndex: $('cfgStreamIndex'),
    serverId: $('cfgServerId'),
    serverDomain: $('cfgServerDomain'),
    authPwd: $('cfgAuthPwd'),
    registerExpires: $('cfgRegisterExpires'),
    keepaliveInterval: $('cfgKeepaliveInterval'),
    keepaliveTimeout: $('cfgKeepaliveTimeout'),
    whitelist: $('cfgWhitelist'),
    zlmApi: $('cfgZlmApi'),
    zlmSecret: $('cfgZlmSecret'),
    btnSave: $('btnCfgSave'),
    btnReload: $('btnCfgReload'),
    saveHint: $('cfgSaveHint'),
  };

  function setHint(text, cls) {
    if (!el.saveHint) return;
    el.saveHint.textContent = text || '';
    el.saveHint.className = 'hint' + (cls ? ' ' + cls : '');
  }

  function open() {
    el.modal.classList.add('open');
    el.modal.setAttribute('aria-hidden', 'false');
    loadConfig();
  }
  function close() {
    el.modal.classList.remove('open');
    el.modal.setAttribute('aria-hidden', 'true');
  }

  function fillForm(cfg) {
    var s = (cfg && cfg.sip) || {};
    var z = (cfg && cfg.zlm) || {};
    el.localPort.value = s.localPort || 5060;
    el.transport.value = s.transport || 'UDP';
    el.protocolVersion.value = s.protocolVersion || 'GB/T28181-2016';
    el.streamIndex.value = s.streamIndex || 'main';
    el.serverId.value = s.serverId || '';
    el.serverDomain.value = s.serverDomain || '';
    el.authPwd.value = '';
    el.authPwd.placeholder = s.hasAuthPwd ? '已保存（留空保持原值）' : '留空保持原值';
    el.registerExpires.value = s.registerExpires || 3600;
    el.keepaliveInterval.value = s.keepaliveInterval || 60;
    el.keepaliveTimeout.value = s.keepaliveTimeout || 3;
    el.whitelist.value = (s.whitelist || []).join('\n');
    el.zlmApi.value = z.apiBase || 'http://127.0.0.1:8000';
    el.zlmSecret.value = '';
    el.zlmSecret.placeholder = z.hasSecret ? '已保存（留空保持原值）' : '留空保持原值';
  }

  async function loadConfig() {
    setHint('加载中…');
    try {
      var r = await fetch('/api/video/config').then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '读取失败');
      fillForm(r.config);
      setHint('已加载', 'ok');
      window.VideoBus && window.VideoBus.emit('config-loaded', r.config);
    } catch (err) {
      setHint('加载失败：' + err.message, 'err');
    }
  }

  function parseWhitelist(raw) {
    if (!raw) return [];
    return String(raw).split(/[\s,，;；\n\r]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  async function doSave() {
    var sip = {
      localPort: Number(el.localPort.value) || 5060,
      transport: el.transport.value || 'UDP',
      protocolVersion: el.protocolVersion.value || 'GB/T28181-2016',
      streamIndex: el.streamIndex.value || 'main',
      serverId: (el.serverId.value || '').trim(),
      serverDomain: (el.serverDomain.value || '').trim(),
      registerExpires: Number(el.registerExpires.value) || 3600,
      keepaliveInterval: Number(el.keepaliveInterval.value) || 60,
      keepaliveTimeout: Number(el.keepaliveTimeout.value) || 3,
      whitelist: parseWhitelist(el.whitelist.value),
    };
    var pwd = el.authPwd.value;
    if (pwd && pwd !== '') sip.authPwd = pwd;

    var zlm = { apiBase: (el.zlmApi.value || '').trim() || 'http://127.0.0.1:8000' };
    var sec = el.zlmSecret.value;
    if (sec && sec !== '') zlm.secret = sec;

    setHint('保存中…');
    try {
      var r = await fetch('/api/video/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sip: sip, zlm: zlm }),
      }).then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '保存失败');
      setHint(r.needRestart ? '已保存。改了端口，请重启 webssh-mediaserver 才能生效' : '已保存并热生效', 'ok');
      window.VideoBus && window.VideoBus.emit('config-saved', r.config);
    } catch (err) {
      setHint('保存失败：' + err.message, 'err');
    }
  }

  el.btnOpen && el.btnOpen.addEventListener('click', open);
  el.btnClose && el.btnClose.addEventListener('click', close);
  el.btnSave && el.btnSave.addEventListener('click', doSave);
  el.btnReload && el.btnReload.addEventListener('click', loadConfig);

  // 启动时也读一次（不弹窗，仅用于其他模块感知）
  fetch('/api/video/config').then(function (r) { return r.json(); }).then(function (r) {
    if (r && r.ok) window.VideoBus && window.VideoBus.emit('config-loaded', r.config);
  }).catch(function () {});

  window.VideoConfig = { open: open, close: close, reload: loadConfig };
})();
