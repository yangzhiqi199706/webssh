(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    monDot: $('monDot'),
    monState: $('monState'),
    monEnabled: $('monEnabled'),
    monInterval: $('monInterval'),
    monBuffer: $('monBuffer'),
    btnMonSave: $('btnMonSave'),
    btnMonClear: $('btnMonClear'),
    monSaveHint: $('monSaveHint'),
    monMetaBox: $('monMetaBox'),
    monList: $('monList'),
    monListEmpty: $('monListEmpty'),
    btnClearAlarmList: $('btnClearAlarmList'),
    cancelDot: $('cancelDot'),
    cancelState: $('cancelState'),
    cancelList: $('cancelList'),
    cancelListEmpty: $('cancelListEmpty'),
    monModal: $('monModal'),
    btnOpenMon: $('btnOpenMonModal'),
    btnCloseMon: $('btnCloseMonModal'),
  };

  var cfgLoaded = false;
  var lastClientId = 0;
  var lastCancelClientId = 0;
  var renderedClientIds = new Set();
  var renderedCancelIds = new Set();
  // 已被解除的告警 id（行级 id，对应 dcim-alarmlist.id）。
  // 解除事件一到，这些 id 不能再出现在"新告警"列表里：
  //   1) 如果"新告警"列表里已经渲染过同 id 的行，删掉它
  //   2) 之后任何渲染流程要画该 id 的新告警也直接跳过
  var cancelledRowIds = new Set();

  function openMonModal() {
    if (!el.monModal) return;
    el.monModal.classList.add('open');
    el.monModal.setAttribute('aria-hidden', 'false');
  }
  function closeMonModal() {
    if (!el.monModal) return;
    el.monModal.classList.remove('open');
    el.monModal.setAttribute('aria-hidden', 'true');
  }
  el.btnOpenMon && el.btnOpenMon.addEventListener('click', openMonModal);
  el.btnCloseMon && el.btnCloseMon.addEventListener('click', closeMonModal);
  el.monModal && el.monModal.addEventListener('click', function (e) {
    if (e.target === el.monModal) closeMonModal();
  });

  function hint(text, color) {
    el.monSaveHint.textContent = text || '';
    el.monSaveHint.style.color = color || '#94a3b8';
    if (text) setTimeout(function () {
      if (el.monSaveHint.textContent === text) el.monSaveHint.textContent = '';
    }, 2500);
  }

  function renderState(s) {
    el.monDot.classList.remove('on', 'off', 'err');
    if (el.cancelDot) el.cancelDot.classList.remove('on', 'off', 'err');
    if (!s.dbConnected) {
      el.monDot.classList.add('err');
      el.monState.textContent = '数据库未连接';
      if (el.cancelDot) el.cancelDot.classList.add('err');
      if (el.cancelState) el.cancelState.textContent = '数据库未连接';
    } else if (!s.enabled) {
      el.monDot.classList.add('off');
      el.monState.textContent = '已关闭';
      if (el.cancelDot) el.cancelDot.classList.add('off');
      if (el.cancelState) el.cancelState.textContent = '已关闭';
    } else if (s.lastError) {
      el.monDot.classList.add('err');
      el.monState.textContent = '异常：' + s.lastError;
      if (el.cancelDot) el.cancelDot.classList.add('err');
      if (el.cancelState) el.cancelState.textContent = '异常：' + s.lastError;
    } else {
      el.monDot.classList.add('on');
      el.monState.textContent = '监测中 · 每 ' + s.intervalSec + ' 秒';
      if (el.cancelDot) el.cancelDot.classList.add('on');
      if (el.cancelState) el.cancelState.textContent = '解除 ' + (s.totalCancelled || 0) + ' 条  ·  缓冲 ' + (s.cancelBufferCount || 0);
    }
    var lines = [];
    lines.push('表：`' + s.table + '`');
    lines.push('最后 id：' + s.lastSeenId + '  ·  新增 ' + s.totalFetched + '  ·  缓冲 ' + s.bufferCount + '/' + s.bufferSize);
    lines.push('等待 TextMessage 填充：' + (s.pendingCount || 0) + ' 条');
    lines.push('解除总计：' + (s.totalCancelled || 0) + '  ·  解除缓冲 ' + (s.cancelBufferCount || 0));
    if (s.lastPollAt) lines.push('上次轮询：' + s.lastPollAt);
    if (s.lastError) lines.push('错误：' + s.lastError);
    if (el.monMetaBox) el.monMetaBox.textContent = lines.join('\n');
  }

  function fillConfigOnce(s) {
    if (cfgLoaded) return;
    cfgLoaded = true;
    el.monEnabled.value = s.enabled ? '1' : '0';
    el.monInterval.value = String(s.intervalSec);
    el.monBuffer.value = String(s.bufferSize);
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  // dcim-alarmlist 表的字段显示顺序（主展开顺序），其余未知列兜底展示
  var FIELD_ORDER = [
    'id', 'AlarmLevel', 'AlarmType', 'AlarmStatus', 'AlarmCount',
    'DevId', 'DevClass', 'OrderNumber',
    'TextMessage', 'ParamValue',
    'NotifyModeID', 'NotifyMode', 'NotifyState', 'NotifyCount', 'LastNotifyTime',
    'ConfirmUserId', 'ConfirmTime', 'Solution',
    'CancelTime', 'CancelDesc',
    'VideoImg', 'VideoMP4',
    'create_time', 'update_time', 'status',
  ];

  function fmtLocal(d) {
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function formatValue(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      return fmtLocal(v);
    }
    if (typeof v === 'string') {
      // 已经是 ISO 带 Z 的字符串（mysql2 可能以 UTC 反序列化为字符串）转成本地
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
        var parsed = new Date(v);
        if (!isNaN(parsed.getTime())) return fmtLocal(parsed);
      }
      return v;
    }
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  // 大小写不敏感取字段：同一张表里 MySQL 可能以不同大小写返回列名
  function pick(row, name) {
    if (row == null) return undefined;
    if (name in row) return row[name];
    var lower = String(name).toLowerCase();
    for (var k in row) {
      if (Object.prototype.hasOwnProperty.call(row, k) && k.toLowerCase() === lower) {
        return row[k];
      }
    }
    return undefined;
  }

  var LEVEL_MAP = {
    1: { text: '一般', cls: 'lv-1' },
    2: { text: '次要', cls: 'lv-2' },
    3: { text: '主要', cls: 'lv-3' },
    4: { text: '严重', cls: 'lv-4' },
    5: { text: '紧急', cls: 'lv-5' },
  };
  function levelInfo(level) {
    var n = Number(level);
    return LEVEL_MAP[n] || { text: level == null ? '-' : String(level), cls: '' };
  }
  function levelClass(level) {
    return levelInfo(level).cls;
  }

  function buildDetailHtml(row) {
    var pairs = [];
    var seen = {};
    FIELD_ORDER.forEach(function (k) {
      if (!(k in row)) return;
      seen[k] = 1;
      pairs.push([k, row[k]]);
    });
    Object.keys(row).forEach(function (k) {
      if (seen[k]) return;
      pairs.push([k, row[k]]);
    });
    var inner = pairs.map(function (p) {
      var key = p[0];
      var raw = p[1];
      var val = formatValue(raw);
      if (val == null) return '<div class="detail-item"><span class="k">' + esc(key) + '</span><span class="v null">—</span></div>';
      if (key === 'AlarmLevel') {
        var li = levelInfo(raw);
        val = val + ' (' + li.text + ')';
      }
      return '<div class="detail-item"><span class="k">' + esc(key) + '</span><span class="v">' + esc(val) + '</span></div>';
    }).join('');
    return '<div class="detail-list">' + inner + '</div>';
  }

  var detailModal = $('detailModal');
  var detailTitle = $('detailModalTitle');
  var detailBody = $('detailModalBody');
  var btnCloseDetail = $('btnCloseDetailModal');
  function openDetailModal(row, cancelled) {
    if (!detailModal) return;
    var id = pick(row, 'id');
    var li = levelInfo(pick(row, 'AlarmLevel'));
    detailTitle.textContent = (cancelled ? '告警解除详情' : '告警详情') + ' · #' + (id == null ? '-' : id) + ' · ' + li.text;
    detailBody.innerHTML = buildDetailHtml(row);
    detailModal.classList.add('open');
    detailModal.setAttribute('aria-hidden', 'false');
  }
  function closeDetailModal() {
    if (!detailModal) return;
    detailModal.classList.remove('open');
    detailModal.setAttribute('aria-hidden', 'true');
  }
  btnCloseDetail && btnCloseDetail.addEventListener('click', closeDetailModal);
  detailModal && detailModal.addEventListener('click', function (e) {
    if (e.target === detailModal) closeDetailModal();
  });

  function renderItems(opts) {
    // opts: { items, listEl, emptyEl, seenSet, timeField, cancelled }
    var items = opts.items || [];
    if (!items.length) return;
    if (opts.emptyEl && opts.emptyEl.parentNode === opts.listEl) {
      opts.listEl.removeChild(opts.emptyEl);
    }
    var header = opts.listEl.querySelector('.alarm-head');
    var frag = document.createDocumentFragment();
    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      if (opts.seenSet.has(it.clientId)) continue;
      var row = it.row || {};
      var rowId = pick(row, 'id');
      // 新告警分支：如果该 id 已经被解除过，直接跳过，不渲染
      if (!opts.cancelled && rowId != null && cancelledRowIds.has(String(rowId))) {
        opts.seenSet.add(it.clientId);
        continue;
      }
      opts.seenSet.add(it.clientId);
      var div = document.createElement('div');
      div.className = 'alarm-row new' + (opts.cancelled ? ' cancelled' : '');
      div.dataset.clientId = it.clientId;
      if (rowId != null) div.dataset.rowId = String(rowId);
      var text = formatValue(pick(row, 'TextMessage'));
      if (!text) {
        // TextMessage 为 null 时用其它字段拼个描述，方便用户一眼识别
        var parts = [];
        var devId = formatValue(pick(row, 'DevId'));
        var devClass = formatValue(pick(row, 'DevClass'));
        var paramVal = formatValue(pick(row, 'ParamValue'));
        var alarmType = formatValue(pick(row, 'AlarmType'));
        if (devId != null) parts.push('Dev=' + devId);
        if (devClass != null) parts.push('Class=' + devClass);
        if (alarmType != null) parts.push('Type=' + alarmType);
        if (paramVal != null) parts.push('Value=' + paramVal);
        text = parts.length ? '(TextMessage 为空) ' + parts.join(' · ') : '(无内容)';
      }
      var ts = formatValue(pick(row, opts.timeField))
        || formatValue(pick(row, 'create_time'))
        || '';
      var level = formatValue(pick(row, 'AlarmLevel'));
      var li = levelInfo(level);
      div.innerHTML =
        '<span class="alarm-id">#' + esc(pick(row, 'id')) + '</span>' +
        '<span class="alarm-level ' + li.cls + '">' + esc(li.text) + '</span>' +
        '<span class="alarm-text">' + esc(text) + '</span>' +
        '<span class="alarm-time" title="' + esc(ts) + '">' + esc(ts) + '</span>';
      (function (capturedRow, capturedCancelled) {
        div.addEventListener('click', function () {
          openDetailModal(capturedRow, capturedCancelled);
        });
      })(row, !!opts.cancelled);
      frag.insertBefore(div, frag.firstChild);
    }
    if (header && header.nextSibling) {
      opts.listEl.insertBefore(frag, header.nextSibling);
    } else if (header) {
      opts.listEl.appendChild(frag);
    } else {
      opts.listEl.insertBefore(frag, opts.listEl.firstChild);
    }
    var rows = opts.listEl.querySelectorAll('.alarm-row');
    if (rows.length > 300) {
      for (var j = 300; j < rows.length; j++) rows[j].remove();
    }
  }

  function renderNewItems(items) {
    renderItems({
      items: items,
      listEl: el.monList,
      emptyEl: el.monListEmpty,
      seenSet: renderedClientIds,
      timeField: 'create_time',
      cancelled: false,
    });
  }

  function renderCancelItems(items) {
    // 1) 把每条解除项的行级 id 加入 cancelledRowIds
    // 2) 从"新告警"DOM 里删掉同 id 的行（如果之前已渲染过）
    if (items && items.length) {
      for (var k = 0; k < items.length; k++) {
        var rid = items[k] && items[k].row ? pick(items[k].row, 'id') : null;
        if (rid == null) continue;
        var key = String(rid);
        cancelledRowIds.add(key);
        if (el.monList) {
          var dup = el.monList.querySelector('.alarm-row[data-row-id="' + key.replace(/"/g, '\\"') + '"]');
          if (dup && dup.parentNode) dup.parentNode.removeChild(dup);
        }
      }
      // 删完同 id 行后，如果"新告警"区只剩 header，再补一个 empty 占位
      if (el.monList && !el.monList.querySelector('.alarm-row')) {
        if (!el.monList.querySelector('#monListEmpty')) {
          var emptyDiv = document.createElement('div');
          emptyDiv.id = 'monListEmpty';
          emptyDiv.style.cssText = 'padding:14px;color:#64748b;font-size:12px;text-align:center';
          emptyDiv.textContent = '暂无新告警';
          el.monList.appendChild(emptyDiv);
          el.monListEmpty = emptyDiv;
        }
      }
    }
    renderItems({
      items: items,
      listEl: el.cancelList,
      emptyEl: el.cancelListEmpty,
      seenSet: renderedCancelIds,
      timeField: 'CancelTime',
      cancelled: true,
    });
  }

  async function loadConfig() {
    try {
      var resp = await fetch('/api/sms/monitor/config');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      fillConfigOnce(data);
      renderState(data);
    } catch (err) {
      el.monMetaBox.textContent = '加载配置失败：' + err.message;
    }
  }

  async function pollRecent() {
    try {
      var qs1 = '/api/sms/monitor/recent?sinceClientId=' + lastClientId;
      var qs2 = '/api/sms/monitor/cancels?sinceClientId=' + lastCancelClientId;
      var res = await Promise.all([fetch(qs1), fetch(qs2)]);
      if (res[0].ok) {
        var d1 = await res[0].json();
        if (d1.state) renderState(d1.state);
        if (d1.items && d1.items.length) {
          renderNewItems(d1.items);
          lastClientId = d1.lastClientId || lastClientId;
        } else if (d1.lastClientId) {
          lastClientId = d1.lastClientId;
        }
      }
      if (res[1].ok) {
        var d2 = await res[1].json();
        if (d2.state) renderState(d2.state);
        if (d2.items && d2.items.length) {
          renderCancelItems(d2.items);
          lastCancelClientId = d2.lastClientId || lastCancelClientId;
        } else if (d2.lastClientId) {
          lastCancelClientId = d2.lastClientId;
        }
      }
    } catch (_e) {
      // 静默，下次再试
    }
  }

  async function saveConfig() {
    var body = {
      enabled: el.monEnabled.value === '1',
      intervalSec: Number(el.monInterval.value) || 3,
      bufferSize: Number(el.monBuffer.value) || 200,
    };
    el.btnMonSave.disabled = true;
    hint('保存中…');
    try {
      var resp = await fetch('/api/sms/monitor/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      if (!resp.ok) { hint('保存失败', '#fca5a5'); return; }
      renderState(data);
      hint('已保存', '#a7f3d0');
    } catch (err) {
      hint('保存失败：' + err.message, '#fca5a5');
    } finally {
      el.btnMonSave.disabled = false;
    }
  }

  async function clearList() {
    if (!confirm('清空新告警和告警解除列表？（只清前端显示和后端缓冲，不影响数据库）')) return;
    try {
      await fetch('/api/sms/monitor/clear', { method: 'POST' });
    } catch (_e) {}
    renderedClientIds = new Set();
    renderedCancelIds = new Set();
    cancelledRowIds = new Set();
    el.monList.innerHTML =
      '<div class="alarm-head"><span>ID</span><span>等级</span><span>告警内容</span><span style="text-align:right">创建时间</span></div>' +
      '<div id="monListEmpty" style="padding:14px;color:#64748b;font-size:12px;text-align:center">暂无新告警</div>';
    el.monListEmpty = $('monListEmpty');
    if (el.cancelList) {
      el.cancelList.innerHTML =
        '<div class="alarm-head cancel-head"><span>ID</span><span>等级</span><span>告警内容</span><span style="text-align:right">解除时间</span></div>' +
        '<div id="cancelListEmpty" style="padding:14px;color:#64748b;font-size:12px;text-align:center">暂无告警解除</div>';
      el.cancelListEmpty = $('cancelListEmpty');
    }
  }

  async function clearAlarmList() {
    if (!confirm('清空"新告警提示"列表？（只清前端显示和后端缓冲，不影响"告警解除"和数据库）')) return;
    try {
      await fetch('/api/sms/monitor/clear?scope=alarms', { method: 'POST' });
    } catch (_e) {}
    renderedClientIds = new Set();
    el.monList.innerHTML =
      '<div class="alarm-head"><span>ID</span><span>等级</span><span>告警内容</span><span style="text-align:right">创建时间</span></div>' +
      '<div id="monListEmpty" style="padding:14px;color:#64748b;font-size:12px;text-align:center">暂无新告警</div>';
    el.monListEmpty = $('monListEmpty');
  }

  el.btnMonSave.addEventListener('click', saveConfig);
  el.btnMonClear.addEventListener('click', clearList);
  el.btnClearAlarmList && el.btnClearAlarmList.addEventListener('click', clearAlarmList);

  loadConfig();
  pollRecent();
  // 前端轮询频率 = 后端间隔的一半，最少 1s，最多 5s
  setInterval(function () {
    pollRecent();
  }, 1500);
})();
