// 「连接信息」弹窗：读/写 /api/proto-conv/config，登录、连接测试。
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Mon = window.PcMonitor || { append: function () {}, info: function () {}, warn: function () {}, error: function () {} };

  var el = {
    btnOpen: $('btnOpenConfig'),
    btnClose: $('btnCloseConfig'),
    btnLogin: $('btnLogin'),
    btnTest: $('btnTest'),
    btnToggleProtocol: $('btnToggleProtocol'),
    sessionTag: $('sessionTag'),
    modal: $('configModal'),
    baseUrl: $('cfgBaseUrl'),
    userName: $('cfgUserName'),
    passWord: $('cfgPassWord'),
    userLsh: $('cfgUserLsh'),
    timeoutMs: $('cfgTimeoutMs'),
    pathMap: $('cfgPathMap'),
    dbType: $('cfgDbType'),
    dbHost: $('cfgDbHost'),
    dbPort: $('cfgDbPort'),
    dbUser: $('cfgDbUser'),
    dbPwd: $('cfgDbPwd'),
    dbName: $('cfgDbName'),
    btnSave: $('btnCfgSave'),
    btnDbTest: $('btnCfgDbTest'),
    btnReload: $('btnCfgReload'),
    saveHint: $('cfgSaveHint'),
  };

  var current = null; // 最近一次从后端拿到的 config（password 字段为 ***）

  function defaultDbPort(type) {
    if (type === 'opengauss') return 5432;
    if (type === 'dm') return 5236;
    return 3333;
  }

  function setHint(node, text, cls) {
    if (!node) return;
    node.textContent = text || '';
    node.className = 'hint' + (cls ? ' ' + cls : '');
  }

  function setSession(text, cls) {
    if (!el.sessionTag) return;
    el.sessionTag.textContent = text;
    el.sessionTag.className = 'role-tag' + (cls ? ' ' + cls : '');
  }

  function open() {
    el.modal.classList.add('open');
    el.modal.setAttribute('aria-hidden', 'false');
    loadConfig();
  }
  function close() {
    el.modal.classList.remove('open');
    el.modal.setAttribute('aria-hidden', 'true');
  }

  function fillForm(cfg) {
    current = cfg || {};
    el.baseUrl.value   = current.baseUrl   || '';
    el.userName.value  = current.userName  || '';
    el.passWord.value  = ''; // 显示空，提交时为空表示保持原值
    el.passWord.placeholder = current.hasPassword ? '已保存（留空保持原值）' : '留空保持原值';
    el.userLsh.value   = current.userLsh   || '';
    el.timeoutMs.value = current.timeoutMs || 8000;
    try {
      el.pathMap.value = JSON.stringify(current.pathMap || {}, null, 2);
    } catch (_e) { el.pathMap.value = '{}'; }
    var db = current.dcimDb || {};
    var dbType = db.type || 'mysql';
    if (el.dbType) el.dbType.value = dbType;
    if (el.dbHost) el.dbHost.value = db.host || '';
    if (el.dbPort) {
      el.dbPort.value = db.port || defaultDbPort(dbType);
      el.dbPort.dataset.dbType = dbType;
    }
    if (el.dbUser) el.dbUser.value = db.user || '';
    if (el.dbPwd) {
      el.dbPwd.value = '';
      el.dbPwd.placeholder = db.hasPassword ? '已保存（留空保持原值）' : '留空保持原值';
    }
    if (el.dbName) el.dbName.value = db.database || 'dcim';
    syncProtocolBtn(current.baseUrl);
  }

  // 顶栏「协议: HTTPS/HTTP」按钮文字与样式同步
  function syncProtocolBtn(baseUrl) {
    if (!el.btnToggleProtocol) return;
    var proto = '?';
    try {
      var u = new URL(String(baseUrl || ''));
      proto = (u.protocol === 'https:') ? 'HTTPS' : (u.protocol === 'http:' ? 'HTTP' : '?');
    } catch (_e) {}
    el.btnToggleProtocol.textContent = '协议: ' + proto;
    el.btnToggleProtocol.title = '当前 baseUrl: ' + (baseUrl || '(未配置)') + '\n点击切换 HTTPS ↔ HTTP';
  }

  // 切换 baseUrl 协议头并保存
  async function toggleProtocol() {
    var cfg = current;
    if (!cfg || !cfg.baseUrl) {
      Mon.warn('协议切换：请先在「连接信息」里配置 baseUrl');
      return;
    }
    var u;
    try { u = new URL(cfg.baseUrl); }
    catch (e) {
      Mon.error('协议切换失败：baseUrl 解析错 ' + e.message);
      return;
    }
    var oldProto = u.protocol; // 'https:' / 'http:'
    var newProto = (oldProto === 'https:') ? 'http:' : 'https:';
    u.protocol = newProto;
    var newBaseUrl = u.toString().replace(/\/$/, '');
    el.btnToggleProtocol.disabled = true;
    Mon.info('切换协议: ' + oldProto + '//... → ' + newProto + '//...');
    try {
      var r = await fetch('/api/proto-conv/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: newBaseUrl,
          userName: cfg.userName,
          userLsh: cfg.userLsh,
          timeoutMs: cfg.timeoutMs,
          pathMap: cfg.pathMap || {},
        }),
      }).then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '保存失败');
      fillForm(r.config);
      window.PcConfig._cfg = r.config;
      window.PcBus && window.PcBus.emit('config-loaded', r.config);
      Mon.info('协议已切换为 ' + newProto.replace(':', '').toUpperCase() + '，新 baseUrl: ' + r.config.baseUrl);
    } catch (err) {
      Mon.error('协议切换失败: ' + err.message);
    } finally {
      el.btnToggleProtocol.disabled = false;
    }
  }

  async function loadConfig() {
    setHint(el.saveHint, '加载中…');
    try {
      var r = await fetch('/api/proto-conv/config').then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '读取失败');
      fillForm(r.config);
      setHint(el.saveHint, '已加载', 'ok');
      window.PcConfig._cfg = r.config;
      window.PcBus && window.PcBus.emit('config-loaded', r.config);
    } catch (err) {
      setHint(el.saveHint, '加载失败：' + err.message, 'err');
      Mon.error('读取连接信息失败：' + err.message);
    }
  }

  async function doSave() {
    var pathMap = {};
    var raw = (el.pathMap.value || '').trim();
    if (raw) {
      try { pathMap = JSON.parse(raw); }
      catch (e) {
        setHint(el.saveHint, 'pathMap JSON 解析失败：' + e.message, 'err');
        return;
      }
      if (typeof pathMap !== 'object' || Array.isArray(pathMap)) {
        setHint(el.saveHint, 'pathMap 必须是 JSON 对象', 'err');
        return;
      }
    }
    var body = {
      baseUrl: (el.baseUrl.value || '').trim(),
      userName: (el.userName.value || '').trim(),
      userLsh: (el.userLsh.value || '').trim(),
      timeoutMs: Number(el.timeoutMs.value) || 8000,
      pathMap: pathMap,
    };
    var pwd = el.passWord.value;
    if (pwd && pwd !== '') body.passWord = pwd;
    // dcimDb 可选
    var db = readDbForm();
    var dbPwd = el.dbPwd && el.dbPwd.value;
    if (dbPwd && dbPwd !== '') db.password = dbPwd;
    body.dcimDb = db;
    if (!body.baseUrl) { setHint(el.saveHint, 'baseUrl 必填', 'err'); return; }
    if (!body.userName) { setHint(el.saveHint, '账号必填', 'err'); return; }

    el.btnSave.disabled = true;
    setHint(el.saveHint, '保存中…');
    try {
      var r = await fetch('/api/proto-conv/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '保存失败');
      fillForm(r.config);
      window.PcConfig._cfg = r.config;
      window.PcBus && window.PcBus.emit('config-loaded', r.config);
      setHint(el.saveHint, '保存成功，已应用', 'ok');
      Mon.info('连接信息已保存：' + r.config.baseUrl);
    } catch (err) {
      setHint(el.saveHint, '保存失败：' + err.message, 'err');
      Mon.error('保存连接信息失败：' + err.message);
    } finally {
      el.btnSave.disabled = false;
    }
  }

  function readDbForm() {
    return {
      type: (el.dbType && el.dbType.value) || 'mysql',
      host: (el.dbHost && el.dbHost.value || '').trim(),
      port: Number(el.dbPort && el.dbPort.value) || defaultDbPort((el.dbType && el.dbType.value) || 'mysql'),
      user: (el.dbUser && el.dbUser.value || '').trim(),
      database: (el.dbName && el.dbName.value || '').trim() || 'dcim',
    };
  }

  async function testDbConnection() {
    var db = readDbForm();
    var dbPwd = el.dbPwd && el.dbPwd.value;
    if (dbPwd && dbPwd !== '') db.password = dbPwd;
    el.btnDbTest.disabled = true;
    setHint(el.saveHint, '数据库连接测试中…');
    Mon.info('→ 测试 ' + db.type + ' 数据库连接 ' + db.host + ':' + db.port + '/' + db.database);
    try {
      var r = await fetch('/api/proto-conv/test-dcim-db', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dcimDb: db }),
      }).then(function (r) { return r.json(); });
      if (!r.ok) throw new Error(r.message || '连接失败');
      setHint(el.saveHint, r.message || '数据库连接成功', 'ok');
      Mon.info('← ' + (r.message || '数据库连接成功'));
    } catch (err) {
      setHint(el.saveHint, '数据库连接失败：' + err.message, 'err');
      Mon.error('× 数据库连接失败：' + err.message);
    } finally {
      el.btnDbTest.disabled = false;
    }
  }

  async function doLogin() {
    el.btnLogin.disabled = true;
    setSession('登录中…', 'warn');
    Mon.info('→ POST LoginKey （Base64 账号）');
    var t0 = Date.now();
    try {
      var r = await fetch('/api/proto-conv/login', { method: 'POST' }).then(function (r) { return r.json(); });
      var dt = Date.now() - t0;
      if (r.ok) {
        Mon.info('← LoginKey HTTP ' + r.status + ' ' + dt + 'ms ' + JSON.stringify(r.data || true).slice(0, 200));
        setSession('已登录', 'ok');
        if (r.userLsh) {
          Mon.info('UserLsh = ' + r.userLsh + '（已写入配置，调用时自动带）');
        }
      } else {
        Mon.error('× LoginKey 失败 status=' + r.status + ' ' + (r.message || JSON.stringify(r.data || '').slice(0, 200)));
        setSession('登录失败', 'err');
      }
    } catch (err) {
      Mon.error('× LoginKey 网络异常：' + err.message);
      setSession('登录异常', 'err');
    } finally {
      el.btnLogin.disabled = false;
    }
  }

  async function doTest() {
    el.btnTest.disabled = true;
    Mon.info('→ 探活 baseUrl');
    try {
      var r = await fetch('/api/proto-conv/test-connection', { method: 'POST' }).then(function (r) { return r.json(); });
      if (r.ok) {
        Mon.info('← 连通：' + r.message);
      } else {
        Mon.error('× 不通：' + (r.message || JSON.stringify(r)));
      }
    } catch (err) {
      Mon.error('× 测试异常：' + err.message);
    } finally {
      el.btnTest.disabled = false;
    }
  }

  el.btnOpen && el.btnOpen.addEventListener('click', open);
  el.btnClose && el.btnClose.addEventListener('click', close);
  el.dbType && el.dbType.addEventListener('change', function () {
    if (!el.dbPort) return;
    var previousType = el.dbPort.dataset.dbType || 'mysql';
    var nextType = el.dbType.value || 'mysql';
    var currentPort = Number(el.dbPort.value);
    if (!currentPort || currentPort === defaultDbPort(previousType)) {
      el.dbPort.value = defaultDbPort(nextType);
    }
    el.dbPort.dataset.dbType = nextType;
  });
  el.btnSave && el.btnSave.addEventListener('click', doSave);
  el.btnDbTest && el.btnDbTest.addEventListener('click', testDbConnection);
  el.btnReload && el.btnReload.addEventListener('click', loadConfig);
  el.btnLogin && el.btnLogin.addEventListener('click', doLogin);
  el.btnTest && el.btnTest.addEventListener('click', doTest);
  el.btnToggleProtocol && el.btnToggleProtocol.addEventListener('click', toggleProtocol);
  // ESC 关闭
  el.modal && el.modal.addEventListener('click', function (e) {
    if (e.target === el.modal) close();
  });

  window.PcConfig = {
    open: open,
    close: close,
    reload: loadConfig,
    _cfg: null,
    getCfg: function () { return window.PcConfig._cfg; },
  };

  // 启动时静默拉一次配置
  loadConfig();
})();
