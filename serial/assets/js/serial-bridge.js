(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const drawer = $('serial-bridge-drawer');
  const openButton = $('button-bridge-settings');
  const closeButton = $('button-bridge-close');
  const message = $('serial-bridge-message');
  const table = $('serial-bridge-port-table');
  const basics = $('serial-bridge-basics');
  const communication = $('serial-bridge-communication');
  const saveButton = $('button-bridge-save');
  const scanButton = $('button-bridge-scan');
  const startEnabledButton = $('button-bridge-start-enabled');
  const stopAllButton = $('button-bridge-stop-all');

  if (!drawer || !openButton || !table) return;

  const state = { config: null, status: [], devices: [], startSelected: new Set(), dirty: false, poller: null };
  const baudRates = [2400, 4800, 9600, 19200, 38400, 57600, 115200];
  const portTypes = {
    1: '串口转网口',
    11: '网口转串口',
    0: '真实串口',
  };
  const communicationFields = [
    ['maxConnections', '终端最大连接数', 1, 100, '每个串口允许同时连接的 TCP 客户端数'],
    ['portInitAttempts', '端口最大初始化次数', 2, 1000, '端口异常时允许重新初始化的最大次数'],
    ['pollIntervalMs', '轮询采集间隔 (ms)', 0, 9999, '0 表示关闭自动轮询采集'],
    ['heartbeatTimeoutAttempts', '心跳超时最大次数', 1, 9999, '连续超过此次数后判定异常'],
    ['workerHeartbeatSec', '工作线程心跳检测 (s)', 1, 9999, '超过此间隔未更新心跳即判定超时'],
    ['daemonReportSec', '向守护进程报告 (s)', 1, 9999, '工作线程向守护进程上报状态的周期'],
    ['listenerTimeoutMin', '侦听超时 (min)', 1, 9999, '监听端口无连接时的保护超时'],
    ['clientTimeoutMin', '客户端超时 (min)', 1, 9999, '客户端无数据收发时自动断开'],
    ['serialTimeoutMin', '串口超时 (min)', 1, 9999, '串口长时间无数据时的保护超时'],
    ['dataTimeoutSec', '数据超时 (s)', 1, 9999, '数据链路的超时检查周期'],
  ];

  function escapeText(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char];
    });
  }

  function setMessage(text, kind) {
    message.textContent = text || '';
    message.className = 'serial-bridge-notice' + (kind ? ' ' + kind : '');
    message.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  async function request(url, options) {
    const response = await fetch(url, Object.assign({ headers: { 'Accept': 'application/json' } }, options || {}));
    let data = null;
    try { data = await response.json(); } catch (_err) {}
    if (!response.ok || !data || data.ok === false) throw new Error((data && data.message) || ('请求失败 (' + response.status + ')'));
    return data;
  }

  function statusById(id) {
    return state.status.find(function (item) { return item.id === Number(id); }) || { state: 'stopped', clientCount: 0, error: '' };
  }

  function deviceOptions(selected) {
    const values = state.devices.filter(function (item) {
      return item.openable !== false && !item.busy;
    });
    const selectedDevice = state.devices.find(function (item) { return item.path === selected; });
    if (selectedDevice && selectedDevice.openable !== false && !values.some(function (item) { return item.path === selected; })) {
      values.unshift(selectedDevice);
    }
    const placeholder = '<option value=""' + (!selected ? ' selected' : '') + '>请选择扫描到的可用串口</option>';
    return placeholder + values.map(function (device) {
      const detail = device.uartType ? ' [' + device.uartType + ']' : '';
      return '<option value="' + escapeText(device.path) + '"' + (device.path === selected ? ' selected' : '') + '>' +
        escapeText(device.path + detail + ' · 可用') + '</option>';
    }).join('');
  }

  function selectOptions(values, selected, labels) {
    return values.map(function (value) {
      return '<option value="' + value + '"' + (String(value) === String(selected) ? ' selected' : '') + '>' + escapeText((labels && labels[value]) || value) + '</option>';
    }).join('');
  }

  function endpointValue(port) {
    return Number(port.type) === 11 ? ((port.targetHost || '') + (port.targetPort ? ':' + port.targetPort : '')) : port.listenPort;
  }

  function renderBasics() {
    basics.innerHTML = [
      '<div class="serial-bridge-field"><label for="bridge-com-num">串口数量</label><input id="bridge-com-num" type="number" min="1" max="16" value="' + state.config.comNum + '" /></div>',
      '<div class="serial-bridge-field"><label for="bridge-log-level">日志级别</label><select id="bridge-log-level">' + selectOptions([4, 3, 2, 1, 0], state.config.logLevel, { 4: 'NOLOG', 3: 'ERROR', 2: 'WARN', 1: 'INFO', 0: 'DEBUG' }) + '</select></div>',
      '<div class="serial-bridge-field"><label>配置版本</label><input type="text" readonly value="' + escapeText(state.config.version || '1.0.0') + '" /></div>',
    ].join('');
  }

  function renderCommunication() {
    communication.innerHTML = communicationFields.map(function (field) {
      const key = field[0];
      return '<div class="serial-bridge-field"><label for="bridge-comm-' + key + '" title="' + escapeText(field[4]) + '">' + escapeText(field[1]) + '</label>' +
        '<input id="bridge-comm-' + key + '" data-comm="' + key + '" type="number" min="' + field[2] + '" max="' + field[3] + '" value="' + state.config.communication[key] + '" /></div>';
    }).join('');
  }

  function statusView(port) {
    const status = statusById(port.id);
    const running = status.state === 'running' || status.state === 'starting';
    return {
      state: status.state,
      running: running,
      text: status.error || (status.state === 'running' ? ('运行中 / ' + status.clientCount + ' 客户端') : status.state === 'starting' ? '启动中' : '未启动'),
    };
  }

  function portField(label, control, className) {
    return '<label class="serial-bridge-port-field' + (className ? ' ' + className : '') + '"><span>' + escapeText(label) + '</span>' + control + '</label>';
  }

  function renderPorts() {
    const rows = state.config.ports.slice(0, state.config.comNum).map(function (port) {
      const status = statusView(port);
      const disabled = Number(port.type) === 0 ? ' disabled' : '';
      const endpointLabel = Number(port.type) === 11 ? '目标主机 : 端口' : '侦听端口';
      const endpointPlaceholder = Number(port.type) === 11 ? '192.168.0.50:502' : '8001';
      return '<tr data-port-id="' + port.id + '"><td colspan="12"><article class="serial-bridge-port-card">' +
        '<div class="serial-bridge-port-head"><div class="serial-bridge-port-ident"><strong>串口 ' + port.id + '</strong><label class="serial-bridge-port-enabled"><input data-field="enabled" type="checkbox" aria-label="本次启动串口 ' + port.id + '"' + (state.startSelected.has(port.id) ? ' checked' : '') + ' /><span>本次启动</span></label><label class="serial-bridge-port-enabled"><input data-field="autoStart" type="checkbox" aria-label="开机自启串口 ' + port.id + '"' + (port.autoStart ? ' checked' : '') + ' /><span>开机自启</span></label></div>' +
        '<div class="serial-bridge-port-runtime"><span data-bridge-status class="serial-bridge-status ' + escapeText(status.state) + '" title="' + escapeText(status.text) + '">' + escapeText(status.text) + '</span><div class="serial-bridge-row-actions"><button type="button" class="serial-bridge-button" data-action="start"' + (status.running ? ' disabled' : '') + '>启动</button><button type="button" class="serial-bridge-button stop" data-action="stop"' + (!status.running ? ' disabled' : '') + '>停止</button></div></div></div>' +
        '<div class="serial-bridge-port-grid">' +
        portField('串口设备', '<select data-field="devicePath" title="扫描后从此选择实际串口设备">' + deviceOptions(port.devicePath) + '</select>', 'device') +
        portField('波特率', '<select data-field="baudRate">' + selectOptions(baudRates, port.baudRate) + '</select>') +
        portField('数据位', '<select data-field="dataBits">' + selectOptions([8, 7, 6, 5], port.dataBits) + '</select>') +
        portField('校验', '<select data-field="parity">' + selectOptions(['N', 'E', 'O'], port.parity, { N: '无', E: '偶校验', O: '奇校验' }) + '</select>') +
        portField('停止位', '<select data-field="stopBits">' + selectOptions([1, 2], port.stopBits) + '</select>') +
        portField('分包间隔 (ms)', '<input data-field="packetIntervalMs" type="number" min="0" max="10000" value="' + port.packetIntervalMs + '"' + disabled + ' />') +
        portField('串口类型', '<select data-field="type">' + selectOptions([1, 11, 0], port.type, portTypes) + '</select>') +
        portField(endpointLabel, '<input data-field="endpoint" type="text" value="' + escapeText(endpointValue(port)) + '" placeholder="' + endpointPlaceholder + '"' + disabled + ' />', 'endpoint') +
        '</div></article></td></tr>';
    }).join('');
    table.innerHTML = '<tbody>' + rows + '</tbody>';
  }

  function renderPortStatuses() {
    table.querySelectorAll('tbody tr[data-port-id]').forEach(function (row) {
      const id = Number(row.getAttribute('data-port-id'));
      const port = state.config.ports.find(function (item) { return item.id === id; });
      if (!port) return;
      const status = statusView(port);
      const statusElement = row.querySelector('[data-bridge-status]');
      if (statusElement) {
        statusElement.className = 'serial-bridge-status ' + status.state;
        statusElement.title = status.text;
        statusElement.textContent = status.text;
      }
      const startButton = row.querySelector('[data-action="start"]');
      const stopButton = row.querySelector('[data-action="stop"]');
      if (startButton) startButton.disabled = status.running;
      if (stopButton) stopButton.disabled = !status.running;
    });
  }

  function render() {
    if (!state.config) return;
    renderBasics();
    renderCommunication();
    renderPorts();
  }

  function parseEndpoint(value, type) {
    const raw = String(value || '').trim();
    if (Number(type) !== 11) return { listenPort: Number(raw), targetHost: '', targetPort: 0 };
    const match = /^(.+):(\d{1,5})$/.exec(raw);
    return { listenPort: 0, targetHost: match ? match[1].trim() : raw, targetPort: match ? Number(match[2]) : 0 };
  }

  function collectConfig() {
    const next = JSON.parse(JSON.stringify(state.config));
    next.comNum = Number($('bridge-com-num').value);
    next.logLevel = Number($('bridge-log-level').value);
    communicationFields.forEach(function (field) {
      next.communication[field[0]] = Number($('bridge-comm-' + field[0]).value);
    });
    table.querySelectorAll('tbody tr').forEach(function (row) {
      const id = Number(row.getAttribute('data-port-id'));
      const port = next.ports.find(function (item) { return item.id === id; });
      if (!port) return;
      const get = function (name) { return row.querySelector('[data-field="' + name + '"]'); };
      port.enabled = false;
      port.autoStart = get('autoStart').checked;
      port.devicePath = get('devicePath').value;
      port.baudRate = Number(get('baudRate').value);
      port.dataBits = Number(get('dataBits').value);
      port.parity = get('parity').value;
      port.stopBits = Number(get('stopBits').value);
      port.packetIntervalMs = Number(get('packetIntervalMs').value);
      port.type = Number(get('type').value);
      const endpoint = parseEndpoint(get('endpoint').value, port.type);
      port.listenPort = endpoint.listenPort;
      port.targetHost = endpoint.targetHost;
      port.targetPort = endpoint.targetPort;
    });
    return next;
  }

  async function loadConfig() {
    const data = await request('/api/serial/bridge/config', { cache: 'no-store' });
    state.config = data.config;
    state.status = data.status || [];
    state.dirty = false;
    render();
  }

  async function refreshStatus() {
    if (drawer.hidden) return;
    const data = await request('/api/serial/bridge/status', { cache: 'no-store' });
    state.status = data.status || [];
    renderPortStatuses();
  }

  function migrateDetectedDevicePaths() {
    const usablePaths = state.devices.filter(function (item) {
      return item.openable !== false && !item.busy;
    }).map(function (item) { return item.path; });
    let changed = 0;
    state.config.ports.slice(0, state.config.comNum).forEach(function (port, index) {
      const detected = state.devices.find(function (item) { return item.path === port.devicePath; });
      const isLegacyDefault = /^\/dev\/ttyO\d+$/.test(port.devicePath || '');
      const needsSelection = !port.devicePath || isLegacyDefault || !detected || detected.openable === false;
      if (!needsSelection) return;
      const nextPath = usablePaths[index] || '';
      if (port.devicePath !== nextPath) {
        port.devicePath = nextPath;
        changed += 1;
      }
    });
    return changed;
  }

  async function scanDevices() {
    scanButton.disabled = true;
    setMessage('正在扫描串口设备，请稍候...', '');
    try {
      const data = await request('/api/serial/ports?probe=1', { cache: 'no-store' });
      state.devices = data.ports || [];
      const migrated = migrateDetectedDevicePaths();
      if (migrated) state.dirty = true;
      renderPorts();
      const usable = state.devices.filter(function (item) { return item.openable !== false && !item.busy; }).length;
      setMessage(migrated
        ? '已发现 ' + usable + ' 个可用串口，已从 /dev/ttyS0 起更新旧默认映射；未分配端口请在接入设备后重新扫描。请先保存配置。'
        : '已发现 ' + usable + ' 个可用串口；请为每路选择实际串口。', 'success');
    } catch (error) {
      setMessage('扫描失败：' + error.message, 'error');
    } finally {
      scanButton.disabled = false;
    }
  }

  async function saveConfig(showMessage) {
    const next = collectConfig();
    saveButton.disabled = true;
    try {
      const data = await request('/api/serial/bridge/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ config: next }),
      });
      state.config = data.config;
      state.status = data.status || [];
      state.dirty = false;
      render();
      if (showMessage !== false) setMessage('配置已保存。运行中的端口保持当前参数，新参数会在下次启动时生效。', 'success');
      return true;
    } catch (error) {
      setMessage('保存失败：' + error.message, 'error');
      return false;
    } finally {
      saveButton.disabled = false;
    }
  }

  function summarizeStartEnabledResults(results) {
    const items = Array.isArray(results) ? results : [];
    if (!items.length) return { text: '没有勾选本次启动的串口任务。', kind: 'error' };
    const started = items.filter(function (item) { return item.action === 'started'; }).map(function (item) { return item.id; });
    const alreadyRunning = items.filter(function (item) { return item.action === 'already-running'; }).map(function (item) { return item.id; });
    const failed = items.filter(function (item) { return item.state === 'error'; });
    const messages = [];
    if (started.length) messages.push('已启动串口 ' + started.join('、'));
    if (alreadyRunning.length) messages.push('串口 ' + alreadyRunning.join('、') + ' 已在运行');
    if (failed.length) messages.push('启动失败：' + failed.map(function (item) { return '串口 ' + item.id + '（' + item.error + '）'; }).join('；'));
    return { text: messages.join('。') || '没有可启动的已启用串口任务。', kind: failed.length ? 'error' : 'success' };
  }

  async function invokePortAction(id, action) {
    if (action === 'start' && state.dirty) {
      setMessage('正在保存当前配置...', '');
      const saved = await saveConfig(false);
      if (!saved) return;
    }
    const hasUnsavedConfig = action === 'stop' && state.dirty;
    if (action === 'stop' && state.dirty) {
      setMessage('正在停止端口 ' + id + '；当前配置尚未保存。', '');
    } else {
      setMessage(action === 'start' ? '正在启动端口 ' + id + '...' : '正在停止端口 ' + id + '...', '');
    }
    try {
      const data = await request('/api/serial/bridge/' + id + '/' + action, { method: 'POST' });
      const current = state.status.filter(function (item) { return item.id !== id; });
      if (data.status) current.push(data.status);
      state.status = current;
      renderPortStatuses();
      setMessage('端口 ' + id + (action === 'start' ? ' 已启动。' : (' 已停止。' + (hasUnsavedConfig ? '当前配置尚未保存。' : ''))), 'success');
    } catch (error) {
      setMessage(error.message, 'error');
      refreshStatus().catch(function () {});
    }
  }

  function setDrawerVisible(visible) {
    drawer.hidden = !visible;
    openButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
    if (visible) {
      loadConfig().then(function () { return scanDevices(); }).catch(function (error) { setMessage('读取配置失败：' + error.message, 'error'); });
      if (state.poller) clearInterval(state.poller);
      state.poller = setInterval(function () { refreshStatus().catch(function () {}); }, 4000);
    } else if (state.poller) {
      clearInterval(state.poller);
      state.poller = null;
    }
  }

  openButton.addEventListener('click', function () { setDrawerVisible(drawer.hidden); });
  closeButton.addEventListener('click', function () { setDrawerVisible(false); });
  saveButton.addEventListener('click', function () { saveConfig(true); });
  scanButton.addEventListener('click', scanDevices);
  startEnabledButton.addEventListener('click', async function () {
    const selectedIds = Array.from(state.startSelected).sort(function (left, right) { return left - right; });
    if (!selectedIds.length) { setMessage('请先勾选需要本次启动的串口。', 'error'); return; }
    if (state.dirty) {
      setMessage('正在保存开机自启配置...', '');
      const saved = await saveConfig(false);
      if (!saved) return;
    }
    startEnabledButton.disabled = true;
    setMessage('正在启动勾选的串口...', '');
    try {
      const data = await request('/api/serial/bridge/start-enabled', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ portIds: selectedIds }),
      });
      state.status = data.status || [];
      state.startSelected.clear();
      renderPorts();
      const summary = summarizeStartEnabledResults(data.results);
      setMessage(summary.text, summary.kind);
    } catch (error) { setMessage(error.message, 'error'); }
    finally { startEnabledButton.disabled = false; }
  });
  stopAllButton.addEventListener('click', async function () {
    try {
      const data = await request('/api/serial/bridge/stop-all', { method: 'POST' });
      state.status = data.status || [];
      renderPortStatuses();
      setMessage('全部串口转网口任务已停止。', 'success');
    } catch (error) { setMessage(error.message, 'error'); }
  });

  drawer.addEventListener('change', function (event) {
    if (!event.target.matches('input, select')) return;
    if (event.target.getAttribute('data-field') === 'enabled') {
      const row = event.target.closest('tr[data-port-id]');
      const id = row ? Number(row.getAttribute('data-port-id')) : 0;
      if (id) {
        if (event.target.checked) state.startSelected.add(id);
        else state.startSelected.delete(id);
      }
      return;
    }
    state.dirty = true;
    state.config = collectConfig();
    if (event.target.id === 'bridge-com-num') {
      render();
    }
  });
  table.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const row = button.closest('tr[data-port-id]');
    if (row) invokePortAction(Number(row.getAttribute('data-port-id')), button.getAttribute('data-action'));
  });
  table.addEventListener('change', function (event) {
    if (event.target.getAttribute('data-field') !== 'type') return;
    const next = collectConfig();
    state.config = next;
    renderPorts();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !drawer.hidden) setDrawerVisible(false);
  });
})();
