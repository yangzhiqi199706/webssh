// 协议转换 → SNMP v2c 转发：UI 面板（顶栏按钮 + 弹窗 + 状态条 + CSV）
// 不需要扫描设备树（数据来源复用 Modbus 已选设备 / 控制项）
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Mon = window.PcMonitor || { append: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var el = {
    btnOpen: $('btnOpenSnmp'),
    snmpDot: $('snmpDot'),
    modal: $('snmpModal'),
    btnClose: $('btnCloseSnmp'),

    cfgPort: $('snCfgPort'),
    cfgRead: $('snCfgRead'),
    cfgWrite: $('snCfgWrite'),
    cfgEnableSet: $('snCfgEnableSet'),
    cfgWhitelist: $('snCfgWhitelist'),

    statusLine: $('snStatusLine'),
    errLine: $('snErrLine'),
    summaryLine: $('snSummaryLine'),

    btnSave: $('snBtnSave'),
    btnEnable: $('snBtnEnable'),
    btnDisable: $('snBtnDisable'),
    btnDownloadCsv: $('snBtnDownloadCsv'),
    saveHint: $('snSaveHint'),
  };
  if (!el.btnOpen || !el.modal) return;

  var statusTimer = null;

  function setHint(text, cls) {
    el.saveHint.textContent = text || '';
    el.saveHint.className = 'hint' + (cls ? ' ' + cls : '');
  }
  function setDot(state) {
    if (!el.snmpDot) return;
    el.snmpDot.classList.remove('on', 'off', 'warn', 'err');
    el.snmpDot.classList.add(state || 'off');
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
      var r = await fetch('/api/proto-conv/snmp/config').then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '读取失败');
      var c = r.config || {};
      el.cfgPort.value = c.port || 16162;
      el.cfgRead.value = c.readCommunity || 'public';
      el.cfgWrite.value = c.writeCommunity || 'private';
      el.cfgEnableSet.checked = !!c.enableSet;
      el.cfgWhitelist.value = (c.ipWhitelist || []).join(', ');
    } catch (err) {
      setHint('读取配置失败：' + err.message, 'err');
    }
  }

  // ---- 状态刷新 ----
  async function refreshStatus() {
    try {
      var r = await fetch('/api/proto-conv/snmp/status').then(function (r) { return r.json(); });
      var s = r.status || {};
      var enabledTag = s.enabled ? '🟢 已启用（重启后自动恢复）' : '⚪ 已停用';
      var line = enabledTag + ' · ' +
        (s.running ? '运行中 监听 udp/' + s.port : '未运行') +
        ' · ' + (s.oidCount || 0) + ' OID' +
        ' · 设备 ' + (s.deviceCount || 0) +
        ' · 控制 ' + (s.commandCount || 0) +
        (s.lastSyncAt ? ' · 上次同步 ' + s.lastSyncAt : '') +
        (s.setCount ? ' · SET ' + s.setCount + ' 次' : '');
      el.statusLine.textContent = line;
      el.errLine.textContent = s.lastError ? '最近错误: ' + s.lastError : '最近错误: (无)';
      el.errLine.className = s.lastError ? 'hint err' : 'hint';
      setDot(s.lastError ? 'err' : (s.running && s.enabled ? 'on' : 'off'));

      // 提示数据来源
      if (s.deviceCount === 0 && s.commandCount === 0) {
        el.summaryLine.innerHTML = '⚠ 暂无可暴露的 OID。请先在<b>「Modbus 转发」</b>选设备，或在<b>「Modbus 控制转换」</b>选控制项。';
        el.summaryLine.className = 'mb-summary err';
      } else {
        el.summaryLine.innerHTML = '数据来源：Modbus 转发已选 <b>' + s.deviceCount + '</b> 设备 + Modbus 控制转换已选 <b>' + s.commandCount + '</b> 控制项 → 共 <b>' + s.oidCount + '</b> 个 OID';
        el.summaryLine.className = 'mb-summary';
      }
    } catch (err) {
      el.statusLine.textContent = '状态读取失败：' + err.message;
      setDot('err');
    }
  }

  // ---- 保存 / 启停 ----
  async function saveAndApply(enabledOverride) {
    var port = Number(el.cfgPort.value) || 16162;
    if (port < 1 || port > 65535) { setHint('端口必须 1-65535', 'err'); return; }
    var read = (el.cfgRead.value || '').trim() || 'public';
    var write = (el.cfgWrite.value || '').trim() || 'private';
    var enableSet = !!el.cfgEnableSet.checked;
    var whitelistRaw = (el.cfgWhitelist.value || '').trim();
    var ipWhitelist = whitelistRaw
      ? whitelistRaw.split(/[,\s]+/).map(function (s) { return s.trim(); }).filter(Boolean)
      : [];

    var body = {
      port: port,
      readCommunity: read,
      writeCommunity: write,
      enableSet: enableSet,
      ipWhitelist: ipWhitelist,
    };
    if (enabledOverride != null) body.enabled = !!enabledOverride;

    el.btnSave.disabled = true;
    setHint('保存中…');
    try {
      var r = await fetch('/api/proto-conv/snmp/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '保存失败');
      setHint('已保存', 'ok');
      Mon.info('SNMP → 配置已保存：udp/' + port + ' read=' + read + (enableSet ? ' write=' + write : ' RO-only'));
      refreshStatus();
    } catch (err) {
      setHint('保存失败：' + err.message, 'err');
      Mon.error('SNMP 保存失败：' + err.message);
    } finally {
      el.btnSave.disabled = false;
    }
  }
  async function doEnable() { await saveAndApply(true); }
  async function doDisable() {
    setHint('停用中…');
    try {
      await fetch('/api/proto-conv/snmp/stop', { method: 'POST' });
      setHint('已停用', 'ok');
      refreshStatus();
      Mon.info('SNMP → 已停用');
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
  el.btnDownloadCsv.addEventListener('click', function () { window.open('/api/proto-conv/snmp/map.csv'); });

  // 主面板首屏拉一次状态刷顶栏 LED
  refreshStatus();
  setInterval(refreshStatus, 5000);

  window.PcSnmp = { open: open, refresh: refreshStatus };
})();
