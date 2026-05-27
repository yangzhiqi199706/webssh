(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    pushDot: $('pushDot'),
    pushState: $('pushState'),
    btnOpenPushModal: $('btnOpenPushModal'),
    btnOpenSendModal: $('btnOpenSendModal'),
    btnQuerySim: $('btnQuerySim'),

    pushModal: $('pushModal'),
    btnClosePushModal: $('btnClosePushModal'),
    pushEnabled: $('pushEnabled'),
    pushAutoOnAlarm: $('pushAutoOnAlarm'),
    pushAutoOnCancel: $('pushAutoOnCancel'),
    pushHost: $('pushHost'),
    pushPort: $('pushPort'),
    pushPath: $('pushPath'),
    resultsPath: $('resultsPath'),
    simPath: $('simPath'),
    pushTimeout: $('pushTimeout'),
    pushQueryInterval: $('pushQueryInterval'),
    pushEncoding: $('pushEncoding'),
    btnPushSave: $('btnPushSave'),
    pushSaveHint: $('pushSaveHint'),
    pushMetaBox: $('pushMetaBox'),

    // 收件人弹窗（只读查看）
    recipientsModal: $('recipientsModal'),
    btnOpenRecipientsModal: $('btnOpenRecipientsModal'),
    btnCloseRecipientsModal: $('btnCloseRecipientsModal'),
    btnReloadPersons: $('btnReloadPersons'),
    personFilter: $('personFilter'),
    personsList: $('personsList'),
    personsEmpty: $('personsEmpty'),
    modePreviewId: $('modePreviewId'),
    btnPreviewMode: $('btnPreviewMode'),
    modePreviewBox: $('modePreviewBox'),

    sendModal: $('sendModal'),
    btnCloseSendModal: $('btnCloseSendModal'),
    sendType: $('sendType'),
    sendEncoding: $('sendEncoding'),
    sendTo: $('sendTo'),
    sendText: $('sendText'),
    btnSendNow: $('btnSendNow'),
    sendHint: $('sendHint'),
    sendResult: $('sendResult'),

    simDot: $('simDot'),
    simHint: $('simHint'),
    simBox: $('simBox'),

    historyList: $('historyList'),
    historyEmpty: $('historyEmpty'),
    historyHint: $('historyHint'),
    btnRefreshResults: $('btnRefreshResults'),
    btnClearHistory: $('btnClearHistory'),

    historyDetailModal: $('historyDetailModal'),
    historyDetailTitle: $('historyDetailTitle'),
    historyDetailBody: $('historyDetailBody'),
    btnCloseHistoryDetail: $('btnCloseHistoryDetail'),
  };

  var cfgLoaded = false;

  // 收件人弹窗：只读视图，仅缓存 dcim-person 列表，不再做勾选/保存
  var allPersons = [];                    // [{id, name, phone, groupId}]
  var personsLoaded = false;

  function openModal(m) { if (m) { m.classList.add('open'); m.setAttribute('aria-hidden', 'false'); } }
  function closeModal(m) { if (m) { m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); } }

  el.btnOpenPushModal && el.btnOpenPushModal.addEventListener('click', function () { openModal(el.pushModal); });
  el.btnClosePushModal && el.btnClosePushModal.addEventListener('click', function () { closeModal(el.pushModal); });
  el.pushModal && el.pushModal.addEventListener('click', function (e) {
    if (e.target === el.pushModal) closeModal(el.pushModal);
  });
  el.btnOpenSendModal && el.btnOpenSendModal.addEventListener('click', function () { openModal(el.sendModal); });
  el.btnCloseSendModal && el.btnCloseSendModal.addEventListener('click', function () { closeModal(el.sendModal); });
  el.sendModal && el.sendModal.addEventListener('click', function (e) {
    if (e.target === el.sendModal) closeModal(el.sendModal);
  });
  el.btnCloseHistoryDetail && el.btnCloseHistoryDetail.addEventListener('click', function () { closeModal(el.historyDetailModal); });
  el.historyDetailModal && el.historyDetailModal.addEventListener('click', function (e) {
    if (e.target === el.historyDetailModal) closeModal(el.historyDetailModal);
  });

  // 收件人弹窗（只读）：打开时按需加载列表，不再有勾选/保存动作
  el.btnOpenRecipientsModal && el.btnOpenRecipientsModal.addEventListener('click', function () {
    openModal(el.recipientsModal);
    if (!personsLoaded) loadPersons();
    else renderPersonsList();
  });
  el.btnCloseRecipientsModal && el.btnCloseRecipientsModal.addEventListener('click', function () { closeModal(el.recipientsModal); });
  el.recipientsModal && el.recipientsModal.addEventListener('click', function (e) {
    if (e.target === el.recipientsModal) closeModal(el.recipientsModal);
  });
  el.btnReloadPersons && el.btnReloadPersons.addEventListener('click', function () { loadPersons(); });
  el.personFilter && el.personFilter.addEventListener('input', renderPersonsList);
  el.btnPreviewMode && el.btnPreviewMode.addEventListener('click', previewMode);
  el.modePreviewId && el.modePreviewId.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') previewMode();
  });

  function esc(v) {
    return String(v == null ? '' : v)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function hint(node, text, color) {
    if (!node) return;
    node.textContent = text || '';
    node.style.color = color || '#94a3b8';
    if (text) setTimeout(function () {
      if (node.textContent === text) node.textContent = '';
    }, 3000);
  }

  function parseRecipients(raw) {
    return String(raw || '')
      .split(/[\s,，;；]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  function fmtIsoToLocal(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function renderState(s) {
    el.pushDot.classList.remove('on', 'off', 'err');
    if (!s.enabled) {
      el.pushDot.classList.add('off');
      el.pushState.textContent = '已关闭';
    } else if (s.lastError) {
      el.pushDot.classList.add('err');
      el.pushState.textContent = '异常：' + s.lastError;
    } else {
      el.pushDot.classList.add('on');
      var modeTags = [];
      if (s.autoPushOnAlarm) modeTags.push('新告警自动');
      if (s.autoPushOnCancel) modeTags.push('解除自动');
      var modeText = modeTags.length ? modeTags.join('+') : '手动';
      el.pushState.textContent = '运行中 · ' + s.gatewayHost + ':' + s.gatewayPort + ' · ' + modeText;
    }

    if (el.pushMetaBox) {
      var lines = [];
      lines.push('网关：' + s.gatewayHost + ':' + s.gatewayPort);
      lines.push('推送：' + s.pushPath + '  ·  结果：' + s.resultsPath + '  ·  SIM：' + s.simStatusPath);
      lines.push('收件人解析：' + (s.recipientResolver || 'NotifyModeID -> alarmnotifymode -> person'));
      lines.push('累计：成功 ' + s.totalSent + '  ·  失败 ' + s.totalFailed + '  ·  历史 ' + s.historyCount);
      lines.push('数据库：' + (s.dbConnected ? '已连接' : '未连接'));
      if (s.lastError) lines.push('错误：' + s.lastError);
      el.pushMetaBox.textContent = lines.join('\n');
    }
    el.historyHint.textContent = '历史 ' + s.historyCount + ' 条';
  }

  function fillConfigOnce(s) {
    if (cfgLoaded) return;
    cfgLoaded = true;
    el.pushEnabled.value = s.enabled ? '1' : '0';
    el.pushAutoOnAlarm.value = s.autoPushOnAlarm ? '1' : '0';
    if (el.pushAutoOnCancel) el.pushAutoOnCancel.value = s.autoPushOnCancel ? '1' : '0';
    el.pushHost.value = s.gatewayHost || '';
    el.pushPort.value = String(s.gatewayPort || 8791);
    el.pushPath.value = s.pushPath || '/cgi-bin/NoticePush';
    el.resultsPath.value = s.resultsPath || '/cgi-bin/NoticeResults';
    el.simPath.value = s.simStatusPath || '/cgi-bin/SimStatus';
    el.pushTimeout.value = String(s.httpTimeoutMs || 8000);
    el.pushQueryInterval.value = String(s.autoQueryResultIntervalSec || 30);
    el.pushEncoding.value = s.encoding || 'UTF-8';
  }

  // ==== 收件人弹窗（只读）====
  function filteredPersons(keyword) {
    keyword = String(keyword || '').trim().toLowerCase();
    if (!keyword) return allPersons;
    return allPersons.filter(function (p) {
      return (p.name && String(p.name).toLowerCase().indexOf(keyword) >= 0)
        || (p.phone && String(p.phone).indexOf(keyword) >= 0)
        || (p.groupId && String(p.groupId).indexOf(keyword) >= 0)
        || String(p.id).indexOf(keyword) >= 0;
    });
  }

  function renderPersonsList() {
    var listEl = el.personsList;
    if (!listEl) return;
    var header = listEl.querySelector('.alarm-head');
    var nodes = Array.prototype.slice.call(listEl.children);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] !== header) listEl.removeChild(nodes[i]);
    }
    var keyword = (el.personFilter && el.personFilter.value) || '';
    var rows = filteredPersons(keyword);
    if (!rows.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'padding:14px;color:#64748b;font-size:12px;text-align:center';
      empty.textContent = personsLoaded ? '没有匹配的人员' : '点击"重新加载"';
      listEl.appendChild(empty);
      return;
    }
    var frag = document.createDocumentFragment();
    rows.forEach(function (p) {
      var div = document.createElement('div');
      div.className = 'alarm-row';
      div.style.gridTemplateColumns = '60px 1fr 160px 140px';
      div.style.cursor = 'default';
      div.innerHTML =
        '<span class="alarm-id">#' + esc(p.id) + '</span>' +
        '<span class="alarm-text">' + esc(p.name || '-') + '</span>' +
        '<span class="alarm-time" style="text-align:left;color:#cbd5e1">' + esc(p.phone || '-') + '</span>' +
        '<span class="alarm-time" style="text-align:left;color:#94a3b8;font-family:ui-monospace,monospace">' + esc(p.groupId == null ? '-' : p.groupId) + '</span>';
      frag.appendChild(div);
    });
    listEl.appendChild(frag);
  }

  async function loadPersons() {
    try {
      var resp = await fetch('/api/sms/push/persons');
      var data = await resp.json();
      if (!resp.ok || !data.ok) {
        var msg = (data && data.message) ? data.message : '加载失败';
        var listEl = el.personsList;
        var header = listEl && listEl.querySelector('.alarm-head');
        var nodes = listEl ? Array.prototype.slice.call(listEl.children) : [];
        for (var i = 0; i < nodes.length; i++) {
          if (nodes[i] !== header) listEl.removeChild(nodes[i]);
        }
        if (listEl) {
          var errBox = document.createElement('div');
          errBox.style.cssText = 'padding:14px;color:#fca5a5;font-size:12px;text-align:center';
          errBox.textContent = '加载失败：' + msg;
          listEl.appendChild(errBox);
        }
        return;
      }
      allPersons = (data.items || []).map(function (p) {
        return { id: Number(p.id), name: p.name, phone: p.phone, groupId: p.groupId };
      });
      personsLoaded = true;
      renderPersonsList();
    } catch (err) {
      var listEl2 = el.personsList;
      var header2 = listEl2 && listEl2.querySelector('.alarm-head');
      var nodes2 = listEl2 ? Array.prototype.slice.call(listEl2.children) : [];
      for (var j = 0; j < nodes2.length; j++) {
        if (nodes2[j] !== header2) listEl2.removeChild(nodes2[j]);
      }
      if (listEl2) {
        var errBox2 = document.createElement('div');
        errBox2.style.cssText = 'padding:14px;color:#fca5a5;font-size:12px;text-align:center';
        errBox2.textContent = '加载失败：' + err.message;
        listEl2.appendChild(errBox2);
      }
    }
  }

  // 输入一个 NotifyModeID，调试预览这条 mode 会触发哪些人收信、什么类型
  async function previewMode() {
    var id = Number(el.modePreviewId && el.modePreviewId.value);
    if (!Number.isFinite(id) || id <= 0) {
      el.modePreviewBox.style.display = 'block';
      el.modePreviewBox.innerHTML = '<span class="err">请输入有效的 mode id</span>';
      return;
    }
    el.modePreviewBox.style.display = 'block';
    el.modePreviewBox.textContent = '查询中…';
    try {
      var resp = await fetch('/api/sms/push/resolve-mode?id=' + id);
      var data = await resp.json();
      if (!resp.ok || !data.ok) {
        el.modePreviewBox.innerHTML = '<span class="err">' + esc((data && data.message) || '查询失败') + '</span>';
        return;
      }
      var r = data.resolved;
      var lines = [];
      lines.push('mode #' + r.mode.id + '  ·  ' + (r.mode.alarmName || '-'));
      lines.push('PhoneNotify=' + (r.phoneNotify ? '1（打电话）' : '0') + '  ·  SMSNotify=' + (r.smsNotify ? '1（发短信）' : '0'));
      lines.push('UserID="' + (r.mode.userId || '') + '"  →  解析到 ' + (r.userIds || []).length + ' 个组：[' + (r.userIds || []).join(', ') + ']');
      var actType;
      if (r.phoneNotify && r.smsNotify) actType = 'All（电话+短信）';
      else if (r.phoneNotify) actType = 'Call（电话）';
      else if (r.smsNotify) actType = 'SMS（短信）';
      else actType = '不发送（两个开关都关）';
      lines.push('实际下发类型：' + actType);
      if (!r.persons.length) {
        lines.push('收件人：(无 — UserID 没匹配到 GroupId 包含的人)');
      } else {
        lines.push('收件人 ' + r.persons.length + ' 人：');
        r.persons.forEach(function (p) {
          lines.push('  · #' + p.id + ' ' + (p.name || '-') + '  ' + p.phone + '  GroupId=' + (p.groupId || '-'));
        });
      }
      el.modePreviewBox.textContent = lines.join('\n');
    } catch (err) {
      el.modePreviewBox.innerHTML = '<span class="err">查询失败：' + esc(err.message) + '</span>';
    }
  }

  // ==== 历史渲染 ====
  function statusClass(status) {
    if (!status) return 'lv-1';
    if (/失败|拒绝|error|fail|reject/i.test(status)) return 'lv-5';
    if (/成功|ok|done/i.test(status)) return 'lv-2';
    if (/发送中|下发|pending|sending/i.test(status)) return 'lv-3';
    return 'lv-1';
  }

  function renderHistory(items) {
    if (!items) items = [];
    var header = el.historyList.querySelector('.alarm-head');
    var nodes = Array.prototype.slice.call(el.historyList.children);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] !== header) el.historyList.removeChild(nodes[i]);
    }
    if (!items.length) {
      var empty = document.createElement('div');
      empty.id = 'historyEmpty';
      empty.style.cssText = 'padding:14px;color:#64748b;font-size:12px;text-align:center';
      empty.textContent = '暂无发送记录';
      el.historyList.appendChild(empty);
      return;
    }
    items.forEach(function (it) {
      var div = document.createElement('div');
      div.className = 'alarm-row';
      div.style.gridTemplateColumns = '48px 64px minmax(0,1fr) 120px 120px';
      var sourceTag;
      if (it.source === 'auto-cancel') sourceTag = '<span class="alarm-level lv-2">解除</span>';
      else if (it.source === 'auto') sourceTag = '<span class="alarm-level lv-3">自动</span>';
      else sourceTag = '<span class="alarm-level lv-1">手动</span>';
      var typeTag = '<span class="alarm-level lv-1">' + esc(it.type || '-') + '</span>';
      var statusTag = '<span class="alarm-level ' + statusClass(it.status) + '">' + esc(it.status || '-') + '</span>';
      var ts = fmtIsoToLocal(it.stime);
      div.innerHTML =
        sourceTag + typeTag +
        '<span class="alarm-text">' + esc(it.text || '') + '<span class="muted" style="margin-left:6px;color:#64748b">→ ' + esc((it.to || []).join(',')) + '</span></span>' +
        statusTag +
        '<span class="alarm-time" title="' + esc(ts) + '">' + esc(ts) + '</span>';
      div.addEventListener('click', function () { openHistoryDetail(it); });
      el.historyList.appendChild(div);
    });
  }

  function openHistoryDetail(item) {
    el.historyDetailTitle.textContent = '发送详情 · ' + (item.id ? item.id.slice(0, 8) : '-')
      + ' · ' + (item.status || '-');
    var personLabel = (item.persons && item.persons.length)
      ? item.persons.map(function (p) { return p.name + '(' + p.phone + ')'; }).join(', ')
      : '';
    var pairs = [
      ['id', item.id],
      ['ids', (item.ids || []).join(', ')],
      ['来源', item.source === 'auto-cancel' ? '自动（告警解除触发）'
        : item.source === 'auto' ? '自动（新告警触发）'
        : '手动'],
      ['状态', item.status],
      ['错误', item.error],
      ['类型', item.type],
      ['编码', item.encoding],
      ['收件人(姓名)', personLabel],
      ['收件人(号码)', (item.to || []).join(', ')],
      ['内容', item.text],
      ['下发时间(stime)', fmtIsoToLocal(item.stime) + '（' + (item.stime || '') + '）'],
      ['回执时间(ackTime)', fmtIsoToLocal(item.ackTime) + '（' + (item.ackTime || '') + '）'],
      ['网关', item.gateway],
    ];
    var html = pairs.map(function (p) {
      var k = p[0]; var v = p[1];
      if (v == null || v === '') return '<div class="detail-item"><span class="k">' + esc(k) + '</span><span class="v null">—</span></div>';
      return '<div class="detail-item"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
    }).join('');
    el.historyDetailBody.innerHTML = '<div class="detail-list">' + html + '</div>';
    openModal(el.historyDetailModal);
  }

  // ==== API ====
  async function loadConfig() {
    try {
      var resp = await fetch('/api/sms/push/config');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      fillConfigOnce(data);
      renderState(data);
    } catch (err) {
      el.pushMetaBox.textContent = '加载配置失败：' + err.message;
    }
  }

  async function saveConfig() {
    var body = {
      enabled: el.pushEnabled.value === '1',
      autoPushOnAlarm: el.pushAutoOnAlarm.value === '1',
      autoPushOnCancel: el.pushAutoOnCancel ? el.pushAutoOnCancel.value === '1' : false,
      gatewayHost: (el.pushHost.value || '').trim(),
      gatewayPort: Number(el.pushPort.value) || 8791,
      pushPath: (el.pushPath.value || '/cgi-bin/NoticePush').trim(),
      resultsPath: (el.resultsPath.value || '/cgi-bin/NoticeResults').trim(),
      simStatusPath: (el.simPath.value || '/cgi-bin/SimStatus').trim(),
      httpTimeoutMs: Number(el.pushTimeout.value) || 8000,
      autoQueryResultIntervalSec: Number(el.pushQueryInterval.value) || 30,
      encoding: el.pushEncoding.value,
    };
    if (!body.gatewayHost) { hint(el.pushSaveHint, '网关 IP 不能为空', '#fca5a5'); return; }
    el.btnPushSave.disabled = true;
    hint(el.pushSaveHint, '保存中…');
    try {
      var resp = await fetch('/api/sms/push/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      if (!resp.ok) { hint(el.pushSaveHint, '保存失败', '#fca5a5'); return; }
      renderState(data);
      hint(el.pushSaveHint, '已保存', '#a7f3d0');
    } catch (err) {
      hint(el.pushSaveHint, '保存失败：' + err.message, '#fca5a5');
    } finally {
      el.btnPushSave.disabled = false;
    }
  }

  async function sendNow() {
    var manualTo = parseRecipients(el.sendTo.value);
    var body = {
      type: el.sendType.value || undefined,
      encoding: el.sendEncoding.value || undefined,
      text: (el.sendText.value || '').trim(),
    };
    // 手动填了号码就用手动；否则后端会用 cfg.recipientIds 实时查库
    if (manualTo.length) body.to = manualTo;
    if (!body.text) { hint(el.sendHint, '内容不能为空', '#fca5a5'); return; }
    el.btnSendNow.disabled = true;
    hint(el.sendHint, '发送中…');
    el.sendResult.style.display = 'none';
    try {
      var resp = await fetch('/api/sms/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      if (!resp.ok || !data.ok) {
        hint(el.sendHint, '发送失败', '#fca5a5');
        el.sendResult.style.display = 'block';
        el.sendResult.innerHTML = '<span class="err">' + esc((data && data.message) || '未知错误') + '</span>';
        return;
      }
      hint(el.sendHint, '已下发，等待回执', '#a7f3d0');
      el.sendResult.style.display = 'block';
      el.sendResult.textContent = 'id=' + data.entry.id + '\n收件人=' + (data.entry.to || []).join(',')
        + '\n状态=' + data.entry.status + '\n下发时间=' + fmtIsoToLocal(data.entry.stime);
      if (data.state) renderState(data.state);
      loadHistory();
    } catch (err) {
      hint(el.sendHint, '请求失败：' + err.message, '#fca5a5');
    } finally {
      el.btnSendNow.disabled = false;
    }
  }

  async function loadHistory() {
    try {
      var resp = await fetch('/api/sms/push/history?limit=100');
      if (!resp.ok) return;
      var data = await resp.json();
      if (data.state) renderState(data.state);
      renderHistory(data.items || []);
    } catch (_e) {}
  }

  async function refreshResults() {
    el.btnRefreshResults.disabled = true;
    try {
      var resp = await fetch('/api/sms/push/refresh-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      var data = await resp.json();
      if (data && data.ok) {
        loadHistory();
      }
    } catch (_e) {}
    finally { el.btnRefreshResults.disabled = false; }
  }

  async function clearHistory() {
    if (!confirm('清空发送历史？（不影响数据库与网关）')) return;
    try {
      await fetch('/api/sms/push/clear-history', { method: 'POST' });
      loadHistory();
    } catch (_e) {}
  }

  function renderSim(json, raw) {
    el.simDot.classList.remove('on', 'off', 'err');
    if (!json) {
      el.simDot.classList.add('err');
      el.simHint.textContent = '响应不是 JSON';
      el.simBox.innerHTML = '<span class="err">' + esc(raw || '空响应') + '</span>';
      return;
    }
    var ok = json.isSimCardExist === 'normal' && json.isGSMNetReg === 'normal';
    el.simDot.classList.add(ok ? 'on' : 'err');
    el.simHint.textContent = ok ? '正常' : '异常';
    var rows = [
      ['SIM 卡', json.isSimCardExist === 'normal' ? '已识别' : '未识别 / 异常', json.isSimCardExist],
      ['GSM 网络注册', json.isGSMNetReg === 'normal' ? '已入网' : '未入网', json.isGSMNetReg],
      ['信号强度', json.rssi || '-', json.rssi],
      ['运营商', json.operator || '-', json.operator],
      ['话费余额', (json.balance == null || json.balance === '') ? '未查询' : json.balance, json.balance],
    ];
    var html = rows.map(function (r) {
      return '<div class="detail-item">'
        + '<span class="k">' + esc(r[0]) + '</span>'
        + '<span class="v">' + esc(r[1]) + ' <span class="muted" style="color:#64748b">(' + esc(r[2] == null ? '' : r[2]) + ')</span></span>'
        + '</div>';
    }).join('');
    el.simBox.innerHTML = '<div class="detail-list">' + html + '</div>';
  }

  async function querySim() {
    el.btnQuerySim.disabled = true;
    el.simHint.textContent = '查询中…';
    try {
      var resp = await fetch('/api/sms/push/sim-status');
      var data = await resp.json();
      if (!resp.ok || !data.ok) {
        el.simDot.classList.remove('on', 'off');
        el.simDot.classList.add('err');
        el.simHint.textContent = '查询失败';
        el.simBox.innerHTML = '<span class="err">' + esc((data && (data.message || data.raw)) || '未知错误') + '</span>';
        return;
      }
      renderSim(data.json, data.raw);
    } catch (err) {
      el.simDot.classList.remove('on', 'off');
      el.simDot.classList.add('err');
      el.simHint.textContent = '查询失败';
      el.simBox.innerHTML = '<span class="err">' + esc(err.message) + '</span>';
    } finally { el.btnQuerySim.disabled = false; }
  }

  el.btnPushSave && el.btnPushSave.addEventListener('click', saveConfig);
  el.btnSendNow && el.btnSendNow.addEventListener('click', sendNow);
  el.btnRefreshResults && el.btnRefreshResults.addEventListener('click', refreshResults);
  el.btnClearHistory && el.btnClearHistory.addEventListener('click', clearHistory);
  el.btnQuerySim && el.btnQuerySim.addEventListener('click', querySim);

  loadConfig();
  loadHistory();
  setInterval(loadHistory, 5000);
})();
