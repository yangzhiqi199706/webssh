// 协议转换 → Modbus TCP 控制转换：UI 面板（顶栏按钮 + 弹窗 + 控制项多选树 + 触发记录）
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Mon = window.PcMonitor || { append: function () {}, info: function () {}, warn: function () {}, error: function () {} };
  var AreaUtils = window.PcAreaUtils;

  var el = {
    btnOpen: $('btnOpenModbusControl'),
    modbusCtrlDot: $('modbusCtrlDot'),
    modal: $('modbusControlModal'),
    btnClose: $('btnCloseModbusControl'),

    cfgDebounce: $('mbcCfgDebounce'),
    statusLine: $('mbcStatusLine'),
    errLine: $('mbcErrLine'),

    btnScan: $('mbcBtnScan'),
    btnSelectAll: $('mbcBtnSelectAll'),
    btnSelectNone: $('mbcBtnSelectNone'),
    btnExpandAll: $('mbcBtnExpandAll'),
    btnDownloadCsv: $('mbcBtnDownloadCsv'),

    treeBox: $('mbcTree'),
    summary: $('mbcSummary'),
    fireBox: $('mbcFireBox'),

    btnSave: $('mbcBtnSave'),
    btnEnable: $('mbcBtnEnable'),
    btnDisable: $('mbcBtnDisable'),
    saveHint: $('mbcSaveHint'),
  };
  if (!el.btnOpen || !el.modal) return;

  // tree state: 区域 → 分组 → 设备 → 控制项
  var treeData = [];
  var checkedKey = {};        // key = deviceId + '|' + controlId
  var commandMeta = {};       // key -> 命令元数据
  var statusTimer = null;
  var controlBaseAddr = 0;    // 控制段起始地址（=数据段总寄存器数），从 status 接口拿

  function setHint(text, cls) {
    el.saveHint.textContent = text || '';
    el.saveHint.className = 'hint' + (cls ? ' ' + cls : '');
  }
  function setDot(state) {
    if (!el.modbusCtrlDot) return;
    el.modbusCtrlDot.classList.remove('on', 'off', 'warn', 'err');
    el.modbusCtrlDot.classList.add(state || 'off');
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ckey(deviceId, controlId) { return String(deviceId) + '|' + String(controlId); }

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
      var r = await fetch('/api/proto-conv/modbus-control/config').then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '读取失败');
      var c = r.config || {};
      el.cfgDebounce.value = c.debounceSec == null ? 2 : c.debounceSec;
      checkedKey = {};
      (c.selectedCommands || []).forEach(function (d) {
        var k = ckey(d.deviceId, d.controlId);
        commandMeta[k] = d;
        checkedKey[k] = true;
      });
      // 拿控制段起始地址（来自 modbus 数据模块的 dataRegCount）
      if (r.status && typeof r.status.controlBaseAddr === 'number') {
        controlBaseAddr = r.status.controlBaseAddr;
      }
      if (!treeData.length && (c.selectedCommands || []).length) {
        renderFlatSelected(c.selectedCommands);
      }
      updateSummary();
    } catch (err) {
      setHint('读取配置失败：' + err.message, 'err');
    }
  }

  function renderFlatSelected(list) {
    var html = '<div class="hint" style="margin-bottom:6px">已保存命令（点「扫描控制命令」可重新拉取最新结构）</div>';
    html += '<div class="mb-tree">';
    list.forEach(function (d, i) {
      var k = ckey(d.deviceId, d.controlId);
      var realAddr = controlBaseAddr + i;
      html += '<div class="mb-tree-leaf"><label>' +
        '<input type="checkbox" data-mbc-cmd="' + escHtml(k) + '" checked />' +
        '<span class="mb-dev-name">' + escHtml(d.commandName || '(命令)') + '</span>' +
        '<span class="mb-dev-meta">controlId=' + escHtml(d.controlId) + ' → Reg[' + realAddr + ']</span>' +
        '<span class="mb-dev-path">' + escHtml(d.zonesubname || '') + ' / ' + escHtml(d.groupName || '') + ' / ' + escHtml(d.deviceName || '') + '</span>' +
        '</label></div>';
    });
    html += '</div>';
    el.treeBox.innerHTML = html;
    bindTreeEvents();
  }

  // ---- 扫描控制命令 ----
  async function scanCommands() {
    el.btnScan.disabled = true;
    el.treeBox.innerHTML = '<div class="hint">扫描中…（区域 → 分组 → 设备 → GetDeviceControlKey）</div>';
    Mon.info('Modbus 控制 → 扫描开始');
    // 切换 dcim 连接后旧 controlId 在新 dcim 不存在 → 重置 commandMeta，
    // 仅保留扫描后实际存在的控制项的勾选状态。
    var oldChecked = Object.assign({}, checkedKey);
    commandMeta = {};
    checkedKey = {};
    try {
      // 新方案：以分组为主、不依赖 GetNewAllAreasKey 的区域列表完整性
      var areaMap = {};
      try {
        var rDb = await fetch('/api/proto-conv/area-map').then(function (r) { return r.json(); });
        if (rDb && rDb.ok && rDb.map) {
          Object.keys(rDb.map).forEach(function (k) { areaMap[k] = rDb.map[k]; });
          if (rDb.source === 'db') Mon.info('Modbus 控制 → 区域名从 dcim-area 表拿到 ' + rDb.count + ' 个');
        }
      } catch (_e) {}
      var rArea = await invokePc('GetNewAllAreasKey', { UserLsh: '' });
      AreaUtils.mergeAreaRecords(areaMap, rArea && rArea.data && rArea.data.data);
      var ZONE_MAX = 30, EMPTY_STOP = 5;
      var groupMap = {};
      var emptyStreak = 0;
      el.treeBox.innerHTML = '<div class="hint">扫描中…正在穷举区域（1/' + ZONE_MAX + '）</div>';
      for (var z = 1; z <= ZONE_MAX; z++) {
        if ((z % 5) === 0) {
          el.treeBox.innerHTML = '<div class="hint">扫描中…穷举区域 ' + z + '/' + ZONE_MAX + '</div>';
        }
        var rG = await invokePc('GetGroupByZonesubnoKey', {
          UserLsh: '', serverCode: '1', Zonesubno: String(z),
        });
        var gs = AreaUtils.normalizeRecords(rG && rG.data && rG.data.data);
        if (gs.length === 0) {
          emptyStreak += 1;
          if (emptyStreak >= EMPTY_STOP) break;
          continue;
        }
        emptyStreak = 0;
        gs.forEach(function (g) {
          var gid = String(g.GroupId);
          if (!groupMap[gid]) groupMap[gid] = { GroupId: gid, GroupName: String(g.GroupName || '') };
        });
      }
      var groupList = Object.keys(groupMap).map(function (k) { return groupMap[k]; });
      if (groupList.length === 0) throw new Error('穷举 Zonesubno=1..' + ZONE_MAX + ' 没拿到任何分组');

      treeData = [];
      var zoneNodes = {};
      function getZoneNode(zno) {
        var k = String(zno == null ? '' : zno);
        if (!zoneNodes[k]) {
          zoneNodes[k] = {
            zonesubno: k,
            zonesubname: areaMap[k] || ('未知区域 (Zonesubno=' + k + ')'),
            groups: {},
          };
        }
        return zoneNodes[k];
      }
      function getGroupNode(zoneNode, gid, gname) {
        var k = String(gid);
        if (!zoneNode.groups[k]) {
          zoneNode.groups[k] = { groupId: k, groupName: String(gname || ''), devices: [] };
        }
        return zoneNode.groups[k];
      }

      var totalDevs = 0, totalCmds = 0;
      for (var j = 0; j < groupList.length; j++) {
        var g = groupList[j];
        var rDev = await invokePc('GetDeviceByGroupKey', { UserLsh: '', GroupId: g.GroupId });
        var devs = AreaUtils.normalizeRecords(rDev && rDev.data && rDev.data.data);
        for (var k = 0; k < devs.length; k++) {
          var dev = devs[k];
          if (!AreaUtils.belongsToGroup(dev, g.GroupId)) continue;
          var deviceId = AreaUtils.getDeviceId(dev);
          if (!deviceId) continue;
          var rCtrl = await invokePc('GetDeviceControlKey', { UserLsh: '', DeviceId: deviceId });
          var ctrls = AreaUtils.normalizeRecords(rCtrl && rCtrl.data && rCtrl.data.data);
          var zoneNo = AreaUtils.getZoneNo(dev);
          var zNode = getZoneNode(zoneNo);
          var grpNode = getGroupNode(zNode, g.GroupId, g.GroupName);
          var cmdList = ctrls.map(function (c) {
            return {
              deviceId: deviceId, deviceName: String(dev.DeviceName || ''),
              controlId: AreaUtils.getControlId(c),
              commandName: AreaUtils.getControlName(c),
              groupId: String(g.GroupId), groupName: String(g.GroupName || ''),
              zonesubno: zoneNo,
              zonesubname: zNode.zonesubname,
            };
          }).filter(function (c) { return c.controlId; });
          cmdList.forEach(function (c) { commandMeta[ckey(c.deviceId, c.controlId)] = c; });
          totalCmds += cmdList.length;
          grpNode.devices.push({
            deviceId: String(dev.DeviceId),
            deviceName: String(dev.DeviceName || ''),
            commands: cmdList,
          });
          totalDevs += 1;
        }
      }

      var zoneKeys = Object.keys(zoneNodes).sort(function (a, b) {
        var na = parseInt(a, 10), nb = parseInt(b, 10);
        if (isNaN(na) || isNaN(nb)) return a < b ? -1 : (a > b ? 1 : 0);
        return na - nb;
      });
      zoneKeys.forEach(function (zk) {
        var zn = zoneNodes[zk];
        var groupsArr = Object.keys(zn.groups).map(function (gk) { return zn.groups[gk]; });
        treeData.push({
          zonesubno: zn.zonesubno,
          zonesubname: zn.zonesubname,
          groups: groupsArr,
        });
      });

      // 仅恢复扫描后仍存在的控制项的勾选；旧 dcim 的孤儿命令自动丢弃
      var droppedCount = 0;
      Object.keys(oldChecked).forEach(function (k) {
        if (oldChecked[k]) {
          if (commandMeta[k]) checkedKey[k] = true;
          else droppedCount += 1;
        }
      });
      renderTree();
      var hint = '扫描完成，' + treeData.length + ' 区域，' + groupList.length + ' 分组，' + totalDevs + ' 设备，' + totalCmds + ' 控制项';
      if (droppedCount > 0) hint += '；丢弃 ' + droppedCount + ' 个旧 dcim 孤儿命令';
      Mon.info('Modbus 控制 → ' + hint);
    } catch (err) {
      el.treeBox.innerHTML = '<div class="hint err">扫描失败：' + escHtml(err.message) + '</div>';
      Mon.error('Modbus 控制扫描失败：' + err.message);
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
      var totalCmds = 0, totalDev = 0;
      zn.groups.forEach(function (g) {
        totalDev += g.devices.length;
        g.devices.forEach(function (d) { totalCmds += d.commands.length; });
      });
      if (totalCmds === 0) return; // 该区域无任何控制项，不渲染
      html += '<div class="mb-zone" data-zi="' + zi + '">';
      html += '<div class="mb-zone-head" data-toggle="zone-c-' + zi + '">▼ ' + escHtml(zn.zonesubname || '区域 ' + zn.zonesubno) +
        ' <span class="mb-dev-meta">(' + totalDev + ' 设备, ' + totalCmds + ' 控制项)</span></div>';
      html += '<div class="mb-zone-body" id="zone-c-body-' + zi + '">';
      zn.groups.forEach(function (g, gi) {
        var grpCmds = g.devices.reduce(function (a, d) { return a + d.commands.length; }, 0);
        if (grpCmds === 0) return;
        html += '<div class="mb-group" data-gi="' + gi + '">';
        html += '<div class="mb-group-head" data-toggle="grp-c-' + zi + '-' + gi + '">▼ ' + escHtml(g.groupName) +
          ' <span class="mb-dev-meta">(' + grpCmds + ' 控制项)</span></div>';
        html += '<div class="mb-group-body" id="grp-c-body-' + zi + '-' + gi + '">';
        g.devices.forEach(function (d) {
          if (!d.commands.length) return;
          html += '<div class="mb-tree-leaf" style="font-weight:600;color:#cbd5e1">📟 ' + escHtml(d.deviceName) + '</div>';
          d.commands.forEach(function (c) {
            var keyStr = ckey(c.deviceId, c.controlId);
            var checked = checkedKey[keyStr] ? ' checked' : '';
            html += '<div class="mb-tree-leaf" style="padding-left:18px"><label>' +
              '<input type="checkbox" data-mbc-cmd="' + escHtml(keyStr) + '"' + checked + ' />' +
              '<span class="mb-dev-name">' + escHtml(c.commandName) + '</span>' +
              '<span class="mb-dev-meta">controlId=' + escHtml(c.controlId) + '</span>' +
              '</label></div>';
          });
        });
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
        if (key.indexOf('zone-c-') === 0) bodyId = 'zone-c-body-' + key.slice(7);
        else if (key.indexOf('grp-c-') === 0) bodyId = 'grp-c-body-' + key.slice(6);
        var body = document.getElementById(bodyId);
        if (!body) return;
        var hidden = body.style.display === 'none';
        body.style.display = hidden ? '' : 'none';
        n.firstChild.nodeValue = (hidden ? '▼ ' : '▶ ') + (n.firstChild.nodeValue.replace(/^[▼▶]\s/, ''));
      });
    });
    el.treeBox.querySelectorAll('input[data-mbc-cmd]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        checkedKey[cb.dataset.mbcCmd] = cb.checked;
        updateSummary();
      });
    });
  }

  function getSelected() {
    return Object.keys(checkedKey)
      .filter(function (k) { return checkedKey[k] && commandMeta[k]; })
      .map(function (k) { return commandMeta[k]; });
  }

  function updateSummary() {
    var sel = getSelected();
    var msg;
    if (sel.length === 0) {
      msg = '已选: 0 命令';
    } else {
      var startAddr = controlBaseAddr;
      var endAddr = controlBaseAddr + sel.length - 1;
      msg = '已选: ' + sel.length + ' 命令 · 寄存器 ' + startAddr + '–' + endAddr +
        '（控制段起始地址 ' + startAddr + ' = 数据段总寄存器数）';
    }
    el.summary.textContent = msg;
    el.summary.className = 'mb-summary';
  }

  // ---- 状态刷新 ----
  async function refreshStatus() {
    try {
      var r = await fetch('/api/proto-conv/modbus-control/status').then(function (r) { return r.json(); });
      var s = r.status || {};
      if (typeof s.controlBaseAddr === 'number') controlBaseAddr = s.controlBaseAddr;
      var enabledTag = s.enabled ? '🟢 已启用（重启后自动恢复）' : '⚪ 已停用';
      var line = enabledTag + ' · ' +
        (s.running ? '共用 5020（监听 0.0.0.0:' + s.port + '）' : '主 server 未运行') +
        ' · ' + (s.commandCount || 0) + ' 命令' +
        ' · 控制段起始 Reg[' + (s.controlBaseAddr || 0) + ']' +
        ' · 触发 ' + (s.totalFires || 0) + ' 次' +
        (s.debouncedCount ? '（去重 ' + s.debouncedCount + '）' : '') +
        (s.lastFireAt ? ' · 上次 ' + s.lastFireAt : '');
      el.statusLine.textContent = line;
      el.errLine.textContent = s.lastError ? '最近错误: ' + s.lastError : '最近错误: (无)';
      el.errLine.className = s.lastError ? 'hint err' : 'hint';
      setDot(s.lastError ? 'err' : (s.running && s.enabled ? 'on' : 'off'));
      updateSummary();
      // 触发记录列表
      var fires = r.recentFires || [];
      if (fires.length) {
        var html = '<div class="hint" style="margin-bottom:4px">最近 ' + Math.min(fires.length, 10) + ' 次触发：</div>';
        fires.slice(0, 10).forEach(function (f) {
          var icon = f.ok ? '✓' : '✗';
          var cls = f.ok ? 'ok' : 'err';
          html += '<div class="hint ' + cls + '" style="font-family:ui-monospace,monospace;font-size:11px">' +
            '[' + escHtml(f.ts) + '] addr=' + f.addr + ' → ' + escHtml(f.commandName || f.deviceName) +
            ' (controlId=' + escHtml(f.controlId) + ') ' + icon +
            (f.message ? ' ' + escHtml(String(f.message).slice(0, 80)) : '') +
            '</div>';
        });
        el.fireBox.innerHTML = html;
      } else {
        el.fireBox.innerHTML = '<div class="hint">尚无触发记录</div>';
      }
    } catch (err) {
      el.statusLine.textContent = '状态读取失败：' + err.message;
      setDot('err');
    }
  }

  // ---- 保存 / 启停 ----
  async function saveAndApply(enabledOverride) {
    var sel = getSelected();
    var debounce = Number(el.cfgDebounce.value);
    if (isNaN(debounce)) debounce = 2;
    if (debounce < 0 || debounce > 60) { setHint('去重秒数必须 0-60', 'err'); return; }
    var body = { debounceSec: debounce, selectedCommands: sel };
    if (enabledOverride != null) body.enabled = !!enabledOverride;
    el.btnSave.disabled = true;
    setHint('保存中…');
    try {
      var r = await fetch('/api/proto-conv/modbus-control/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '保存失败');
      setHint('已保存', 'ok');
      Mon.info('Modbus 控制 → 配置已保存：' + sel.length + ' 命令');
      refreshStatus();
    } catch (err) {
      setHint('保存失败：' + err.message, 'err');
      Mon.error('Modbus 控制保存失败：' + err.message);
    } finally {
      el.btnSave.disabled = false;
    }
  }
  async function doEnable() { await saveAndApply(true); }
  async function doDisable() {
    setHint('停用中…');
    try {
      await fetch('/api/proto-conv/modbus-control/stop', { method: 'POST' });
      setHint('已停用', 'ok');
      refreshStatus();
      Mon.info('Modbus 控制 → 已停用');
    } catch (err) {
      setHint('停用失败：' + err.message, 'err');
    }
  }

  // ---- 全选 / 清空 / 全展开 ----
  function selectAll() {
    treeData.forEach(function (zn) { zn.groups.forEach(function (g) { g.devices.forEach(function (d) {
      d.commands.forEach(function (c) { checkedKey[ckey(c.deviceId, c.controlId)] = true; });
    }); }); });
    el.treeBox.querySelectorAll('input[data-mbc-cmd]').forEach(function (cb) { cb.checked = true; });
    updateSummary();
  }
  function selectNone() {
    Object.keys(checkedKey).forEach(function (k) { checkedKey[k] = false; });
    el.treeBox.querySelectorAll('input[data-mbc-cmd]').forEach(function (cb) { cb.checked = false; });
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
  el.btnScan.addEventListener('click', scanCommands);
  el.btnSelectAll.addEventListener('click', selectAll);
  el.btnSelectNone.addEventListener('click', selectNone);
  el.btnExpandAll.addEventListener('click', expandAll);
  el.btnDownloadCsv.addEventListener('click', function () { window.open('/api/proto-conv/modbus-control/map.csv'); });
  el.btnSave.addEventListener('click', function () { saveAndApply(); });
  el.btnEnable.addEventListener('click', doEnable);
  el.btnDisable.addEventListener('click', doDisable);

  // 主面板首屏拉一次状态刷顶栏 LED
  refreshStatus();
  setInterval(refreshStatus, 5000);

  window.PcModbusControl = { open: open, refresh: refreshStatus };
})();
