// 协议转换 → IEC 60870-5-104 转发：UI 面板（顶栏按钮 + 弹窗 + 状态条 + 点表 CSV）
// 数据来源复用「Modbus 转发」已选设备，本面板只管 IEC104 自己的端口/CA/IOA/周期等
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Mon = window.PcMonitor || { append: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var el = {
    btnOpen: $('btnOpenIec104'),
    iec104Dot: $('iec104Dot'),
    modal: $('iec104Modal'),
    btnClose: $('btnCloseIec104'),

    cfgPort: $('i4CfgPort'),
    cfgCa: $('i4CfgCa'),
    cfgIoaSp: $('i4CfgIoaSp'),
    cfgIoaMf: $('i4CfgIoaMf'),
    cfgCyclic: $('i4CfgCyclic'),
    cfgEnableSpont: $('i4CfgEnableSpont'),
    cfgDeadband: $('i4CfgDeadband'),
    cfgWhitelist: $('i4CfgWhitelist'),

    statusLine: $('i4StatusLine'),
    errLine: $('i4ErrLine'),
    summaryLine: $('i4SummaryLine'),
    clientBox: $('i4ClientBox'),

    btnSave: $('i4BtnSave'),
    btnEnable: $('i4BtnEnable'),
    btnDisable: $('i4BtnDisable'),
    btnDownloadCsv: $('i4BtnDownloadCsv'),
    saveHint: $('i4SaveHint'),
  };
  if (!el.btnOpen || !el.modal) return;

  var statusTimer = null;

  function setHint(text, cls) {
    el.saveHint.textContent = text || '';
    el.saveHint.className = 'hint' + (cls ? ' ' + cls : '');
  }
  function setDot(state) {
    if (!el.iec104Dot) return;
    el.iec104Dot.classList.remove('on', 'off', 'warn', 'err');
    el.iec104Dot.classList.add(state || 'off');
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function open() {
    el.modal.classList.add('open');
    el.modal.setAttribute('aria-hidden', 'false');
    loadConfig().then(function () { refreshStatus(); });
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(refreshStatus, 2000);
  }
  function close() {
    el.modal.classList.remove('open');
    el.modal.setAttribute('aria-hidden', 'true');
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  }

  // ---- 配置读 ----
  async function loadConfig() {
    try {
      var r = await fetch('/api/proto-conv/iec104/config').then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '读取失败');
      var c = r.config || {};
      var ioa = c.ioaBase || {};
      el.cfgPort.value = c.port || 2405;
      el.cfgCa.value = c.commonAddr || 1;
      el.cfgIoaSp.value = ioa.singlePoint || 1;
      el.cfgIoaMf.value = ioa.measuredFloat || 16385;
      el.cfgCyclic.value = c.cyclicIntervalSec || 30;
      el.cfgEnableSpont.checked = c.enableSpont !== false; // 默认 true
      el.cfgDeadband.value = (c.deadbandFloat != null) ? c.deadbandFloat : 0.01;
      el.cfgWhitelist.value = (c.ipWhitelist || []).join(', ');
    } catch (err) {
      setHint('读取配置失败：' + err.message, 'err');
    }
  }

  // ---- 状态刷新 ----
  function renderClients(clients) {
    if (!clients || !clients.length) {
      el.clientBox.innerHTML = '<div class="hint">尚无 master 接入</div>';
      return;
    }
    var rows = ['<div style="display:grid;grid-template-columns:1.5fr .8fr .9fr 1fr 1.2fr;gap:6px;color:#94a3b8;font-size:11px;padding-bottom:4px;border-bottom:1px dashed #1e293b">' +
      '<span>地址</span><span>STARTDT</span><span>N(S)/N(R)</span><span>已发/收 I-frame</span><span>最近活动</span></div>'];
    clients.forEach(function (c) {
      rows.push('<div style="display:grid;grid-template-columns:1.5fr .8fr .9fr 1fr 1.2fr;gap:6px;padding:3px 0">' +
        '<span>' + escHtml(c.remoteAddr) + '</span>' +
        '<span>' + (c.startDt ? '<span style="color:#a7f3d0">on</span>' : '<span style="color:#94a3b8">off</span>') + '</span>' +
        '<span>' + c.sendSeq + '/' + c.recvSeq + '</span>' +
        '<span>' + c.sentIFrames + ' / ' + c.recvIFrames + '</span>' +
        '<span>' + escHtml(c.lastActivityAt) + '</span>' +
        '</div>');
    });
    el.clientBox.innerHTML = rows.join('');
  }

  async function refreshStatus() {
    try {
      var r = await fetch('/api/proto-conv/iec104/status').then(function (r) { return r.json(); });
      var s = r.status || {};
      var enabledTag = s.enabled ? '🟢 已启用（重启后自动恢复）' : '⚪ 已停用';
      var line = enabledTag + ' · ' +
        (s.running ? '运行中 监听 tcp/' + s.port : '未运行') +
        ' · 设备 ' + (s.deviceCount || 0) +
        ' · 遥信 ' + (s.singlePointCount || 0) +
        ' · 遥测 ' + (s.measuredFloatCount || 0) +
        ' · 在线 master ' + (s.clientCount || 0) +
        (s.totalSent ? ' · 已发 I-frame ' + s.totalSent : '') +
        (s.totalSpont ? ' · SPONT ' + s.totalSpont : '') +
        (s.lastSpontAt ? ' · 上次 SPONT ' + s.lastSpontAt : '') +
        (s.lastSyncAt ? ' · 上次同步 ' + s.lastSyncAt : '');
      el.statusLine.textContent = line;
      el.errLine.textContent = s.lastError ? '最近错误: ' + s.lastError : '最近错误: (无)';
      el.errLine.className = s.lastError ? 'hint err' : 'hint';
      setDot(s.lastError ? 'err' : (s.running && s.enabled ? 'on' : 'off'));

      if (s.deviceCount === 0) {
        el.summaryLine.innerHTML = '⚠ 暂无可暴露的点。请先在<b>「Modbus 转发」</b>选设备。';
        el.summaryLine.className = 'mb-summary err';
      } else {
        el.summaryLine.innerHTML = '数据来源：Modbus 转发已选 <b>' + s.deviceCount + '</b> 设备 → ' +
          '遥信 <b>' + (s.singlePointCount || 0) + '</b> 点 + 遥测 <b>' + (s.measuredFloatCount || 0) + '</b> 点 ' +
          '= 共 <b>' + (s.pointCount || 0) + '</b> 个 IOA';
        el.summaryLine.className = 'mb-summary';
      }
      renderClients(s.clients || []);
    } catch (err) {
      el.statusLine.textContent = '状态读取失败：' + err.message;
      setDot('err');
    }
  }

  // ---- 保存 / 启停 ----
  async function saveAndApply(enabledOverride) {
    var port = Number(el.cfgPort.value) || 2405;
    if (port < 1 || port > 65535) { setHint('端口必须 1-65535', 'err'); return; }
    var ca = Number(el.cfgCa.value) || 1;
    if (ca < 1 || ca > 65534) { setHint('公共地址必须 1-65534', 'err'); return; }
    var sp = Number(el.cfgIoaSp.value) || 1;
    var mf = Number(el.cfgIoaMf.value) || 16385;
    if (sp < 1 || sp > 16777215) { setHint('遥信起始点号必须 1-16777215', 'err'); return; }
    if (mf < 1 || mf > 16777215) { setHint('遥测起始点号必须 1-16777215', 'err'); return; }
    var cyclic = Number(el.cfgCyclic.value) || 30;
    if (cyclic < 1 || cyclic > 3600) { setHint('周期间隔必须 1-3600 秒', 'err'); return; }
    var enableSpont = !!el.cfgEnableSpont.checked;
    var deadband = Number(el.cfgDeadband.value);
    if (!Number.isFinite(deadband) || deadband < 0) { setHint('模拟量死区必须是 ≥ 0 的数', 'err'); return; }
    var whitelistRaw = (el.cfgWhitelist.value || '').trim();
    var ipWhitelist = whitelistRaw
      ? whitelistRaw.split(/[,\s]+/).map(function (s) { return s.trim(); }).filter(Boolean)
      : [];

    var body = {
      port: port,
      commonAddr: ca,
      cyclicIntervalSec: cyclic,
      enableSpont: enableSpont,
      deadbandFloat: deadband,
      ioaBase: { singlePoint: sp, measuredFloat: mf },
      ipWhitelist: ipWhitelist,
    };
    if (enabledOverride != null) body.enabled = !!enabledOverride;

    el.btnSave.disabled = true;
    setHint('保存中…');
    try {
      var r = await fetch('/api/proto-conv/iec104/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '保存失败');
      setHint('已保存', 'ok');
      Mon.info('IEC104 → 配置已保存：tcp/' + port + ' CA=' + ca +
        ' SP起始=' + sp + ' MF起始=' + mf +
        ' 周期=' + cyclic + 's' +
        ' SPONT=' + (enableSpont ? '开' : '关') +
        ' 死区=' + deadband);
      refreshStatus();
    } catch (err) {
      setHint('保存失败：' + err.message, 'err');
      Mon.error('IEC104 保存失败：' + err.message);
    } finally {
      el.btnSave.disabled = false;
    }
  }
  async function doEnable() { await saveAndApply(true); }
  async function doDisable() {
    setHint('停用中…');
    try {
      await fetch('/api/proto-conv/iec104/stop', { method: 'POST' });
      setHint('已停用', 'ok');
      refreshStatus();
      Mon.info('IEC104 → 已停用');
    } catch (err) {
      setHint('停用失败：' + err.message, 'err');
    }
  }

  // ---- 事件 ----
  el.btnOpen.addEventListener('click', open);
  el.btnClose.addEventListener('click', close);
  el.modal.addEventListener('click', function (e) { if (e.target === el.modal) close(); });
  el.btnSave.addEventListener('click', function () { saveAndApply(); });
  el.btnEnable.addEventListener('click', doEnable);
  el.btnDisable.addEventListener('click', doDisable);
  el.btnDownloadCsv.addEventListener('click', function () { window.open('/api/proto-conv/iec104/map.csv'); });

  // 主面板首屏拉一次状态刷顶栏 LED
  refreshStatus();
  setInterval(refreshStatus, 5000);

  window.PcIec104 = { open: open, refresh: refreshStatus };
})();
