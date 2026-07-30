(function () {
  'use strict';

  var Bus = window.HaBus || { on: function () {}, emit: function () {} };
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    card: $('failoverCard'),
    dot: $('failoverDot'),
    stateHint: $('failoverStateHint'),
    enabled: $('failoverEnabled'),
    bufferPreset: $('failoverBufferPreset'),
    bufferCustomWrap: $('failoverBufferCustomWrap'),
    bufferSec: $('failoverBufferSec'),
    judgeMode: $('failoverJudgeMode'),
    consecutiveFails: $('failoverConsecutiveFails'),
    autoYield: $('failoverAutoYield'),
    autoYieldConsecutive: $('failoverAutoYieldConsecutive'),
    cooldownSec: $('failoverCooldownSec'),
    kv: $('failoverKv'),
    btnSave: $('btnFailoverSave'),
    btnTest: $('btnFailoverTest'),
    btnReset: $('btnFailoverReset'),
    saveHint: $('failoverSaveHint'),
    btnInfo: $('btnFailoverInfo'),
    infoModal: $('failoverInfoModal'),
    btnCloseInfo: $('btnCloseFailoverInfo'),
    takenOverBanner: $('takenOverBanner'),
    takenOverInfo: $('takenOverInfo'),
    // 顶部徽章
    takenOverBadge: $('takenOverBadge'),
    yieldedBadge: $('yieldedBadge'),
  };

  var formLoaded = false;

  function escHt(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function setSaveHint(text, color) {
    if (!el.saveHint) return;
    el.saveHint.textContent = text || '';
    el.saveHint.style.color = color || '#94a3b8';
    if (text) setTimeout(function () {
      if (el.saveHint && el.saveHint.textContent === text) el.saveHint.textContent = '';
    }, 5000);
  }

  function toggleCustomWrap() {
    if (!el.bufferCustomWrap || !el.bufferPreset) return;
    el.bufferCustomWrap.style.display = el.bufferPreset.value === 'custom' ? '' : 'none';
  }

  function fillForm(fo) {
    if (!fo) return;
    if (formLoaded) return;
    formLoaded = true;
    if (el.enabled) el.enabled.value = fo.enabled ? '1' : '0';
    var preset = String(fo.bufferPreset || '30');
    var sec = Number(fo.bufferSec) || 30;
    // 如果 preset 不在固定列表里，强制改 custom
    if (['10','30','60','120','custom'].indexOf(preset) < 0) preset = 'custom';
    if (preset !== 'custom' && Number(preset) !== sec) preset = 'custom';
    if (el.bufferPreset) el.bufferPreset.value = preset;
    if (el.bufferSec) el.bufferSec.value = sec;
    toggleCustomWrap();
    if (el.judgeMode) el.judgeMode.value = fo.judgeMode || 'any';
    if (el.consecutiveFails) el.consecutiveFails.value = Number(fo.consecutiveFails) || 2;
    if (el.autoYield) el.autoYield.value = fo.autoYieldOnPeerRecover === false ? '0' : '1';
    if (el.autoYieldConsecutive) el.autoYieldConsecutive.value = Number(fo.autoYieldConsecutive) || 5;
    if (el.cooldownSec) el.cooldownSec.value = (fo.cooldownSec != null ? Number(fo.cooldownSec) : 60);
  }

  function fmtState(state, fo) {
    if (state === 'taken-over') return '<span class="pill err">已接管</span>';
    if (state === 'taking-over') return '<span class="pill warn">接管中…</span>';
    if (state === 'counting-down') return '<span class="pill warn">倒计时 ' + (fo.countdownSec || 0) + 's</span>';
    if (state === 'monitoring') return '<span class="pill ok">监测中</span>';
    if (state === 'failed') return '<span class="pill err">接管失败</span>';
    return '<span class="pill">空闲</span>';
  }

  function renderCard(fo, selfRole) {
    if (!el.card) return;
    // 仅 standby 显示
    var standby = selfRole === 'standby';
    el.card.style.display = standby ? '' : 'none';
    if (!standby) return;

    fillForm(fo);

    var state = fo && fo.state || 'idle';
    var taken = !!(fo && fo.takenOver);

    // 顶部「接管中」徽章
    if (el.takenOverBadge) el.takenOverBadge.style.display = taken ? '' : 'none';

    // 红色横幅
    if (el.takenOverBanner) {
      el.takenOverBanner.style.display = taken ? '' : 'none';
      if (taken && el.takenOverInfo) {
        el.takenOverInfo.innerHTML = '接管时间：' + escHt(fo.takenOverAt || '-');
      }
    }

    // 重置按钮（仅接管状态显示）
    if (el.btnReset) el.btnReset.style.display = taken ? '' : 'none';

    // 圆点颜色
    if (el.dot) {
      el.dot.className = 'dot ' + (
        state === 'taken-over' ? 'err'
        : state === 'taking-over' || state === 'counting-down' ? 'warn'
        : state === 'monitoring' ? 'on'
        : state === 'failed' ? 'err'
        : 'off'
      );
    }
    if (el.stateHint) {
      var hint = state === 'monitoring' ? ('监测中（连续失败 ' + (fo.failCount || 0) + ' 次）')
              : state === 'counting-down' ? ('倒计时 ' + (fo.countdownSec || 0) + 's')
              : state === 'taking-over' ? '接管中…'
              : state === 'taken-over' ? '已接管业务'
              : state === 'failed' ? '接管失败' : '未启用';
      el.stateHint.textContent = hint;
    }

    if (el.kv) {
      var rows = [];
      rows.push('<div class="kv-row"><span class="k">状态</span><span class="v">' + fmtState(state, fo) + '</span><span></span></div>');
      rows.push('<div class="kv-row"><span class="k">缓冲时长</span><span class="v">' + escHt(fo.bufferSec || 30) + ' 秒</span><span></span></div>');
      rows.push('<div class="kv-row"><span class="k">失联判定</span><span class="v">' + escHt(fo.judgeMode === 'both' ? '两端口都不通' : (fo.judgeMode === 'ip-only' ? '仅 IP' : '任一端口不通')) + '</span><span></span></div>');
      rows.push('<div class="kv-row"><span class="k">连续失败次数</span><span class="v mono">' + escHt(fo.consecutiveFails || 2) + '（当前 ' + (fo.failCount || 0) + '）</span><span></span></div>');
      rows.push('<div class="kv-row"><span class="k">自动让位</span><span class="v">' + (fo.autoYieldOnPeerRecover === false ? '<span class="pill warn">关闭</span>' : '<span class="pill ok">启用</span> 连续 ' + (fo.autoYieldConsecutive || 5) + ' 次（' + (fo.autoYieldConsecutive || 5) * 3 + 's）') + '</span><span></span></div>');
      rows.push('<div class="kv-row"><span class="k">冷却时长</span><span class="v mono">' + escHt(fo.cooldownSec != null ? fo.cooldownSec : 60) + ' 秒</span><span></span></div>');
      if ((fo.cooldownRemainingSec || 0) > 0) {
        rows.push('<div class="kv-row"><span class="k">冷却剩余</span><span class="v" style="color:#fcd34d">' + (fo.cooldownRemainingSec || 0) + ' 秒（期间不触发接管）</span><span></span></div>');
      }
      if (state === 'taken-over' && fo.autoYieldOnPeerRecover !== false && (fo.peerRecoverCount || 0) > 0) {
        rows.push('<div class="kv-row"><span class="k">主机回归计数</span><span class="v" style="color:#a7f3d0">' + (fo.peerRecoverCount || 0) + ' / ' + (fo.autoYieldConsecutive || 5) + '（达到后自动让位）</span><span></span></div>');
      }
      if (fo.takenOverAt) {
        rows.push('<div class="kv-row"><span class="k">接管时间</span><span class="v mono">' + escHt(fo.takenOverAt) + '</span><span></span></div>');
      }
      if (fo.takenOverError) {
        rows.push('<div class="kv-row"><span class="k">上次错误</span><span class="v" style="color:#fca5a5">' + escHt(fo.takenOverError) + '</span><span></span></div>');
      }
      el.kv.innerHTML = rows.join('');
    }
  }

  function renderYieldedBadge(yielded) {
    if (!el.yieldedBadge) return;
    var show = !!(yielded && yielded.yieldedToStandby);
    el.yieldedBadge.style.display = show ? '' : 'none';
    if (show) {
      el.yieldedBadge.title = '本机已让位给备机（' + (yielded.yieldedAt || '') + '），dcim 已停止';
    }
  }

  Bus.on('snapshot', function (data) {
    if (!data) return;
    renderCard(data.failover, data.selfRole);
    renderYieldedBadge(data.yielded);
  });

  // 由 monitor 持续推 heartbeat 时也顺手更新倒计时显示
  Bus.on('heartbeat', function () {
    // heartbeat 不带 failover 数据，倒计时刷新依赖后端 broadcastSnapshot（每 5s 推一次）
  });

  el.bufferPreset && el.bufferPreset.addEventListener('change', function () {
    toggleCustomWrap();
    if (el.bufferPreset.value !== 'custom' && el.bufferSec) {
      el.bufferSec.value = el.bufferPreset.value;
    }
  });

  el.btnSave && el.btnSave.addEventListener('click', async function () {
    var preset = el.bufferPreset.value;
    var sec = preset === 'custom' ? Number(el.bufferSec.value) : Number(preset);
    if (!(sec >= 5 && sec <= 3600)) {
      setSaveHint('缓冲秒数必须在 5-3600 之间', '#fca5a5'); return;
    }
    var body = {
      enabled: el.enabled.value === '1',
      bufferSec: sec,
      bufferPreset: preset,
      judgeMode: el.judgeMode.value,
      consecutiveFails: Number(el.consecutiveFails.value) || 2,
      autoYieldOnPeerRecover: el.autoYield ? el.autoYield.value === '1' : true,
      autoYieldConsecutive: el.autoYieldConsecutive ? (Number(el.autoYieldConsecutive.value) || 5) : 5,
      cooldownSec: el.cooldownSec ? Number(el.cooldownSec.value) : 60,
    };
    if (body.enabled) {
      if (!confirm(
        '即将启用故障接管缓冲监测。\n\n' +
        '缓冲时长：' + sec + ' 秒\n' +
        '失联判定：' + (body.judgeMode === 'both' ? '两端口都不通' : (body.judgeMode === 'ip-only' ? '仅 IP 不通' : '任一端口不通')) + '\n' +
        '连续失败次数：' + body.consecutiveFails + '\n\n' +
        '主机失联超过缓冲时长后，备机将自动：\n' +
        '1) UPDATE dcim-device SET status=1\n' +
        '2) docker exec dcim systemctl restart dcim\n\n' +
        '建议先点「测试接管命令」做一次 dry-run。继续？'
      )) return;
    }
    el.btnSave.disabled = true;
    setSaveHint('保存中…');
    try {
      var resp = await fetch('/api/ha/failover', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data && data.message || ('HTTP ' + resp.status));
      setSaveHint('已保存', '#a7f3d0');
      formLoaded = false; // 允许下次 snapshot 用新值回填
    } catch (err) {
      setSaveHint('保存失败：' + err.message, '#fca5a5');
    } finally {
      el.btnSave.disabled = false;
    }
  });

  el.btnTest && el.btnTest.addEventListener('click', async function () {
    el.btnTest.disabled = true;
    setSaveHint('测试中…');
    try {
      var resp = await fetch('/api/ha/failover/test', { method: 'POST' });
      var data = await resp.json();
      var checks = (data && data.data) || {};
      var msg = '【dry-run 结果】\n\n' +
        'docker ps    : ' + (checks.dockerPs || '-') + '\n' +
        'mysql 连通   : ' + (checks.mysqlConn || '-') + '\n' +
        'UPDATE 权限  : ' + (checks.updateGrant || '-') + '\n' +
        'DELETE 权限  : ' + (checks.deleteGrant || '-') + '\n\n' +
        (data && data.message || '');
      alert(msg);
      setSaveHint(data.ok ? '测试通过' : '测试有失败项', data.ok ? '#a7f3d0' : '#fca5a5');
    } catch (err) {
      setSaveHint('请求失败：' + err.message, '#fca5a5');
    } finally {
      el.btnTest.disabled = false;
    }
  });

  el.btnReset && el.btnReset.addEventListener('click', async function () {
    if (!confirm(
      '即将重置接管状态：\n\n' +
      '1) 备机 UPDATE dcim-device SET status=-1（恢复"假删除"）\n' +
      '2) 备机 docker exec dcim systemctl stop dcim（停止采集）\n' +
      '3) 主机 5 秒内自动 systemctl start dcim（接回业务）\n\n' +
      '此操作让备机让位、业务回到主机。继续？'
    )) return;
    el.btnReset.disabled = true;
    setSaveHint('重置中…');
    try {
      var resp = await fetch('/api/ha/failover/reset', { method: 'POST' });
      var data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data && data.message || ('HTTP ' + resp.status));
      setSaveHint('已重置', '#a7f3d0');
    } catch (err) {
      setSaveHint('重置失败：' + err.message, '#fca5a5');
    } finally {
      el.btnReset.disabled = false;
    }
  });

  // 信息弹窗
  function openInfo() {
    if (!el.infoModal) return;
    el.infoModal.classList.add('open');
    el.infoModal.setAttribute('aria-hidden', 'false');
  }
  function closeInfo() {
    if (!el.infoModal) return;
    el.infoModal.classList.remove('open');
    el.infoModal.setAttribute('aria-hidden', 'true');
  }
  el.btnInfo && el.btnInfo.addEventListener('click', openInfo);
  el.btnCloseInfo && el.btnCloseInfo.addEventListener('click', closeInfo);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && el.infoModal && el.infoModal.classList.contains('open')) closeInfo();
  });

  // 首屏兜底
  fetch('/api/ha/status').then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.ok && j.status) {
      renderCard(j.status.failover, j.status.selfRole);
      renderYieldedBadge(j.status.yielded);
    }
  }).catch(function () {});
})();
