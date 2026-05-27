(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    btnOpen: $('btnOpenScheduledModal'),
    btnClose: $('btnCloseScheduledModal'),
    modal: $('scheduledModal'),
    paramBox: $('scheduledParamBox'),
    previewBox: $('scheduledPreviewBox'),
    guards: $('scheduledGuards'),
    nextBox: $('scheduledNextBox'),
    stateBox: $('scheduledStateBox'),
    btnReload: $('btnReloadScheduled'),
    btnTrigger: $('btnTriggerScheduled'),
    hint: $('scheduledHint'),
    result: $('scheduledResult'),
    recentList: $('scheduledRecentList'),
    recentEmpty: $('scheduledRecentEmpty'),
    recentHint: $('scheduledRecentHint'),
  };

  function openModal() {
    if (!el.modal) return;
    el.modal.classList.add('open');
    el.modal.setAttribute('aria-hidden', 'false');
    loadAll();
  }
  function closeModal() {
    if (!el.modal) return;
    el.modal.classList.remove('open');
    el.modal.setAttribute('aria-hidden', 'true');
  }
  el.btnOpen && el.btnOpen.addEventListener('click', openModal);
  el.btnClose && el.btnClose.addEventListener('click', closeModal);
  el.modal && el.modal.addEventListener('click', function (e) {
    if (e.target === el.modal) closeModal();
  });

  function esc(v) {
    return String(v == null ? '' : v)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function hint(text, color) {
    if (!el.hint) return;
    el.hint.textContent = text || '';
    el.hint.style.color = color || '#94a3b8';
    if (text) setTimeout(function () {
      if (el.hint.textContent === text) el.hint.textContent = '';
    }, 3000);
  }

  function fmtIsoToLocal(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function contentLabel(n) {
    var v = Number(n);
    if (v === 1) return '1 = 告警数量';
    if (v === 2) return '2 = 详细告警';
    if (v === 3) return '3 = 定制内容';
    if (v === 4) return '4 = 参数';
    return String(n == null ? '-' : n);
  }

  function renderPreview(text, error) {
    if (!el.previewBox) return;
    if (error) {
      el.previewBox.style.color = '#fca5a5';
      el.previewBox.textContent = '⚠ 生成预览失败：' + error;
      return;
    }
    el.previewBox.style.color = '#e2e8f0';
    el.previewBox.textContent = text || '(空)';
  }

  function renderParam(p, currentHour) {
    if (!el.paramBox) return;
    var lines = [];
    lines.push('整点短信开关：' + (Number(p.SmsOnhourAlarm) === 1 ? '开启' : '关闭') + '（SmsOnhourAlarm=' + p.SmsOnhourAlarm + '）');
    var typeNum = Number(p.SmsContent);
    var typeNote = '';
    if (typeNum === 2 || typeNum === 4) typeNote = '  ⚠ 类型 ' + typeNum + ' 暂未实现，将按定制内容兜底';
    lines.push('内容类型：' + contentLabel(p.SmsContent) + typeNote);
    lines.push('定制内容：' + (p.SmsCustomContent || '(空)'));
    lines.push('收件人：' + (p.parsedPhones && p.parsedPhones.length ? p.parsedPhones.join(' / ') : '(空)') + '（原值="' + (p.SmsTargetPhone || '') + '"）');
    var hours = (p.parsedHours || []).join(',');
    lines.push('整点小时：' + (hours || '(空)') + '（当前 ' + currentHour + ' 时）');
    lines.push('上次发送：' + (p.LastSmsAlarmTime ? fmtIsoToLocal(p.LastSmsAlarmTime) : '(无)'));
    el.paramBox.textContent = lines.join('\n');
  }

  // 4 项预检逐项渲染：✓/✗ + label + detail
  function renderGuards(guards) {
    if (!el.guards) return;
    var html = (guards.checks || []).map(function (c) {
      var icon = c.ok ? '✓' : '✗';
      var color = c.ok ? '#a7f3d0' : '#fca5a5';
      return '<div style="display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.5;'
        + 'padding:6px 10px;border:1px solid ' + (c.ok ? '#14532d' : '#7f1d1d')
        + ';border-radius:8px;background:#0b1020">'
        + '<span style="color:' + color + ';font-weight:700;font-family:ui-monospace,monospace;flex-shrink:0">' + icon + '</span>'
        + '<div style="display:flex;flex-direction:column;gap:2px;min-width:0">'
        + '<span style="color:#e2e8f0">' + esc(c.label) + '</span>'
        + '<span style="color:#94a3b8;word-break:break-all">' + esc(c.detail || '') + '</span>'
        + '</div></div>';
    }).join('');
    el.guards.innerHTML = html || '<div style="font-size:12px;color:#64748b">暂无判定数据</div>';
  }

  function renderNext(next) {
    if (!el.nextBox) return;
    if (next && next.iso) {
      el.nextBox.textContent = '下次预计：' + next.label + '  （ISO ' + next.iso + '）';
    } else {
      el.nextBox.textContent = '下次预计：—  （' + ((next && next.reason) || '原因未知') + '）';
    }
  }

  function renderState(s) {
    if (!el.stateBox) return;
    var lines = [];
    lines.push('调度周期：每 ' + Math.round(s.pollMs / 1000) + 's 评估一次  ·  去重策略：同一自然小时只发 1 次');
    lines.push('累计：成功 ' + (s.totalSent || 0) + '  ·  失败 ' + (s.totalFailed || 0));
    if (s.lastTickAt) lines.push('上次评估：' + s.lastTickAt);
    if (s.lastSendAt) lines.push('上次发送：' + s.lastSendAt);
    if (s.lastError) lines.push('错误：' + s.lastError);
    el.stateBox.textContent = lines.join('\n');
  }

  // 最近调度记录表
  function renderRecent(items) {
    if (!el.recentList) return;
    var header = el.recentList.querySelector('.alarm-head');
    var rows = el.recentList.querySelectorAll('.alarm-row');
    rows.forEach(function (r) { r.remove(); });
    var emptyDiv = $('scheduledRecentEmpty');
    if (!items || !items.length) {
      if (emptyDiv) emptyDiv.style.display = '';
      el.recentHint.textContent = '0 条';
      return;
    }
    if (emptyDiv) emptyDiv.style.display = 'none';
    el.recentHint.textContent = items.length + ' 条';
    items.forEach(function (it) {
      var div = document.createElement('div');
      div.className = 'alarm-row';
      div.style.gridTemplateColumns = '140px 60px 60px minmax(0,1fr)';
      var kindTag = it.kind === 'manual'
        ? '<span class="alarm-level lv-3">手动</span>'
        : '<span class="alarm-level lv-1">tick</span>';
      var resultTag;
      if (it.fired) {
        resultTag = '<span class="alarm-level lv-2">已发</span>';
      } else if (it.error) {
        resultTag = '<span class="alarm-level lv-4">错误</span>';
      } else {
        resultTag = '<span class="alarm-level lv-1">跳过</span>';
      }
      var detail;
      if (it.fired) {
        detail = '已下发 id=' + (it.entryId || '-') + ' to=' + ((it.to || []).join(','));
      } else if (it.error) {
        detail = it.error;
      } else {
        detail = it.reason || '-';
      }
      div.innerHTML =
        '<span class="alarm-time" style="text-align:left">' + esc(it.at) + '</span>'
        + kindTag + resultTag
        + '<span class="alarm-text">' + esc(detail) + '</span>';
      header.parentNode.appendChild(div);
    });
  }

  async function loadConfig() {
    if (el.paramBox) el.paramBox.textContent = '加载中…';
    if (el.previewBox) { el.previewBox.style.color = '#94a3b8'; el.previewBox.textContent = '加载中…'; }
    if (el.stateBox) el.stateBox.textContent = '调度状态加载中…';
    try {
      var resp = await fetch('/api/sms/scheduled/config');
      var data = await resp.json();
      if (!resp.ok || !data.ok) {
        el.paramBox.textContent = '加载失败：' + ((data && data.message) || ('HTTP ' + resp.status));
        el.stateBox.textContent = '';
        if (el.previewBox) el.previewBox.textContent = '';
        if (el.guards) el.guards.innerHTML = '';
        if (el.nextBox) el.nextBox.textContent = '';
        return;
      }
      renderParam(data.param || {}, data.currentHour);
      renderPreview(data.preview || '', data.previewError || '');
      renderGuards(data.guards || { checks: [] });
      renderNext(data.next || {});
      renderState(data.state || {});
    } catch (err) {
      el.paramBox.textContent = '请求失败：' + err.message;
      el.stateBox.textContent = '';
      if (el.previewBox) el.previewBox.textContent = '';
      if (el.guards) el.guards.innerHTML = '';
      if (el.nextBox) el.nextBox.textContent = '';
    }
  }

  async function loadRecent() {
    try {
      var resp = await fetch('/api/sms/scheduled/recent');
      var data = await resp.json();
      if (!resp.ok || !data.ok) return;
      renderRecent(data.items || []);
    } catch (_e) { /* 静默 */ }
  }

  function loadAll() {
    loadConfig();
    loadRecent();
  }

  async function triggerNow() {
    if (!confirm('立即按当前配置发送一条整点短信？\n（不看开关、不看小时、不看防重间隔，仅用于测试）')) return;
    el.btnTrigger.disabled = true;
    if (el.result) { el.result.style.display = 'none'; el.result.textContent = ''; }
    hint('发送中…');
    try {
      var resp = await fetch('/api/sms/scheduled/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      var data = await resp.json();
      if (!resp.ok || !data.ok) {
        hint('发送失败', '#fca5a5');
        if (el.result) {
          el.result.style.display = 'block';
          el.result.textContent = (data && data.message) || ('HTTP ' + resp.status);
        }
        return;
      }
      hint('已下发，等待回执', '#a7f3d0');
      if (el.result && data.entry) {
        el.result.style.display = 'block';
        var lines = [];
        lines.push('id=' + data.entry.id);
        lines.push('收件人=' + ((data.entry.to || []).join(',')));
        lines.push('状态=' + data.entry.status);
        lines.push('下发时间=' + fmtIsoToLocal(data.entry.stime));
        if (data.entry.error) lines.push('错误=' + data.entry.error);
        el.result.textContent = lines.join('\n');
      }
      // 触发后 LastSmsAlarmTime 已写回，重新拉一遍 config + recent
      setTimeout(loadAll, 500);
    } catch (err) {
      hint('请求失败：' + err.message, '#fca5a5');
    } finally {
      el.btnTrigger.disabled = false;
    }
  }

  el.btnReload && el.btnReload.addEventListener('click', loadAll);
  el.btnTrigger && el.btnTrigger.addEventListener('click', triggerNow);
})();
