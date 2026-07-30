// 协议转换 → Modbus TCP 转发：UI 面板（顶栏按钮 + 弹窗 + 设备多选树 + 状态条）
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Mon = window.PcMonitor || { append: function () {}, info: function () {}, warn: function () {}, error: function () {} };
  var AreaUtils = window.PcAreaUtils;

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
    // 切换 dcim 连接后旧设备 ID 可能在新 dcim 不存在 → 重置 deviceMeta，
    // 仅保留扫描完后实际存在的设备的勾选状态。
    var oldChecked = Object.assign({}, checkedKey);
    deviceMeta = {};
    checkedKey = {};
    try {
      // 新方案：以分组为主、不依赖 GetNewAllAreasKey 的区域列表完整性
      // 1) 取一份 areaMap (Zonesubno -> Zonesubname)，仅用作展示标签
      //    优先从 dcim 数据库直查（dcim-area 表）；接口 GetNewAllAreasKey 作兜底
      var areaMap = {};
      try {
        var rDb = await fetch('/api/proto-conv/area-map').then(function (r) { return r.json(); });
        if (rDb && rDb.ok && rDb.map) {
          Object.keys(rDb.map).forEach(function (k) { areaMap[k] = rDb.map[k]; });
          if (rDb.source === 'db') Mon.info('Modbus → 区域名从 dcim-area 表拿到 ' + rDb.count + ' 个');
        }
      } catch (_e) {}
      var rArea = await invokePc('GetNewAllAreasKey', { UserLsh: '' });
      AreaUtils.mergeAreaRecords(areaMap, rArea && rArea.data && rArea.data.data);
      // 2) 穷举 Zonesubno=1..30 拿所有分组（dcim GetNewAllAreasKey 不可靠 + GroupId 分布在不同 zone，必须穷举）
      var ZONE_MAX = 30, EMPTY_STOP = 5;
      var groupMap = {}; // GroupId -> {GroupId, GroupName}
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

      // 3) 每个分组拉一次设备（不再按区域过滤），按设备的 Zonesubno 自然分组
      treeData = [];
      var zoneNodes = {}; // Zonesubno -> { zonesubno, zonesubname, groups: { groupId -> {groupId, groupName, devices:[]} } }
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

      for (var j = 0; j < groupList.length; j++) {
        var g = groupList[j];
        var rDev = await invokePc('GetDeviceByGroupKey', { UserLsh: '', GroupId: g.GroupId });
        var devs = AreaUtils.normalizeRecords(rDev && rDev.data && rDev.data.data);
        for (var k = 0; k < devs.length; k++) {
          var d = devs[k];
          if (!AreaUtils.belongsToGroup(d, g.GroupId)) continue;
          var deviceId = AreaUtils.getDeviceId(d);
          if (!deviceId) continue;
          var params = AreaUtils.normalizeRecords(d.ParaList);
          if (!params.length) {
            try {
              var rParas = await invokePc('GetDeviceParasKey', {
                UserLsh: '', DeviceId: deviceId, serverCode: '1',
              });
              params = AreaUtils.normalizeRecords(rParas && rParas.data && rParas.data.data);
            } catch (paramErr) {
              Mon.warn('Modbus → 设备 ' + deviceId + ' 参数读取失败：' + paramErr.message);
            }
          }
          var zNode = getZoneNode(AreaUtils.getZoneNo(d));
          var grpNode = getGroupNode(zNode, g.GroupId, g.GroupName);
          var dev = {
            deviceId: deviceId,
            deviceName: String(d.DeviceName || ''),
            groupId: String(g.GroupId),
            groupName: String(g.GroupName || ''),
            zonesubno: AreaUtils.getZoneNo(d),
            zonesubname: zNode.zonesubname,
            params: params.map(function (p) {
              return {
                paraName: String(p.ParaName == null ? '' : p.ParaName),
                unit: String(p.Unit == null ? '' : p.Unit),
                dataType: String(p.DataType == null ? '' : p.DataType),
              };
            }),
          };
          grpNode.devices.push(dev);
          deviceMeta[dev.deviceId] = dev;
        }
      }

      // 4) zoneNodes (Map) → treeData (Array)，按 Zonesubno 数字排序
      var zoneKeys = Object.keys(zoneNodes).sort(function (a, b) {
        var na = parseInt(a, 10), nb = parseInt(b, 10);
        if (isNaN(na) || isNaN(nb)) return a < b ? -1 : (a > b ? 1 : 0);
        return na - nb;
      });
      zoneKeys.forEach(function (k) {
        var zn = zoneNodes[k];
        var groupsArr = Object.keys(zn.groups).map(function (gk) { return zn.groups[gk]; });
        treeData.push({
          zonesubno: zn.zonesubno,
          zonesubname: zn.zonesubname,
          groups: groupsArr,
        });
      });

      // 5) 仅恢复那些"扫描后仍存在"的设备的勾选状态；旧 dcim 的孤儿设备被自动丢弃
      var droppedCount = 0;
      Object.keys(oldChecked).forEach(function (k) {
        if (oldChecked[k]) {
          if (deviceMeta[k]) checkedKey[k] = true;
          else droppedCount += 1;
        }
      });
      renderTree();
      var totalDevs = Object.keys(deviceMeta).length;
      var hint = '扫描完成，' + treeData.length + ' 区域，' + groupList.length + ' 分组，' + totalDevs + ' 设备';
      if (droppedCount > 0) hint += '；丢弃 ' + droppedCount + ' 个旧 dcim 孤儿设备';
      Mon.info('Modbus → ' + hint);
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
    if (totalReg > 59000) msg += '  ⚠ 超过 59000 上限（控制段固定从 60000 起），无法保存';
    el.summary.textContent = msg;
    el.summary.className = 'mb-summary' + (totalReg > 59000 ? ' err' : '');
    el.btnSave.disabled = (totalReg > 59000);
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
