(function () {
  'use strict';
  var dialog = document.createElement('dialog');
  dialog.className = 'wc-dialog'; dialog.setAttribute('aria-labelledby', 'wcTitle');
  dialog.innerHTML = '<header class="wc-head"><div class="wc-heading"><h2 id="wcTitle">企业微信转发</h2><button class="wc-help-button" id="wcHelpButton" type="button" aria-label="配置项说明" title="配置项说明" aria-expanded="false" aria-controls="wcHelp">?</button></div><button class="btn wc-close" type="button" aria-label="关闭" title="关闭">×</button></header>' +
    '<section class="wc-help" id="wcHelp" aria-label="配置项说明" hidden><h3>配置项说明</h3><dl>' +
    '<dt>群机器人 Webhook</dt><dd>企业微信群机器人的消息接收地址。保存后不显示完整地址，留空保持原值。请勿泄露地址中的密钥。</dd>' +
    '<dt>发送通道：群机器人 / 自建应用</dt><dd>二选一，只向当前保存的通道发送。两套配置分别保留，已有配置默认群机器人。待发送或失败队列非空时，不能切换通道或改变当前接收对象；请先处理队列。切换后沿用告警基线，不补发已有告警。</dd>' +
    '<dt>自建应用配置</dt><dd>在企业微信管理后台创建自建应用，填写企业 ID（CorpID）、应用 ID（AgentID）和该应用的 Secret。Secret 保存后隐藏，留空保持原值。应用可见范围必须包含接收人员；在应用可信 IP 中配置服务器实际出口公网 IP，不是 192.168 开头的内网 IP。无需配置消息接收回调 URL。</dd>' +
    '<dt>成员 / 部门 / 标签</dt><dd>填写企业微信 ID，不是显示名称；多个 ID 用 | 分隔，如成员 zhangsan|lisi、部门 1|2。至少填写一种，三类接收对象合并发送。成员填写 @all 表示应用可见范围内所有成员，请谨慎使用。自建应用消息进入成员的应用消息，不是群机器人消息。</dd>' +
    '<dt>验证自建应用</dt><dd>先保存配置，再点击“验证应用凭证”：仅获取 access_token，不发送消息。成功后点击“发送测试消息”验证接收对象。系统自动缓存和刷新 Token。60020 通常是出口 IP 不可信，60011 是可见范围问题；部分对象无效时其他人可能已经收到，请核对后再手动重试。</dd>' +
    '<dt>采集间隔（秒）</dt><dd>后台读取 DCIM 告警的间隔，范围 10–3600 秒，默认 30 秒。间隔越短，发现告警越及时，接口请求也越频繁。</dd>' +
    '<dt>关键词</dt><dd>在区域名称、设备名称、告警内容中查找包含的文字，英文不区分大小写。例如 UPS 可匹配设备 UPS-01。只支持一个关键词，逗号不会分成多个词；留空不限制。</dd>' +
    '<dt>区域 / 设备 / 告警等级</dt><dd>打开下拉框搜索并勾选，可多选，不选表示全部。同一项中匹配任意一个值即可。区域和设备来自接口列表及实际告警；等级从实际告警中提取。未获取到的已保存选项仍保留，不会自动清除。</dd>' +
    '<dt>筛选组合</dt><dd>区域、设备、等级和关键词之间需要同时满足。例如区域填“一号机房”、关键词填“UPS”，只推送一号机房内包含 UPS 的告警。筛选用于后续新告警，不补发已有告警。</dd>' +
    '<dt>恢复通知</dt><dd>只有同一告警具有有效恢复时间，并且已进入新增告警通知流程，才会安排恢复通知；新增通知发送成功后才发送恢复通知。接口失败、告警消失或人工确认都不等于恢复。</dd>' +
    '<dt>自动转发</dt><dd>保存后生效。启用后后台持续采集和发送，关闭浏览器不影响运行。首次启用仅记录现有告警作为基线，不群发已有告警；停用后暂停采集和队列发送。</dd>' +
    '<dt>告警字段映射</dt><dd>默认自动识别接口字段。识别不正确时填写实际字段名，区分大小写。告警 ID 和发生时间共同标识同一次告警；恢复时间必须是明确解除时间，不能使用确认时间或更新时间。区域、设备、等级、告警内容分别用于筛选和消息展示。建立基线后需先停用并重建基线，才能修改映射。</dd>' +
    '<dt>保存配置 / 发送测试消息</dt><dd>保存配置使当前填写的内容生效。测试按钮向已保存的机器人发送一条测试消息，即使自动转发停用也可测试；不会发送当前全部告警。</dd>' +
    '<dt>发送失败排查：宿主机 DNS</dt><dd>提示“企业微信网络连接失败或超时”时，请在运行 WebSSH 的宿主机上检查，不要只在 DCIM 容器内测试。容器能 ping 通百度，不代表宿主机能访问企业微信。曾出现宿主机 /etc/resolv.conf 文件存在但仅 1 字节、没有 nameserver，导致域名解析失败（ENOTFOUND）。</dd>' +
    '<dt>DNS 检查与修复</dt><dd>以 root 在宿主机依次执行：<br><code>cat /etc/resolv.conf</code><br><code>getent ahosts qyapi.weixin.qq.com</code><br>若没有 DNS 配置且解析失败，先备份：<br><code>cp -p /etc/resolv.conf /etc/resolv.conf.bak-$(date +%Y%m%d%H%M%S)</code><br>编辑 <code>/etc/resolv.conf</code>，添加两行：<br><code>nameserver 8.8.8.8</code><br><code>nameserver 8.8.4.4</code><br>以上 DNS 已在 50.61 验证；其他网络请使用可达的 DNS，已有内网 DNS 时不要直接覆盖。</dd>' +
    '<dt>持久化与验证</dt><dd>使用 NetworkManager 的主机可先查看连接名：<br><code>nmcli -t -f NAME,DEVICE connection show --active</code><br>再保存 DNS（将 p3p1 换成实际连接名）：<br><code>nmcli connection modify &quot;p3p1&quot; ipv4.dns &quot;8.8.8.8 8.8.4.4&quot;</code><br>手动修改 resolv.conf 后可立即验证，无需重启网卡或服务：<br><code>getent ahosts qyapi.weixin.qq.com</code><br><code>curl -I --connect-timeout 8 --max-time 15 https://qyapi.weixin.qq.com/</code><br>根路径返回 HTTP 403 也说明 HTTPS 已连通，不代表机器人发送失败。最后点击“发送测试消息”确认机器人接口。若 DNS 正常仍失败，继续检查出口 TCP 443、防火墙、系统时间和证书；不要关闭证书校验。</dd>' +
    '<dt>重建告警基线</dt><dd>需先停用并处理完待发送、失败队列。重置后，下次启用重新记录当前告警，不补发这些告警；发送日志保留。</dd>' +
    '<dt>数据预览 / 发送日志</dt><dd>预览使用已保存配置读取告警，不发送消息、不改变基线，最多展示 50 条。日志保留最近 500 条记录；“重试失败消息”将失败队列重新排队，自动转发启用后才会发送。</dd>' +
    '</dl><button class="btn" id="wcHelpClose" type="button">收起说明</button></section>' +
    '<div class="wc-status" id="wcStatus">加载中</div><div class="wc-notice" id="wcError" role="status" aria-live="polite"></div>' +
    '<nav class="wc-tabs" role="tablist" aria-label="企业微信转发"><button role="tab" id="wcTabConfig" data-tab="config" aria-controls="wc-config" aria-selected="true">转发配置</button><button role="tab" id="wcTabPreview" data-tab="preview" aria-controls="wc-preview" aria-selected="false">数据预览</button><button role="tab" id="wcTabLogs" data-tab="logs" aria-controls="wc-logs" aria-selected="false">发送日志</button></nav>' +
    '<div class="wc-body"><section id="wc-config" role="tabpanel" aria-labelledby="wcTabConfig"><form id="wcForm"><div class="wc-form">' +
    '<label class="wc-wide">发送通道<select id="wcChannel"><option value="webhook">群机器人</option><option value="application">自建应用</option></select></label>' +
    '<label class="wc-wide" id="wcWebhookGroup">群机器人 Webhook<input id="wcWebhook" type="password" autocomplete="new-password" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." /></label>' +
    '<div class="wc-wide" id="wcApplicationGroup" hidden><div class="wc-form">' +
    '<label>企业 ID（CorpID）<input id="wcCorpId" type="text" autocomplete="off" /></label>' +
    '<label>应用 ID（AgentID）<input id="wcAgentId" type="text" inputmode="numeric" /></label>' +
    '<label class="wc-wide">应用密钥（Secret）<input id="wcSecret" type="password" autocomplete="new-password" /></label>' +
    '<label>接收成员 ID<input id="wcToUser" type="text" placeholder="zhangsan|lisi" /></label>' +
    '<label>接收部门 ID<input id="wcToParty" type="text" placeholder="1|2" /></label>' +
    '<label>接收标签 ID<input id="wcToTag" type="text" placeholder="1|2" /></label>' +
    '</div><button class="btn" id="wcCredentials" type="button">验证应用凭证</button><p>接收对象用 | 分隔；Secret 留空保持原值。请先配置应用可见范围及出口公网可信 IP。</p></div>' +
    '<label>采集间隔（秒）<input id="wcInterval" type="number" min="10" max="3600" value="30" required /></label>' +
    '<label>关键词<input id="wcKeyword" type="text" maxlength="200" /></label>' +
    '<div id="wcAreas"></div><div id="wcDevices"></div><div id="wcLevels"></div>' +
    '<div><button class="btn" id="wcReloadOptions" type="button">刷新选项</button><span id="wcOptionsStatus" role="status"></span></div>' +
    '<label class="wc-check"><input id="wcRecovery" type="checkbox" checked />恢复通知</label>' +
    '<label class="wc-check"><input id="wcEnabled" type="checkbox" />自动转发</label>' +
    '<details class="wc-wide"><summary>告警字段映射</summary><div class="wc-form" id="wcFields"></div></details></div>' +
    '<div class="wc-actions"><button class="btn primary" id="wcSave" type="submit">保存配置</button><button class="btn" type="button" id="wcTest">发送测试消息</button><button class="btn" type="button" id="wcReset">重建告警基线</button></div></form></section>' +
    '<section id="wc-preview" role="tabpanel" aria-labelledby="wcTabPreview" hidden><button class="btn" id="wcPreview" type="button">读取当前告警</button><span id="wcPreviewCount"></span><div class="wc-table-wrap" id="wcPreviewTable"></div></section>' +
    '<section id="wc-logs" role="tabpanel" aria-labelledby="wcTabLogs" hidden><div class="wc-actions"><select class="wc-log-filter" id="wcLogFilter" aria-label="发送结果"><option value="">全部结果</option><option value="sent">发送成功</option><option value="failed">失败</option></select><button class="btn" id="wcRefresh" type="button">刷新日志</button><button class="btn" id="wcRetry" type="button">重试失败消息</button></div><div class="wc-table-wrap" id="wcLogTable"></div></section></div>';
  document.body.appendChild(dialog);
  var $ = function (id) { return document.getElementById(id); };
  var selections = { areas: [], devices: [], levels: [] }, optionData = { areas: [], devices: [], levels: [] };
  var pickers = {};
  [['areas', 'wcAreas', '区域'], ['devices', 'wcDevices', '设备'], ['levels', 'wcLevels', '告警等级']].forEach(function (entry) {
    var kind = entry[0], host = $(entry[1]); host.className = 'wc-picker';
    var label = document.createElement('span'); label.textContent = entry[2]; host.appendChild(label);
    var toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'wc-picker-toggle'; toggle.setAttribute('aria-label', entry[2]); toggle.setAttribute('aria-expanded', 'false'); host.appendChild(toggle);
    var panel = document.createElement('div'); panel.className = 'wc-picker-panel'; panel.hidden = true; panel.id = entry[1] + 'Panel'; toggle.setAttribute('aria-controls', panel.id); host.appendChild(panel);
    var search = document.createElement('input'); search.type = 'search'; search.placeholder = '搜索' + entry[2]; search.setAttribute('aria-label', '搜索' + entry[2]); panel.appendChild(search);
    var clear = document.createElement('button'); clear.type = 'button'; clear.className = 'btn'; clear.textContent = '全部（不限制）'; panel.appendChild(clear);
    var items = document.createElement('div'); items.className = 'wc-picker-items'; panel.appendChild(items);
    function render() {
      toggle.textContent = selections[kind].length ? selections[kind].join('、') : '全部' + entry[2];
      toggle.title = toggle.textContent;
      items.textContent = '';
      Array.from(new Set(optionData[kind].concat(selections[kind]))).filter(function (value) { return value.toLowerCase().includes(search.value.toLowerCase()); }).forEach(function (value) {
        var row = document.createElement('label'), box = document.createElement('input'); row.className = 'wc-picker-option'; box.type = 'checkbox'; box.checked = selections[kind].includes(value); box.disabled = !canManage;
        box.onchange = function () { if (box.checked) selections[kind].push(value); else selections[kind] = selections[kind].filter(function (v) { return v !== value; }); toggle.textContent = selections[kind].length ? selections[kind].join('、') : '全部' + entry[2]; toggle.title = toggle.textContent; };
        row.appendChild(box); row.appendChild(document.createTextNode(value)); items.appendChild(row);
      });
      if (!items.children.length) items.textContent = '暂无匹配选项';
    }
    toggle.onclick = function () { var open = panel.hidden; Object.keys(pickers).forEach(function (k) { pickers[k].close(); }); panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); if (open) search.focus(); };
    panel.onkeydown = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); } };
    search.oninput = render; clear.onclick = function () { selections[kind] = []; render(); };
    pickers[kind] = { render: render, close: function () { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); } };
  });
  async function loadOptions() {
    if (optionsLoading) return;
    optionsLoading = true; permissions();
    $('wcOptionsStatus').textContent = ' 获取中…';
    try { var r = await api('options'); optionData = r.options; Object.keys(pickers).forEach(function (k) { pickers[k].render(); }); $('wcOptionsStatus').textContent = r.options.warnings.length ? r.options.warnings.join('；') : ' 已更新'; }
    catch (e) { $('wcOptionsStatus').textContent = ' 获取失败：' + e.message; }
    optionsLoading = false; permissions();
  }
  $('wcReloadOptions').onclick = function () { loadOptions(); };
  function showHelp(open) {
    $('wcHelp').hidden = !open;
    $('wcHelpButton').setAttribute('aria-expanded', String(open));
    if (!open) $('wcHelpButton').focus();
  }
  $('wcHelpButton').onclick = function () { showHelp($('wcHelp').hidden); };
  $('wcHelpClose').onclick = function () { showHelp(false); };
  var fieldLabels = { id: '告警 ID', startedAt: '发生时间', recoveredAt: '恢复时间', area: '区域', device: '设备', level: '等级', content: '告警内容' };
  Object.keys(fieldLabels).forEach(function (key) {
    var label = document.createElement('label'); label.textContent = fieldLabels[key];
    var input = document.createElement('input'); input.id = 'wcField-' + key; input.placeholder = '自动识别'; input.maxLength = 80; label.appendChild(input); $('wcFields').appendChild(label);
  });
  var canManage = false, timer = null, logs = [], busy = false, loaded = false, optionsLoading = false;
  function notice(message) { $('wcError').textContent = message || ''; }
  async function api(name, method, body) {
    var response = await fetch('/api/proto-conv/wecom/' + name, { method: method || 'GET', credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    var data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.message || '请求失败（' + response.status + '）'); return data;
  }
  function permissions() {
    $('wcForm').querySelectorAll('input,button,select').forEach(function (input) { input.disabled = busy || !canManage || !loaded; });
    $('wcRetry').disabled = busy || !canManage || !loaded;
    $('wcPreview').disabled = busy || !loaded;
    $('wcReloadOptions').disabled = busy || !canManage || !loaded || optionsLoading;
  }
  async function action(fn) {
    if (busy) return;
    busy = true; permissions(); notice('');
    try { await fn(); } catch (e) { notice(e.message); }
    finally { busy = false; permissions(); }
  }
  function status(s) {
    $('wcStatus').textContent = (s.enabled ? '自动转发已启用' : '自动转发已停用') + ' · 待发送 ' + s.pending + ' · 失败 ' + s.failed +
      ' · ' + (s.initialized ? '基线已建立' : '基线未建立') + ' · 最近采集 ' + (s.lastPollAt ? new Date(s.lastPollAt).toLocaleString() : '-');
    $('wecomDot').className = 'dot ' + (s.lastError || s.recoveryError ? 'err' : s.running ? 'on' : 'off');
    $('wcStatus').title = [s.lastError, s.recoveryError].filter(Boolean).join('\n');
    if (s.lastError || s.recoveryError) notice([s.lastError, s.recoveryError].filter(Boolean).join('\n'));
  }
  function fill(c) {
    $('wcChannel').value = c.channel || 'webhook'; channelView();
    var a = c.application || {};
    [['wcCorpId', 'corpId'], ['wcAgentId', 'agentId'], ['wcToUser', 'toUser'], ['wcToParty', 'toParty'], ['wcToTag', 'toTag']].forEach(function (pair) { $(pair[0]).value = a[pair[1]] || ''; });
    $('wcSecret').value = ''; $('wcSecret').placeholder = a.hasSecret ? '已保存，留空保持原值' : '请输入应用 Secret';
    $('wcWebhook').value = ''; $('wcWebhook').placeholder = c.hasWebhook ? '已保存，留空保持原值' : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...';
    $('wcInterval').value = c.pollIntervalSec; $('wcRecovery').checked = c.recovery; $('wcEnabled').checked = c.enabled;
    ['areas', 'devices', 'levels'].forEach(function (k) { selections[k] = c.filters[k].slice(); pickers[k].render(); }); $('wcKeyword').value = c.filters.keyword;
    Object.keys(fieldLabels).forEach(function (key) { $('wcField-' + key).value = c.fields[key] || ''; });
  }
  function config() {
    var fields = {}; Object.keys(fieldLabels).forEach(function (key) { if ($('wcField-' + key).value.trim()) fields[key] = $('wcField-' + key).value.trim(); });
    return { channel: $('wcChannel').value, application: { corpId: $('wcCorpId').value.trim(), agentId: $('wcAgentId').value.trim(), secret: $('wcSecret').value.trim(), toUser: $('wcToUser').value.trim(), toParty: $('wcToParty').value.trim(), toTag: $('wcToTag').value.trim() }, webhook: $('wcWebhook').value.trim(), enabled: $('wcEnabled').checked, recovery: $('wcRecovery').checked,
      pollIntervalSec: Number($('wcInterval').value), filters: { areas: selections.areas.slice(), devices: selections.devices.slice(), levels: selections.levels.slice(), keyword: $('wcKeyword').value.trim() }, fields: fields };
  }
  function table(target, headers, rows) {
    target.textContent = '';
    if (!rows.length) { var empty = document.createElement('p'); empty.textContent = '暂无记录'; target.appendChild(empty); return; }
    var t = document.createElement('table'); t.className = 'wc-table'; var head = t.createTHead().insertRow();
    headers.forEach(function (h) { var th = document.createElement('th'); th.textContent = h; head.appendChild(th); });
    var body = t.createTBody(); rows.forEach(function (row) { var tr = body.insertRow(); row.forEach(function (cell) { var td = tr.insertCell(); td.textContent = cell == null || cell === '' ? '-' : String(cell); }); });
    target.appendChild(t);
  }
  function renderLogs() {
    var types = { test: '测试', new: '新增告警', recovery: '告警恢复', collect: '采集', reset: '基线重置' };
    table($('wcLogTable'), ['时间', '通道', '类型', '设备 / 告警 ID', '结果', '详情'], logs.filter(function (r) { return !$('wcLogFilter').value || r.result === $('wcLogFilter').value; }).map(function (r) {
      return [new Date(r.at).toLocaleString(), r.channel === 'application' ? '自建应用' : '群机器人', types[r.type] || r.type, [r.device, r.alarmId].filter(Boolean).join(' / '), r.result === 'sent' ? '发送成功' : r.result === 'saved' ? '已保存' : '失败', r.message];
    }));
  }
  async function loadLogs() { logs = (await api('logs')).logs; renderLogs(); }
  dialog.querySelector('.wc-close').onclick = function () { dialog.close(); };
  dialog.addEventListener('close', function () { clearInterval(timer); timer = null; $('btnOpenWecom').focus(); });
  var tabs = Array.from(dialog.querySelectorAll('[data-tab]'));
  function tab(name) {
    tabs.forEach(function (b) { var selected = b.dataset.tab === name; b.setAttribute('aria-selected', String(selected)); b.tabIndex = selected ? 0 : -1; $('wc-' + b.dataset.tab).hidden = !selected; });
    if (name === 'logs') action(loadLogs);
  }
  tabs.forEach(function (b, index) { b.onclick = function () { tab(b.dataset.tab); }; b.onkeydown = function (event) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault(); var next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; next.focus(); tab(next.dataset.tab);
  }; });
  $('btnOpenWecom').onclick = function () {
    if (dialog.open) return; dialog.showModal(); loaded = false;
    action(async function () { var r = await api('config'); canManage = r.canManage; fill(r.config); loaded = true; status(r.status); if (!canManage) notice('当前账号只读'); loadOptions(); });
    timer = setInterval(async function () { if (busy) return; try { status((await api('status')).status); } catch (e) { notice(e.message); } }, 5000);
  };
  $('wcForm').onsubmit = function (e) { e.preventDefault(); action(async function () { var r = await api('config', 'PUT', config()); fill(r.config); status(r.status); notice('配置已保存'); }); };
  $('wcTest').onclick = function () { action(async function () {
    if ($('wcWebhook').value || $('wcSecret').value) throw new Error('请先保存配置再发送测试消息');
    if (!window.confirm('使用已保存的通道和接收对象发送一条测试消息？未保存的修改不会生效。')) return;
    var r = await api('test', 'POST', {}); notice(r.message);
  }); };
  function channelView() {
    var app = $('wcChannel').value === 'application';
    $('wcWebhookGroup').hidden = app; $('wcApplicationGroup').hidden = !app;
  }
  $('wcChannel').onchange = channelView;
  $('wcCredentials').onclick = function () { action(async function () {
    if ($('wcSecret').value) throw new Error('请先保存应用配置');
    var r = await api('credentials', 'POST', {}); notice(r.message);
  }); };
  $('wcPreview').onclick = function () { action(async function () { var p = (await api('preview', 'POST', {})).preview;
    $('wcPreviewCount').textContent = ' 共 ' + p.total + ' 条，匹配 ' + p.matched + ' 条';
    table($('wcPreviewTable'), ['告警 ID', '区域', '设备', '等级', '内容', '发生时间', '恢复时间'], p.rows.map(function (a) { return [a.id, a.area, a.device, a.level, a.content, new Date(a.startedAt).toLocaleString(), a.recoveredAt ? new Date(a.recoveredAt).toLocaleString() : '-']; }));
    if (p.recoveryError) notice(p.recoveryError);
  }); };
  $('wcRefresh').onclick = function () { action(loadLogs); };
  $('wcLogFilter').onchange = renderLogs;
  $('wcRetry').onclick = function () { action(async function () { await api('retry', 'POST', {}); notice('失败消息已重新排队'); await loadLogs(); }); };
  $('wcReset').onclick = function () { action(async function () {
    if (!window.confirm('重置告警基线？下次启用只记录现有告警，不补发这些告警。')) return;
    status((await api('reset', 'POST', {})).status); notice('基线已重置');
  }); };
  tab('config');
  async function refreshIndicator() {
    if (dialog.open) return;
    try {
      var s = (await api('status')).status;
      $('wecomDot').className = 'dot ' + (s.lastError || s.recoveryError ? 'err' : s.running ? 'on' : 'off');
    } catch (_e) { $('wecomDot').className = 'dot off'; }
  }
  refreshIndicator(); setInterval(refreshIndicator, 10000);
})();
