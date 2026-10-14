(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const names = { 'feature_flags.json': '功能开关', 'services.json': '采集服务', 'http_services.json': 'HTTP服务', 'crontab_tasks.json': '定时任务', 'logging.json': '日志设置', 'runtime_env.json': '运行参数', 'sms_gateways.json': '短信网关', 'i18n_zh_cn.json': '消息文本', 'architecture_boundaries.json': '架构边界', 'legacy_module_map.json': '旧模块映射', 'service_launchers.json': '服务入口' };
  const labels = { enabled:'启用', modbus:'Modbus采集', snmp:'SNMP采集', snmptrap:'SNMP Trap采集', mqtt:'MQTT采集', slave_http_receive:'接收从机数据', http_publish:'HTTP发布', snmp_publish:'SNMP发布', mqtt_publish:'MQTT发布', iec104_publish:'IEC104发布', slave_http_push:'从机HTTP推送', door_device:'门禁设备', sms_gateway_http:'HTTP短信网关', sms_gateway_modem:'短信猫网关', email_gateway:'邮件网关', weixin_gateway:'微信网关', gb28181:'GB28181视频', interpreter_engine:'协议解释引擎', legacy_adapter:'旧协议适配', protocol_plugins:'协议插件', alarm_trigger:'告警触发', alarm_push:'告警推送', crontab_once:'定时任务', service_monitor:'服务监测', host:'监听地址', port:'端口', poll_interval_sec:'轮询周期（秒）', retention_days:'日志保留天数', timeout_seconds:'超时（秒）', verify_tls:'校验证书', debug_log:'调试日志', auto_backfill_enabled:'自动补算', auto_backfill_days:'补算天数', time:'执行时间', minute:'执行分钟', cycle:'执行周期', default_provider:'默认网关', level_min:'最低日志级别', split_by_service:'按服务分日志', split_by_module:'按模块分日志', write_error_file:'写入错误日志', write_default_file:'写入默认日志', noisy_to_debug:'噪声日志降为调试', main_collector:'主采集服务', startup_once_crontab:'定时任务服务', http_server:'HTTP服务', monitor:'监测服务', iec104_server:'IEC104服务', snmp_server:'SNMP服务', snmp_trap:'Trap服务', zlm_service:'视频服务' };
  let current = null, connection = null, busy = false;
  const tracker = window.createDcimChangeTracker();
  let checking = null;
  function changedCurrent() { return current && tracker.changes().some(item => item.name === current.name); }
  function changeNotice(error) {
    const items = tracker.changes();
    const box = $('fileChanges');
    box.hidden = !items.length && !error;
    box.textContent = (items.length ? '配置文件发生变化：' + items.map(item => item.name + '（' + item.kind + '）').join('、') + '。请点击“刷新”读取最新配置；未保存编辑已保留。' : '') + (error ? ' 变化检查失败，将自动重试：' + error : '');
  }
  function checkFiles() {
    if (busy || checking || document.hidden || !connection || !connection.hasPassword) return;
    checking = (async () => {
      try { tracker.observe((await api('/snapshot')).versions); changeNotice(); }
      catch (err) { changeNotice(err.name === 'AbortError' ? '请求超时' : err.message); }
      finally { checking = null; update(); }
    })();
  }
  Object.assign(labels, { acquisition:'数据采集', publish:'数据发布', alarm:'告警', device_comm:'设备通信', parser:'协议解析', platform:'平台', global:'全局', services:'服务', tasks:'任务', providers:'网关', collector_runtime_switches:'采集诊断', redis_buffer_switches:'Redis缓冲开关', redis_buffer_params:'Redis缓冲参数', snmp_collector_params:'SNMP采集参数', tcp_collector_params:'TCP采集参数', alarm_runtime_params:'告警运行参数', zlm_runtime_params:'视频运行参数', smspush_worker:'短信队列', noticepush_worker:'通知队列', daily_bundle:'每日汇总', energy_hourly_fact:'每小时能耗', DCIM_REDIS_HOST:'Redis地址', DCIM_REDIS_PORT:'Redis端口', DCIM_REDIS_DB:'Redis数据库编号', ENABLE_REDIS_BUFFER:'启用Redis缓冲', ENABLE_REDIS_FALLBACK_DB:'Redis故障时回退数据库', ENABLE_REDIS_PUBLISH_READ:'发布时读取Redis', SNMP_BULK_ENABLED:'启用SNMP批量采集', SNMP_DIAG_ENABLED:'启用SNMP诊断', SNMP_IP_GROUP_ENABLED:'按IP分组采集', SNMP_TIMEOUT_SEC:'SNMP超时（秒）', COLLECTOR_PERF_DIAG_ENABLED:'启用性能诊断', ALARM_TYPE5_SNAPSHOT_LOG_ENABLED:'类型5告警快照日志', restart_window_seconds:'重启统计窗口（秒）', max_restarts_in_window:'窗口内最大重启次数', monitor_interval_seconds:'监控周期（秒）', restart_backoff_seconds:'重启退避时间（秒，JSON数组）' });
  const changes = new Map();
  function notice(text) { $('notice').textContent = text; }
  async function api(url, method, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55000);
    try {
      const res = await fetch('/api/dcim-settings' + url, { cache: 'no-store', method: method || 'GET', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.message || '操作失败');
      return json.data;
    } finally { clearTimeout(timer); }
  }
  function update() {
    $('save').disabled = busy || !changes.size || changedCurrent();
    $('discard').disabled = busy || !changes.size;
    $('dirty').textContent = changes.size ? changes.size + ' 项待保存' : '';
    ['reload','restart','connection'].forEach(id => { $(id).disabled = busy; });
    document.querySelectorAll('#fields input,#fields textarea,#fields select').forEach(input => { input.disabled = busy || !current || current.readonly || input.dataset.readonly === 'true'; });
  }
  async function task(fn) {
    if (busy) return;
    busy = true; update();
    try { if (checking) await checking; await fn(); } catch (err) { notice(err.name === 'AbortError' ? '请求超时，请刷新确认目标状态' : err.message); }
    finally { busy = false; update(); }
  }
  function allowDiscard() { return !changes.size || window.confirm('有未保存的修改，是否放弃？'); }
  function render() {
    $('fields').replaceChildren();
    if (!current) return;
    $('fileTitle').textContent = names[current.name] || current.name;
    const query = $('search').value.toLowerCase();
    const groups = new Map();
    current.fields.forEach(field => {
      const key = field.path.join('.');
      const label = labels[field.path[field.path.length - 1]] || field.path[field.path.length - 1];
      if (query && !(key + label).toLowerCase().includes(query)) return;
      const group = field.path.slice(0, -1).join(' / ') || '全局';
      if (!groups.has(group)) {
        const section = document.createElement('section'); section.className = 'group';
        const title = document.createElement('h3'); title.textContent = group.split(' / ').map(k => labels[k] || k).join(' / ');
        section.append(title); $('fields').append(section); groups.set(group, section);
      }
      const row = document.createElement('div'); row.className = 'row';
      const caption = document.createElement('label'); caption.textContent = label;
      const hint = document.createElement('small'); hint.textContent = key; caption.append(hint);
      const value = changes.has(key) ? changes.get(key).value : field.value;
      let input = document.createElement(field.type === 'array' || (field.type === 'string' && String(value).length > 100) ? 'textarea' : 'input');
      input.id = 'field-' + current.fields.indexOf(field); caption.htmlFor = input.id;
      if (field.type === 'boolean') {
        input.type = 'checkbox'; input.setAttribute('role','switch'); input.checked = value;
        const wrap = document.createElement('div'); wrap.className = 'switch';
        const state = document.createElement('span'); state.textContent = value ? '已开启' : '已关闭';
        input.addEventListener('change', () => { state.textContent = input.checked ? '已开启' : '已关闭'; });
        wrap.append(input, state); row.append(caption, wrap);
      } else {
        if (input.tagName === 'INPUT') input.type = field.secret ? 'password' : field.type === 'number' ? 'number' : 'text';
        if (field.type === 'number') { input.min = '0'; input.step = 'any'; }
        input.value = field.type === 'array' ? JSON.stringify(value) : value == null ? '' : value;
        if (field.secret) { input.placeholder = field.hasValue ? '已设置，留空保持' : '未设置'; input.autocomplete = 'new-password'; }
        row.append(caption,input);
      }
      input.dataset.readonly = String(field.type === 'null');
      input.disabled = current.readonly || busy || field.type === 'null';
      input.addEventListener('input', () => {
        let next = input.value;
        input.setCustomValidity('');
        if (field.type === 'boolean') next = input.checked;
        if (field.type === 'number') next = input.value === '' ? NaN : Number(input.value);
        if (field.type === 'array') {
          try { next = JSON.parse(input.value); if (!Array.isArray(next)) throw Error(); }
          catch (_) { input.setCustomValidity('请输入JSON数组'); }
        }
        if (JSON.stringify(next) === JSON.stringify(field.value) || (field.secret && next === '')) changes.delete(key);
        else changes.set(key, { path: field.path, value: next });
        update();
      });
      groups.get(group).append(row);
    });
    if (!groups.size) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '没有匹配的配置项'; $('fields').append(empty); }
    update();
  }
  async function loadFile(name) {
    current = await api('/file?name=' + encodeURIComponent(name)); changes.clear(); render();
    tracker.accept(current.name, current.revision); changeNotice(); update();
    document.querySelectorAll('#files button').forEach(button => button.classList.toggle('active', button.dataset.name === name));
    notice(current.readonly ? '程序结构配置，只读' : '已读取配置；保存后需重启采集服务确认生效');
  }
  async function loadFiles() {
    tracker.reset((await api('/snapshot')).versions); changeNotice();
    const result = await api('/files'); $('files').replaceChildren();
    result.files.forEach(file => {
      const button = document.createElement('button'); button.dataset.name = file.name;
      button.textContent = names[file.name] || file.name;
      const small = document.createElement('small'); small.textContent = file.name + (!file.exists ? '（缺失）' : file.readonly ? '（只读）' : ''); button.append(small);
      button.disabled = !file.exists;
      button.onclick = () => { if (!busy && allowDiscard()) task(() => loadFile(file.name)); };
      $('files').append(button);
    });
    const first = result.files.find(f => f.exists && (!current || f.name === current.name)) || result.files.find(f => f.exists);
    if (first) await loadFile(first.name); else notice('未找到支持的配置文件，请检查目标目录');
  }
  $('search').oninput = render;
  $('reload').onclick = () => { if (allowDiscard()) task(loadFiles); };
  $('discard').onclick = () => { if (allowDiscard()) { changes.clear(); render(); } };
  $('save').onclick = () => {
    if (changedCurrent()) { changeNotice(); return; }
    for (const input of document.querySelectorAll('#fields input,#fields textarea')) {
      if (!input.reportValidity()) { notice('请修正无效字段'); return; }
    }
    task(async () => {
    if (changedCurrent()) { changeNotice(); return; }
    const result = await api('/file','PUT',{ name: current.name, revision: current.revision, changes: Array.from(changes.values()) });
    current = result; tracker.accept(current.name, current.revision); changeNotice(); changes.clear(); render(); notice('已保存并备份原配置；待重启采集服务生效');
    });
  };
  $('restart').onclick = () => {
    if (changes.size) return notice('请先保存或放弃当前修改');
    if (confirm('重启DCIM采集服务会短暂中断采集与告警处理，确认继续？')) task(async () => {
      await api('/restart','POST',{confirm:true}); notice('采集服务已重启，状态 active；请核对业务运行情况');
    });
  };
  $('connection').onclick = () => {
    for (const input of $('connectionForm').querySelectorAll('input')) input.value = input.name === 'password' ? '' : connection[input.name];
    $('connectionDialog').showModal();
  };
  $('cancelConnection').onclick = () => $('connectionDialog').close();
  $('connectionForm').onsubmit = event => {
    event.preventDefault(); if (!allowDiscard()) return;
    const data = Object.fromEntries(new FormData(event.target));
    task(async () => {
      connection = await api('/connection','PUT',data); $('connectionDialog').close(); $('connectionForm').elements.password.value = '';
      $('target').textContent = connection.host + ' · ' + connection.directory; current = null; tracker.reset({}); changeNotice(); changes.clear(); render(); await loadFiles();
    });
  };
  task(async () => {
    connection = await api('/connection'); $('target').textContent = connection.host + ' · ' + connection.directory;
    if (connection.hasPassword) await loadFiles(); else notice('请配置目标SSH连接');
  });
  window.addEventListener('beforeunload', event => { if (changes.size) { event.preventDefault(); event.returnValue = ''; } });
  setInterval(checkFiles, 15000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) checkFiles(); });
})();
