(function () {
  'use strict';

  var Bus = window.HaBus || { on: function () {}, emit: function () {} };
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    btn: $('btnSyncDb'),
    card: $('syncCard'),
    dot: $('syncDot'),
    runHint: $('syncRunHint'),
    kv: $('syncKv'),
    stepsBox: $('syncStepsBox'),
  };

  var state = {
    allowed: false,
    running: false,
    lastResult: '',
    step: '',
    steps: [],
  };

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function kvRow(k, v) {
    return '<div class="kv-row"><span class="k">' + escHtml(k) + '</span>' +
      '<span class="v">' + (v == null ? '-' : v) + '</span><span></span></div>';
  }

  function renderCard(sync) {
    if (!sync) return;
    state.allowed   = !!sync.allowed;
    state.running   = !!sync.running;
    state.lastResult = sync.lastResult || '';
    state.step       = sync.step || '';
    state.steps      = Array.isArray(sync.steps) ? sync.steps : [];

    if (el.card) {
      // 仅当本机角色为 primary 时显示卡片；备机隐藏（按钮也禁用）
      el.card.style.display = state.allowed ? '' : 'none';
    }
    if (el.btn) {
      el.btn.disabled = !state.allowed || state.running;
      if (!state.allowed) el.btn.title = '仅当本机角色为「主机」时可触发同步';
      else if (state.running) el.btn.title = '同步进行中…';
      else el.btn.title = '主机 → 备机 数据库同步';
      el.btn.textContent = state.running ? '同步中…' : '数据库同步';
    }
    if (!state.allowed) return;

    if (el.runHint) el.runHint.textContent = state.running
      ? '执行中：' + state.step
      : (state.lastResult === 'success' ? '上次：成功' : (state.lastResult === 'fail' ? '上次：失败' : ''));

    var dotClass = 'dot';
    if (state.running) dotClass += ' warn';
    else if (state.lastResult === 'success') dotClass += ' on';
    else if (state.lastResult === 'fail') dotClass += ' err';
    if (el.dot) el.dot.className = dotClass;

    if (el.kv) {
      var rows = [];
      rows.push(kvRow('当前阶段', escHtml(state.step || '空闲')));
      rows.push(kvRow('开始时间', escHtml(sync.startedAt || '-')));
      if (sync.finishedAt) rows.push(kvRow('完成时间', escHtml(sync.finishedAt)));
      if (sync.lastError) rows.push(kvRow('上次错误', '<span style="color:#fca5a5">' + escHtml(sync.lastError) + '</span>'));
      el.kv.innerHTML = rows.join('');
    }

    if (el.stepsBox) {
      if (!state.steps.length) { el.stepsBox.innerHTML = '<span style="color:#64748b">暂无</span>'; }
      else {
        el.stepsBox.innerHTML = state.steps.map(function (s) {
          var color = s.status === 'fail' ? '#fca5a5' : (s.status === 'done' ? '#a7f3d0' : '#fcd34d');
          var tag = s.status === 'fail' ? '✗' : (s.status === 'done' ? '✓' : '…');
          return '<div><span style="color:#64748b">[' + escHtml(s.ts) + ']</span> ' +
            '<span style="color:' + color + ';font-weight:700">' + tag + '</span> ' +
            escHtml(s.name) + (s.msg ? ' <span style="color:#94a3b8">(' + escHtml(s.msg) + ')</span>' : '') + '</div>';
        }).join('');
        el.stepsBox.scrollTop = el.stepsBox.scrollHeight;
      }
    }
  }

  Bus.on('snapshot', function (data) {
    if (data && data.sync) renderCard(data.sync);
  });

  // 触发同步
  el.btn && el.btn.addEventListener('click', async function () {
    if (state.running) return;
    if (!confirm(
      '即将执行「主 → 备」数据库同步：\n' +
      '\n' +
      '1) 备机 docker exec dcim systemctl stop dcim 停采集\n' +
      '2) 备机当前 dcim 库 mysqldump 备份到 /opt/webssh/logs/\n' +
      '3) 备机容器内 UPDATE `dcim-device` SET status=-1\n' +
      '4) 主机 mysqldump 整个 dcim 库灌到备机\n' +
      '\n' +
      '完成后请到备机手动 docker exec dcim systemctl start dcim 启动采集。\n' +
      '\n' +
      '继续？'
    )) return;
    el.btn.disabled = true;
    el.btn.textContent = '正在请求…';
    try {
      var resp = await fetch('/api/ha/sync', { method: 'POST' });
      var data = await resp.json();
      if (!resp.ok || !data.ok) {
        alert('启动同步失败：' + (data && data.message || ('HTTP ' + resp.status)));
        el.btn.disabled = false;
        el.btn.textContent = '数据库同步';
      }
      // 成功就交给 ws snapshot 推送驱动 UI；按钮按 running 自然禁用
    } catch (err) {
      alert('请求失败：' + err.message);
      el.btn.disabled = false;
      el.btn.textContent = '数据库同步';
    }
  });

  // 首屏兜底：拉一次 status
  fetch('/api/ha/status').then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.ok && j.status && j.status.sync) renderCard(j.status.sync);
  }).catch(function () {});

  // 同步注意事项弹窗：点开 [?] 按钮显示，避免运维忘记收尾的「删除 status=-1」操作
  var infoBtn = $('btnSyncInfo');
  var infoModal = $('syncInfoModal');
  var infoClose = $('btnCloseSyncInfo');
  function openInfo() {
    if (!infoModal) return;
    infoModal.classList.add('open');
    infoModal.setAttribute('aria-hidden', 'false');
  }
  function closeInfo() {
    if (!infoModal) return;
    infoModal.classList.remove('open');
    infoModal.setAttribute('aria-hidden', 'true');
  }
  infoBtn && infoBtn.addEventListener('click', openInfo);
  infoClose && infoClose.addEventListener('click', closeInfo);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && infoModal && infoModal.classList.contains('open')) closeInfo();
  });

  // ---------- 定时同步面板 ----------
  var schEl = {
    card: $('scheduleCard'),
    dot: $('scheduleDot'),
    stateHint: $('scheduleStateHint'),
    enabled: $('scheduleEnabled'),
    preset: $('schedulePreset'),
    cronWrap: $('scheduleCronWrap'),
    cron: $('scheduleCron'),
    skipPeerDown: $('scheduleSkipPeerDown'),
    applyMinusOne: $('scheduleApplyMinusOne'),
    kv: $('scheduleKv'),
    btnSave: $('btnScheduleSave'),
    btnNow: $('btnScheduleNow'),
    saveHint: $('scheduleSaveHint'),
    btnInfo: $('btnScheduleInfo'),
    cronModal: $('cronInfoModal'),
    btnCloseCron: $('btnCloseCronInfo'),
  };

  var schedFormLoaded = false; // 第一次加载用后端值回填表单，之后用户编辑期间不冲掉

  function setSchSaveHint(text, color) {
    if (!schEl.saveHint) return;
    schEl.saveHint.textContent = text || '';
    schEl.saveHint.style.color = color || '#94a3b8';
    if (text) setTimeout(function () {
      if (schEl.saveHint && schEl.saveHint.textContent === text) schEl.saveHint.textContent = '';
    }, 4000);
  }

  function fillSchedForm(sched) {
    if (!sched) return;
    if (schedFormLoaded) return; // 仅首次回填，避免覆盖用户输入
    schedFormLoaded = true;
    if (schEl.enabled) schEl.enabled.value = sched.enabled ? '1' : '0';
    if (schEl.preset) schEl.preset.value = sched.preset || 'daily-3am';
    if (schEl.cron) schEl.cron.value = sched.customCron || sched.cron || '';
    toggleCronWrap();
    if (schEl.skipPeerDown) schEl.skipPeerDown.checked = sched.skipIfPeerDown !== false;
    if (schEl.applyMinusOne) schEl.applyMinusOne.checked = sched.applyStatusMinusOne !== false;
  }

  function toggleCronWrap() {
    if (!schEl.cronWrap || !schEl.preset) return;
    schEl.cronWrap.style.display = schEl.preset.value === 'custom' ? '' : 'none';
  }

  function escHt2(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function fmtLastResult(sched) {
    var r = sched.lastRunResult || '';
    if (r === 'success') return '<span class="pill ok">成功</span>';
    if (r === 'fail')    return '<span class="pill err">失败</span>';
    if (r === 'skipped-peer-down') return '<span class="pill warn">跳过（对端不可达）</span>';
    if (r === 'skipped-mutex')     return '<span class="pill warn">跳过（上次未结束）</span>';
    return '<span class="pill">尚未执行</span>';
  }

  function renderSched(sched) {
    if (!schEl.card) return;
    if (!sched) sched = {};
    // 仅当本机角色为 primary 且总开关启用时显示卡片
    var allowed = !!(sched && (sched.running || sched.enabled || sched.preset)); // 由后端 publicStatus 决定
    // 实际可见条件：syncCard 已显示（说明是 primary）；总开关由 sync.allowed 控制
    var primary = window.HaPrimary === true;
    schEl.card.style.display = primary ? '' : 'none';
    if (!primary) return;

    fillSchedForm(sched);

    if (schEl.dot) {
      schEl.dot.className = 'dot ' + (
        sched.running ? 'on'
        : (sched.lastRunResult === 'fail' ? 'err' : (sched.lastRunResult === 'success' ? 'on' : 'off'))
      );
    }
    if (schEl.stateHint) {
      schEl.stateHint.textContent = sched.running ? '调度器运行中' : '调度器未运行';
    }

    if (schEl.kv) {
      var rows = [];
      rows.push('<div class="kv-row"><span class="k">当前 cron</span><span class="v mono">' + escHt2(sched.cron || '-') + '</span><span></span></div>');
      rows.push('<div class="kv-row"><span class="k">下次执行</span><span class="v">' + escHt2(sched.nextRunAt || '-') + '</span><span></span></div>');
      rows.push('<div class="kv-row"><span class="k">上次执行</span><span class="v">' + escHt2(sched.lastRunAt || '-') + ' ' + fmtLastResult(sched) + '</span><span></span></div>');
      if (sched.lastRunError) {
        rows.push('<div class="kv-row"><span class="k">上次错误</span><span class="v" style="color:#fca5a5">' + escHt2(sched.lastRunError) + '</span><span></span></div>');
      }
      schEl.kv.innerHTML = rows.join('');
    }
  }

  // 复用 sync 卡片的 snapshot：从 sync.schedule 里拿数据
  Bus.on('snapshot', function (data) {
    if (!data) return;
    // sync.allowed=true 表示本机是 primary（显示 syncCard / scheduleCard）
    window.HaPrimary = !!(data.sync && data.sync.allowed);
    if (data.sync && data.sync.schedule) renderSched(data.sync.schedule);
    else renderSched(null);
  });

  // 保存配置
  schEl.btnSave && schEl.btnSave.addEventListener('click', async function () {
    var body = {
      enabled: schEl.enabled.value === '1',
      preset: schEl.preset.value,
      cron: (schEl.cron.value || '').trim(),
      skipIfPeerDown: !!schEl.skipPeerDown.checked,
      applyStatusMinusOne: !!schEl.applyMinusOne.checked,
    };
    if (body.preset === 'custom' && !body.cron) {
      setSchSaveHint('请填入自定义 cron', '#fca5a5'); return;
    }
    schEl.btnSave.disabled = true;
    setSchSaveHint('保存中…');
    try {
      var resp = await fetch('/api/ha/sync-schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data && data.message || ('HTTP ' + resp.status));
      setSchSaveHint('已保存', '#a7f3d0');
      // 强制重新拉一次 status，保证 nextRunAt / running 都是最新
      schedFormLoaded = false; // 允许下次 snapshot 用新值回填（虽然字段没变但保险）
      var st = await fetch('/api/ha/status').then(function (r) { return r.json(); });
      if (st && st.ok && st.status && st.status.sync && st.status.sync.schedule) renderSched(st.status.sync.schedule);
    } catch (err) {
      setSchSaveHint('保存失败：' + err.message, '#fca5a5');
    } finally {
      schEl.btnSave.disabled = false;
    }
  });

  // 立即执行一次：直接复用 /api/ha/sync
  schEl.btnNow && schEl.btnNow.addEventListener('click', async function () {
    if (!confirm('立即执行一次定时同步？\n（流程与手动同步一致：停采集 → 备份 → 灌库 → status=-1）')) return;
    schEl.btnNow.disabled = true;
    setSchSaveHint('触发中…');
    try {
      var resp = await fetch('/api/ha/sync', { method: 'POST' });
      var data = await resp.json();
      if (resp.status === 409) { setSchSaveHint('已有同步任务在执行', '#fcd34d'); return; }
      if (!resp.ok || !data.ok) throw new Error(data && data.message || ('HTTP ' + resp.status));
      setSchSaveHint('已触发，请看右侧消息窗口', '#a7f3d0');
    } catch (err) {
      setSchSaveHint('触发失败：' + err.message, '#fca5a5');
    } finally {
      schEl.btnNow.disabled = false;
    }
  });

  // preset 切换显示/隐藏 cron 输入框
  schEl.preset && schEl.preset.addEventListener('change', toggleCronWrap);

  // cron 语法说明弹窗
  function openCronInfo() {
    if (!schEl.cronModal) return;
    schEl.cronModal.classList.add('open');
    schEl.cronModal.setAttribute('aria-hidden', 'false');
  }
  function closeCronInfo() {
    if (!schEl.cronModal) return;
    schEl.cronModal.classList.remove('open');
    schEl.cronModal.setAttribute('aria-hidden', 'true');
  }
  schEl.btnInfo && schEl.btnInfo.addEventListener('click', openCronInfo);
  schEl.btnCloseCron && schEl.btnCloseCron.addEventListener('click', closeCronInfo);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && schEl.cronModal && schEl.cronModal.classList.contains('open')) closeCronInfo();
  });
})();
