(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    modal: $('configModal'),
    btnOpen: $('btnOpenConfig'),
    btnClose: $('btnCloseConfig'),
    cfgEnabled: $('cfgEnabled'),
    saveHint: $('cfgSaveHint'),
    statusBox: $('cfgStatusBox'),
    btnSave: $('btnCfgSave'),
    btnReload: $('btnCfgReload'),
    btnRestart: $('btnCfgRestart'),
    btnTestPriSsh: $('btnTestPriSsh'),
    btnTestPriDb: $('btnTestPriDb'),
    btnTestStbSsh: $('btnTestStbSsh'),
    btnTestStbDb: $('btnTestStbDb'),
    hintPriSsh: $('hintPriSsh'),
    hintPriDb: $('hintPriDb'),
    hintStbSsh: $('hintStbSsh'),
    hintStbDb: $('hintStbDb'),
  };

  var fields = {
    pri: {
      ssh: { host: $('cfgPriSshHost'), port: $('cfgPriSshPort'), user: $('cfgPriSshUser'), pwd: $('cfgPriSshPwd') },
      db:  { host: $('cfgPriDbHost'),  port: $('cfgPriDbPort'),  user: $('cfgPriDbUser'),  pwd: $('cfgPriDbPwd'),  name: $('cfgPriDbName') },
    },
    stb: {
      ssh: { host: $('cfgStbSshHost'), port: $('cfgStbSshPort'), user: $('cfgStbSshUser'), pwd: $('cfgStbSshPwd') },
      db:  { host: $('cfgStbDbHost'),  port: $('cfgStbDbPort'),  user: $('cfgStbDbUser'),  pwd: $('cfgStbDbPwd'),  name: $('cfgStbDbName') },
    },
  };

  var loaded = false; // 已从后端拉过一次配置回填

  function openModal() {
    if (!el.modal) return;
    el.modal.classList.add('open');
    el.modal.setAttribute('aria-hidden', 'false');
    if (!loaded) loadConfig();
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

  function setHint(node, text, color) {
    if (!node) return;
    node.textContent = text || '';
    node.style.color = color || '#94a3b8';
  }

  function setSaveHint(text, color) {
    setHint(el.saveHint, text, color);
    if (text) setTimeout(function () {
      if (el.saveHint && el.saveHint.textContent === text) el.saveHint.textContent = '';
    }, 4000);
  }

  function fillSection(sectionEls, data) {
    if (!data) return;
    sectionEls.host.value = data.host || '';
    sectionEls.port.value = data.port || '';
    sectionEls.user.value = data.user || '';
    // 密码字段：后端返回 '***' 表示已存在密码；展示为占位提示，留空则保持原值
    if (data.password === '***') {
      sectionEls.pwd.value = '';
      sectionEls.pwd.placeholder = '••••••（留空保持原值）';
    } else {
      sectionEls.pwd.value = '';
      sectionEls.pwd.placeholder = '未设置（留空保持原值）';
    }
    if (sectionEls.name && data.database != null) sectionEls.name.value = data.database;
  }

  function fillForm(cfg) {
    if (!cfg) return;
    if (el.cfgEnabled) el.cfgEnabled.value = cfg.enabled ? '1' : '0';
    var role = cfg.selfRole === 'standby' ? 'standby' : 'primary';
    var radios = document.querySelectorAll('input[name="cfgSelfRole"]');
    radios.forEach(function (r) { r.checked = (r.value === role); });
    if (cfg.primary) {
      fillSection(fields.pri.ssh, cfg.primary.ssh);
      fillSection(fields.pri.db,  cfg.primary.db);
    }
    if (cfg.standby) {
      fillSection(fields.stb.ssh, cfg.standby.ssh);
      fillSection(fields.stb.db,  cfg.standby.db);
    }
    loaded = true;
  }

  function readSection(sectionEls, isDb) {
    var out = {
      host: (sectionEls.host.value || '').trim(),
      port: Number(sectionEls.port.value) || (isDb ? 3306 : 22),
      user: (sectionEls.user.value || '').trim(),
      // 密码：留空 → 用 '***' 让后端保持原值；非空 → 直接覆盖
      password: sectionEls.pwd.value === '' ? '***' : sectionEls.pwd.value,
    };
    if (isDb && sectionEls.name) out.database = (sectionEls.name.value || '').trim();
    return out;
  }

  function readForm() {
    var role = 'primary';
    var radios = document.querySelectorAll('input[name="cfgSelfRole"]');
    radios.forEach(function (r) { if (r.checked) role = r.value; });
    return {
      enabled: el.cfgEnabled.value === '1',
      selfRole: role,
      primary: {
        ssh: readSection(fields.pri.ssh, false),
        db:  readSection(fields.pri.db,  true),
      },
      standby: {
        ssh: readSection(fields.stb.ssh, false),
        db:  readSection(fields.stb.db,  true),
      },
    };
  }

  function renderStatusBox(status) {
    if (!el.statusBox) return;
    if (!status) { el.statusBox.textContent = '等待加载…'; return; }
    var lines = [];
    lines.push('总开关：' + (status.enabled ? '已启用' : '未启用'));
    lines.push('当前角色：' + (status.selfRole === 'primary' ? '主机' : '备机'));
    if (status.peer) {
      lines.push('对端 SSH：' + (status.peer.sshHost || '-') + ':' + (status.peer.sshPort || '-'));
      lines.push('对端 DB ：' + (status.peer.dbHost || '-') + ':' + (status.peer.dbPort || '-')
        + '/' + (status.peer.dbDatabase || '-'));
    }
    if (status.ssh) {
      lines.push('SSH 状态：' + status.ssh.status + (status.ssh.lastError ? '（' + status.ssh.lastError + '）' : ''));
    }
    if (status.db) {
      lines.push('DB 状态：' + (status.db.connected ? '已连接' : (status.db.autoRetrying
        ? '后台重试中（已 ' + (status.db.autoRetryCount || 0) + ' 次）'
        : (status.db.lastError || '未连接'))));
    }
    if (status.heartbeat && status.heartbeat.ts) {
      lines.push('最近心跳：' + status.heartbeat.ts
        + '（IP=' + (status.heartbeat.ipOk ? '通' : '不通')
        + '，DB 端口=' + (status.heartbeat.dbPortOk ? '通' : '不通') + '）');
    }
    el.statusBox.textContent = lines.join('\n');
  }

  async function loadConfig() {
    setSaveHint('加载中…');
    try {
      var resp = await fetch('/api/ha/config');
      var data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data && data.message || ('HTTP ' + resp.status));
      fillForm(data.config);
      setSaveHint('已加载', '#a7f3d0');
    } catch (err) {
      setSaveHint('加载失败：' + err.message, '#fca5a5');
    }
    refreshStatus();
  }

  async function refreshStatus() {
    try {
      var resp = await fetch('/api/ha/status');
      var data = await resp.json();
      if (resp.ok && data.ok) renderStatusBox(data.status);
    } catch (_e) {}
  }

  async function doSave() {
    var body = readForm();
    if (!body.primary.ssh.host || !body.primary.ssh.user) {
      setSaveHint('主服务器 SSH 的 IP/账号必填', '#fca5a5'); return;
    }
    if (!body.standby.ssh.host || !body.standby.ssh.user) {
      setSaveHint('备服务器 SSH 的 IP/账号必填', '#fca5a5'); return;
    }
    el.btnSave.disabled = true;
    setSaveHint('保存中…');
    try {
      var resp = await fetch('/api/ha/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data && data.message || ('HTTP ' + resp.status));
      fillForm(data.config);
      renderStatusBox(data.status);
      // 立即把最新 status 推到 Bus，让顶部开关文字 / 角色标签等监听者刷新
      // （ws 的 snapshot 也会推一次，这里属于双保险，避免界面残留旧状态）
      if (window.HaBus && typeof window.HaBus.emit === 'function') {
        window.HaBus.emit('snapshot', data.status);
      }
      setSaveHint('保存成功，已应用', '#a7f3d0');
    } catch (err) {
      setSaveHint('保存失败：' + err.message, '#fca5a5');
    } finally {
      el.btnSave.disabled = false;
    }
  }

  async function doRestart() {
    if (!confirm('立即重置对端 SSH 长连接和 DB 连接池？')) return;
    el.btnRestart.disabled = true;
    setSaveHint('重置中…');
    try {
      var resp = await fetch('/api/ha/restart', { method: 'POST' });
      var data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data && data.message || ('HTTP ' + resp.status));
      renderStatusBox(data.status);
      setSaveHint('已重置', '#a7f3d0');
    } catch (err) {
      setSaveHint('重置失败：' + err.message, '#fca5a5');
    } finally {
      el.btnRestart.disabled = false;
    }
  }

  async function testSsh(side) {
    var s = fields[side].ssh;
    var hint = side === 'pri' ? el.hintPriSsh : el.hintStbSsh;
    var pwd = s.pwd.value;
    var sideName = side === 'pri' ? 'primary' : 'standby';
    // 密码为空 → 后端沿用已保存的密码（与「保存配置」时 *** 占位语义一致）
    var sendPwd = pwd === '' ? '***' : pwd;
    setHint(hint, '测试中…');
    try {
      var resp = await fetch('/api/ha/test/ssh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side: sideName,
          host: (s.host.value || '').trim(),
          port: Number(s.port.value) || 22,
          user: (s.user.value || '').trim(),
          password: sendPwd,
        }),
      });
      var data = await resp.json();
      setHint(hint, (data.ok ? '✓ ' : '✗ ') + (data.message || ''), data.ok ? '#a7f3d0' : '#fca5a5');
    } catch (err) {
      setHint(hint, '请求失败：' + err.message, '#fca5a5');
    }
  }

  async function testDb(side) {
    var d = fields[side].db;
    var hint = side === 'pri' ? el.hintPriDb : el.hintStbDb;
    var pwd = d.pwd.value;
    var sideName = side === 'pri' ? 'primary' : 'standby';
    // 密码为空 → 后端沿用已保存的密码
    var sendPwd = pwd === '' ? '***' : pwd;
    setHint(hint, '测试中…');
    try {
      var resp = await fetch('/api/ha/test/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side: sideName,
          host: (d.host.value || '').trim(),
          port: Number(d.port.value) || 3306,
          user: (d.user.value || '').trim(),
          password: sendPwd,
          database: (d.name.value || '').trim(),
        }),
      });
      var data = await resp.json();
      setHint(hint, (data.ok ? '✓ ' : '✗ ') + (data.message || ''), data.ok ? '#a7f3d0' : '#fca5a5');
    } catch (err) {
      setHint(hint, '请求失败：' + err.message, '#fca5a5');
    }
  }

  el.btnSave    && el.btnSave.addEventListener('click', doSave);
  el.btnReload  && el.btnReload.addEventListener('click', loadConfig);
  el.btnRestart && el.btnRestart.addEventListener('click', doRestart);
  el.btnTestPriSsh && el.btnTestPriSsh.addEventListener('click', function () { testSsh('pri'); });
  el.btnTestPriDb  && el.btnTestPriDb.addEventListener('click',  function () { testDb('pri'); });
  el.btnTestStbSsh && el.btnTestStbSsh.addEventListener('click', function () { testSsh('stb'); });
  el.btnTestStbDb  && el.btnTestStbDb.addEventListener('click',  function () { testDb('stb'); });

  // ---------- MySQL 调优区域 ----------
  var tuneEl = {
    kv: $('tuneKv'),
    hint: $('tuneHint'),
    btnBoth: $('btnTuneBoth'),
    btnPrimary: $('btnTunePrimary'),
    btnStandby: $('btnTuneStandby'),
    btnRefresh: $('btnTuneRefresh'),
  };

  function escHt(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function tuneRow(label, info, target) {
    var live = info && info.ok ? (info.live == null ? '?' : info.live) : '?';
    var disk = info && info.ok ? (info.onDisk == null ? '?' : info.onDisk) : '?';
    var ok = info && info.ok && Number(live) === Number(target);
    var status = !info ? '<span class="pill warn">未探测</span>'
      : !info.ok ? '<span class="pill err">探测失败</span>'
      : ok ? '<span class="pill ok">已达标</span>'
      : '<span class="pill warn">需调优</span>';
    var detail = info && info.ok
      ? '在线=' + live + ' / 落盘=' + disk
      : (info && info.message ? info.message : '');
    return '<div class="kv-row"><span class="k">' + escHt(label) + '</span>' +
      '<span class="v">' + status + ' <span style="color:#94a3b8;font-family:ui-monospace,monospace;font-size:11px">' + escHt(detail) + '</span></span>' +
      '<span></span></div>';
  }

  function setTuneHint(text, color) {
    if (!tuneEl.hint) return;
    tuneEl.hint.textContent = text || '';
    tuneEl.hint.style.color = color || '#94a3b8';
    if (text) setTimeout(function () {
      if (tuneEl.hint && tuneEl.hint.textContent === text) tuneEl.hint.textContent = '';
    }, 6000);
  }

  function setTuneBusy(busy) {
    [tuneEl.btnBoth, tuneEl.btnPrimary, tuneEl.btnStandby, tuneEl.btnRefresh].forEach(function (b) {
      if (b) b.disabled = !!busy;
    });
  }

  async function loadTuneVars() {
    if (!tuneEl.kv) return;
    setTuneHint('探测中…');
    tuneEl.kv.innerHTML = '<div class="kv-row"><span class="k">主机 mysqld</span><span class="v" style="color:#64748b">…</span><span></span></div>' +
      '<div class="kv-row"><span class="k">备机 mysqld</span><span class="v" style="color:#64748b">…</span><span></span></div>';
    try {
      var resp = await fetch('/api/ha/mysql-vars');
      var data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data && data.message || ('HTTP ' + resp.status));
      var d = data.data;
      var rows = [];
      rows.push(tuneRow('主机 mysqld', d.primary, d.target));
      rows.push(tuneRow('备机 mysqld', d.standby, d.target));
      rows.push('<div class="kv-row"><span class="k">推荐值</span><span class="v" style="font-family:ui-monospace,monospace">' + d.target + '</span><span></span></div>');
      tuneEl.kv.innerHTML = rows.join('');
      setTuneHint('已探测', '#a7f3d0');
    } catch (err) {
      tuneEl.kv.innerHTML = '<div class="kv-row"><span class="k">探测失败</span><span class="v err">' + escHt(err.message) + '</span><span></span></div>';
      setTuneHint('探测失败：' + err.message, '#fca5a5');
    }
  }

  async function doTune(side) {
    var label = side === 'both' ? '主+备' : (side === 'primary' ? '主机' : '备机');
    if (!confirm(
      '即将对【' + label + '】执行 MySQL 调优：\n\n' +
      '1) 备份 /etc/my.cnf\n' +
      '2) 改写 max_connect_errors = 100000\n' +
      '3) 重启 mysqld（dcim 业务会断 1-3 秒）\n\n' +
      '继续？'
    )) return;
    setTuneBusy(true);
    setTuneHint('调优中（请看右侧消息窗口实时进度）…');
    try {
      var resp = await fetch('/api/ha/tune-mysql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side: side, restart: true }),
      });
      var data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data && data.message || ('HTTP ' + resp.status));
      setTuneHint('调优完成', '#a7f3d0');
      await loadTuneVars();
    } catch (err) {
      setTuneHint('调优失败：' + err.message, '#fca5a5');
    } finally {
      setTuneBusy(false);
    }
  }

  tuneEl.btnBoth     && tuneEl.btnBoth.addEventListener('click',     function () { doTune('both'); });
  tuneEl.btnPrimary  && tuneEl.btnPrimary.addEventListener('click',  function () { doTune('primary'); });
  tuneEl.btnStandby  && tuneEl.btnStandby.addEventListener('click',  function () { doTune('standby'); });
  tuneEl.btnRefresh  && tuneEl.btnRefresh.addEventListener('click',  loadTuneVars);

  // 弹窗打开时顺手探一次（不阻塞 loadConfig）
  el.btnOpen && el.btnOpen.addEventListener('click', function () { setTimeout(loadTuneVars, 200); });

  // 暴露给顶部「总开关」按钮：不打开弹窗，直接切换 enabled 并保存
  window.HaConfig = {
    toggleEnabled: async function () {
      if (!loaded) await loadConfig();
      el.cfgEnabled.value = (el.cfgEnabled.value === '1') ? '0' : '1';
      doSave();
    },
  };

  // ESC 关闭弹窗
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && el.modal && el.modal.classList.contains('open')) closeModal();
  });

  // 首次进入页面就把状态拉一次（不打开弹窗），便于 status-box 显示
  refreshStatus();
})();
