// 协议转换 → Modbus TCP 转发：UI 面板（顶栏按钮 + 弹窗 + 设备多选树 + 状态条）
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Mon = window.PcMonitor || { append: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var el = {
    btnOpen: $('btnOpenModbus'),
    modbusDot: $('modbusDot'),
    modal: $('modbusModal'),
    btnClose: $('btnCloseModbus'),

    cfgPort: $('mbCfgPort'),
    cfgPoll: $('mbCfgPoll'),
    statusLine: $('mbStatusLine'),
    errLine: $('mbErrLine'),
    missingLine: $('mbMissingLine'),

    btnScan: $('mbBtnScan'),
    btnSelectAll: $('mbBtnSelectAll'),
    btnSelectNone: $('mbBtnSelectNone'),
    btnExpandAll: $('mbBtnExpandAll'),
    btnDownloadCsv: $('mbBtnDownloadCsv'),

    treeBox: $('mbTree'),
    summary: $('mbSummary'),

    btnSave: $('mbBtnSave'),
    btnEnable: $('mbBtnEnable'),
    btnDisable: $('mbBtnDisable'),
    saveHint: $('mbSaveHint'),
  };

  if (!el.btnOpen || !el.modal) return; // index.html 还没改完时安静退出

  // tree state
  var treeData = []; // [{zonesubno, zonesubname, groups:[{groupId, groupName, devices:[{deviceId, deviceName, params:[{paraName,unit}]}]}]}]
  var checkedKey = {};   // deviceId -> bool
  var deviceMeta = {};   // deviceId -> {deviceId, deviceName, groupId, groupName, zonesubno, zonesubname, params:[]}
  var statusTimer = null;

  function setHint(text, cls) {
    el.saveHint.textContent = text || '';
    el.saveHint.className = 'hint' + (cls ? ' ' + cls : '');
  }

  function setDot(state) {
    if (!el.modbusDot) return;
    el.modbusDot.classList.remove('on', 'off', 'warn', 'err');
    el.modbusDot.classList.add(state || 'off');
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

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function regsForDevice(d) { return 1 + 2 * ((d.params || []).length); }

  // ---- 配置读写 ----
  async function loadConfig() {
    try {
      var r = await fetch('/api/proto-conv/modbus/config').then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '读取失败');
      var c = r.config || {};
      el.cfgPort.value = c.port || 5020;
      el.cfgPoll.value = c.pollIntervalSec || 5;
      // 把已选设备塞进 deviceMeta 以便在没扫描时也能渲染勾中状态
      checkedKey = {};
      (c.selectedDevices || []).forEach(function (d) {
        deviceMeta[d.deviceId] = d;
        checkedKey[d.deviceId] = true;
      });
      // 如果之前没扫过树，至少把已选设备显示成扁平列表
      if (!treeData.length && (c.selectedDevices || []).length) {
        renderFlatSelected(c.selectedDevices);
      }
      updateSummary();
    } catch (err) {
      setHint('读取配置失败：' + err.message, 'err');
    }
  }

  function renderFlatSelected(list) {
    var html = '<div class="hint" style="margin-bottom:6px">已保存设备（点「扫描设备」可重新拉取最新结构）</div>';
    html += '<div class="mb-tree">';
    list.forEach(function (d) {
      html += '<div class="mb-tree-leaf"><label>' +
        '<input type="checkbox" data-mb-dev="' + escHtml(d.deviceId) + '" checked />' +
        '<span class="mb-dev-name">' + escHtml(d.deviceName) + '</span>' +
        '<span class="mb-dev-meta">(' + (d.params || []).length + ' 参数, ' + regsForDevice(d) + ' reg)</span>' +
        '<span class="mb-dev-path">' + escHtml(d.zonesubname || '') + ' / ' + escHtml(d.groupName || '') + '</span>' +
        '</label></div>';
    });
    html += '</div>';
    el.treeBox.innerHTML = html;
    bindTreeEvents();
  }

  // ---- 扫描设备 ----
  async function scanDevices() {
    el.btnScan.disabled = true;
    el.treeBox.innerHTML = '<div class="hint">扫描中…</div>';
    Mon.info('Modbus → 扫描设备开始');
    try {
      // 1. 区域
      var rArea = await invokePc('GetNewAllAreasKey', { UserLsh: '1' });
      var areas = ((rArea && rArea.data && rArea.data.data) || []);
      treeData = [];
      // 2. 每个区域取分组 + 每个分组取设备
      for (var i = 0; i < areas.length; i++) {
        var ar = areas[i];
        var gNode = { zonesubno: ar.Zonesubno, zonesubname: ar.Zonesubname, groups: [] };
        var rGrp = await invokePc('GetGroupByZonesubnoKey', {
          UserLsh: '1', serverCode: ar.ServerCode || '1', Zonesubno: ar.Zonesubno,
        });
        var groups = ((rGrp && rGrp.data && rGrp.data.data) || []);
        for (var j = 0; j < groups.length; j++) {
          var g = groups[j];
          var rDev = await invokePc('GetDeviceByGroupKey', { UserLsh: '1', GroupId: g.GroupId });
          var devs = ((rDev && rDev.data && rDev.data.data) || []);
          // dcim 后端 GroupId 是全局共享的（不同区域同名分组撞 GroupId），
          // 所以这里返回的可能是所有区域下该 GroupId 的设备，需按当前 Zonesubno 过滤
          devs = devs.filter(function (d) {
            return d && String(d.Zonesubno == null ? '' : d.Zonesubno) === String(ar.Zonesubno);
          });
          var devList = devs.map(function (d) {
            return {
              deviceId: String(d.DeviceId),
              deviceName: String(d.DeviceName || ''),
              groupId: String(g.GroupId),
              groupName: String(g.GroupName || ''),
              zonesubno: String(ar.Zonesubno),
              zonesubname: String(ar.Zonesubname || ''),
              params: (d.ParaList || []).map(function (p) {
                return { paraName: String(p.ParaName == null ? '' : p.ParaName), unit: String(p.Unit == null ? '' : p.Unit) };
              }),
            };
          });
          // 写入 deviceMeta
          devList.forEach(function (d) { deviceMeta[d.deviceId] = d; });
          gNode.groups.push({ groupId: String(g.GroupId), groupName: String(g.GroupName || ''), devices: devList });
        }
        treeData.push(gNode);
      }
      renderTree();
      Mon.info('Modbus → 扫描完成，' + areas.length + ' 区域');
    } catch (err) {
      el.treeBox.innerHTML = '<div class="hint err">扫描失败：' + escHtml(err.message) + '</div>';
      Mon.error('Modbus 扫描失败：' + err.message);
    } finally {
      el.btnScan.disabled = false;
    }
  }

  async function invokePc(key, body) {
    var r = await fetch('/api/proto-conv/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key, method: 'POST', body: body }),
    }).then(function (r) { return r.json(); });
    if (!r.ok) throw new Error(key + ' HTTP ' + r.status + ' ' + (r.message || ''));
    return r;
  }

  function renderTree() {
    if (!treeData.length) {
      el.treeBox.innerHTML = '<div class="hint">未扫描到任何区域。</div>';
      updateSummary();
      return;
    }
    var html = '<div class="mb-tree">';
    treeData.forEach(function (zn, zi) {
      var totalDev = zn.groups.reduce(function (a, g) { return a + g.devices.length; }, 0);
      html += '<div class="mb-zone" data-zi="' + zi + '">';
      html += '<div class="mb-zone-head" data-toggle="zone-' + zi + '">▼ ' + escHtml(zn.zonesubname || '区域 ' + zn.zonesubno) +
        ' <span class="mb-dev-meta">(' + zn.groups.length + ' 分组 · ' + totalDev + ' 设备)</span></div>';
      html += '<div class="mb-zone-body" id="zone-body-' + zi + '">';
      zn.groups.forEach(function (g, gi) {
        html += '<div class="mb-group" data-gi="' + gi + '">';
        html += '<div class="mb-group-head" data-toggle="grp-' + zi + '-' + gi + '">▼ ' + escHtml(g.groupName) +
          ' <span class="mb-dev-meta">(' + g.devices.length + ' 设备)</span></div>';
        html += '<div class="mb-group-body" id="grp-body-' + zi + '-' + gi + '">';
        if (!g.devices.length) {
          html += '<div class="mb-group-empty">（该分组无设备）</div>';
        } else {
          g.devices.forEach(function (d) {
            var checked = checkedKey[d.deviceId] ? ' checked' : '';
            html += '<div class="mb-tree-leaf"><label>' +
              '<input type="checkbox" data-mb-dev="' + escHtml(d.deviceId) + '"' + checked + ' />' +
              '<span class="mb-dev-name">' + escHtml(d.deviceName) + '</span>' +
              '<span class="mb-dev-meta">(' + d.params.length + ' 参数, ' + regsForDevice(d) + ' reg)</span>' +
              '</label></div>';
          });
        }
        html += '</div></div>';
      });
      html += '</div></div>';
    });
    html += '</div>';
    el.treeBox.innerHTML = html;
    bindTreeEvents();
    updateSummary();
  }

  function bindTreeEvents() {
    el.treeBox.querySelectorAll('[data-toggle]').forEach(function (n) {
      n.addEventListener('click', function () {
        var key = n.dataset.toggle;
        var bodyId;
        if (key.indexOf('zone-') === 0) bodyId = 'zone-body-' + key.slice(5);
        else if (key.indexOf('grp-') === 0) bodyId = 'grp-body-' + key.slice(4);
        var body = document.getElementById(bodyId);
        if (!body) return;
        var hidden = body.style.display === 'none';
        body.style.display = hidden ? '' : 'none';
        n.firstChild.nodeValue = (hidden ? '▼ ' : '▶ ') + (n.firstChild.nodeValue.replace(/^[▼▶]\s/, ''));
      });
    });
    el.treeBox.querySelectorAll('input[data-mb-dev]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        checkedKey[cb.dataset.mbDev] = cb.checked;
        updateSummary();
      });
    });
  }

  function getSelectedDevices() {
    return Object.keys(checkedKey)
      .filter(function (k) { return checkedKey[k] && deviceMeta[k]; })
      .map(function (k) { return deviceMeta[k]; });
  }

  function updateSummary() {
    var sel = getSelectedDevices();
    var totalReg = 0, totalParam = 0;
    sel.forEach(function (d) { totalParam += (d.params || []).length; totalReg += regsForDevice(d); });
    var msg = '已选: ' + sel.length + ' 设备 · ' + totalParam + ' 参数 · 总 ' + totalReg + ' 寄存器';
    if (totalReg > 60000) msg += '  ⚠ 超过 60000 上限，无法保存';
    el.summary.textContent = msg;
    el.summary.className = 'mb-summary' + (totalReg > 60000 ? ' err' : '');
    el.btnSave.disabled = (totalReg > 60000);
  }

  // ---- 状态刷新 ----
  async function refreshStatus() {
    try {
      var r = await fetch('/api/proto-conv/modbus/status').then(function (r) { return r.json(); });
      var s = r.status || {};
      var enabledTag = s.enabled ? '🟢 已启用（重启后自动恢复）' : '⚪ 已停用';
      var line = enabledTag + ' · ' +
        (s.running ? '运行中 监听 0.0.0.0:' + s.port : '未运行') +
        ' · ' + s.deviceCount + ' 设备 · ' + s.regCount + ' 寄存器' +
        (s.lastPollAt ? ' · 上次轮询 ' + s.lastPollAt : '');
      el.statusLine.textContent = line;
      el.errLine.textContent = s.lastError ? '最近错误: ' + s.lastError : '最近错误: (无)';
      el.errLine.className = s.lastError ? 'hint err' : 'hint';
      var miss = s.missingDevices || [];
      el.missingLine.textContent = miss.length ? ('⚠ ' + miss.length + ' 个已选设备未在最新接口返回: ' + miss.slice(0, 3).join(', ') + (miss.length > 3 ? '…' : '')) : '';
      el.missingLine.className = miss.length ? 'hint warn' : 'hint';
      setDot(s.lastError ? 'err' : (s.running ? 'on' : 'off'));
    } catch (err) {
      el.statusLine.textContent = '状态读取失败：' + err.message;
      setDot('err');
    }
  }

  // ---- 保存/启停 ----
  async function saveAndApply(enabledOverride) {
    var sel = getSelectedDevices();
    var port = Number(el.cfgPort.value) || 5020;
    var poll = Number(el.cfgPoll.value) || 5;
    if (port < 1 || port > 65535) { setHint('端口必须 1-65535', 'err'); return; }
    if (poll < 1 || poll > 60) { setHint('轮询周期必须 1-60 秒', 'err'); return; }
    var body = {
      port: port,
      pollIntervalSec: poll,
      selectedDevices: sel,
    };
    if (enabledOverride != null) body.enabled = !!enabledOverride;
    el.btnSave.disabled = true;
    setHint('保存中…');
    try {
      var r = await fetch('/api/proto-conv/modbus/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '保存失败');
      setHint('已保存', 'ok');
      Mon.info('Modbus → 配置已保存：' + sel.length + ' 设备 · port=' + port);
      refreshStatus();
    } catch (err) {
      setHint('保存失败：' + err.message, 'err');
      Mon.error('Modbus 保存失败：' + err.message);
    } finally {
      el.btnSave.disabled = false;
    }
  }

  async function doEnable() { await saveAndApply(true); }
  async function doDisable() {
    setHint('停用中…');
    try {
      await fetch('/api/proto-conv/modbus/stop', { method: 'POST' });
      setHint('已停用', 'ok');
      refreshStatus();
      Mon.info('Modbus → 已停用');
    } catch (err) {
      setHint('停用失败：' + err.message, 'err');
    }
  }

  // ---- 全选/反选/全展开 ----
  function selectAll() {
    treeData.forEach(function (zn) { zn.groups.forEach(function (g) { g.devices.forEach(function (d) { checkedKey[d.deviceId] = true; }); }); });
    el.treeBox.querySelectorAll('input[data-mb-dev]').forEach(function (cb) { cb.checked = true; });
    updateSummary();
  }
  function selectNone() {
    Object.keys(checkedKey).forEach(function (k) { checkedKey[k] = false; });
    el.treeBox.querySelectorAll('input[data-mb-dev]').forEach(function (cb) { cb.checked = false; });
    updateSummary();
  }
  function expandAll() {
    el.treeBox.querySelectorAll('.mb-zone-body, .mb-group-body').forEach(function (n) { n.style.display = ''; });
    el.treeBox.querySelectorAll('[data-toggle]').forEach(function (n) {
      n.firstChild.nodeValue = '▼ ' + (n.firstChild.nodeValue.replace(/^[▼▶]\s/, ''));
    });
  }

  // ---- 事件绑定 ----
  el.btnOpen.addEventListener('click', open);
  el.btnClose.addEventListener('click', close);
  el.modal.addEventListener('click', function (e) { if (e.target === el.modal) close(); });
  el.btnScan.addEventListener('click', scanDevices);
  el.btnSelectAll.addEventListener('click', selectAll);
  el.btnSelectNone.addEventListener('click', selectNone);
  el.btnExpandAll.addEventListener('click', expandAll);
  el.btnDownloadCsv.addEventListener('click', function () { window.open('/api/proto-conv/modbus/map.csv'); });
  el.btnSave.addEventListener('click', function () { saveAndApply(); });
  el.btnEnable.addEventListener('click', doEnable);
  el.btnDisable.addEventListener('click', doDisable);

  // 主面板首屏静默拉一次状态刷顶栏 LED
  refreshStatus();
  setInterval(refreshStatus, 5000);

  window.PcModbus = { open: open, refresh: refreshStatus };
})();
