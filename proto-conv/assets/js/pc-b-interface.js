(function () {
  'use strict';
  var entry = document.getElementById('btnOpenBInterface'); if (!entry) return;
  var dialog = document.createElement('dialog'); dialog.className = 'bi-dialog'; dialog.setAttribute('aria-labelledby', 'biTitle');
  // Static structure only; all DCIM/config/log strings are rendered with textContent.
  dialog.innerHTML = '<header class="bi-head"><h2 id="biTitle">B接口转发 · 中国联通 V3.0</h2><button type="button" class="btn" id="biClose" aria-label="关闭 B 接口转发">关闭</button></header>' +
    '<nav class="bi-tabs" role="tablist" aria-label="B 接口配置"><button role="tab" aria-selected="true" id="biTabConfig" aria-controls="biConfigPanel">接入配置</button><button role="tab" aria-selected="false" id="biTabMapping" aria-controls="biMappingPanel">设备和测点</button><button role="tab" aria-selected="false" id="biTabRequests" aria-controls="biRequestsPanel">查询请求</button><button role="tab" aria-selected="false" id="biTabPreview" aria-controls="biPreviewPanel">报文预览</button><button role="tab" aria-selected="false" id="biTabLogs" aria-controls="biLogsPanel">运行日志</button></nav>' +
    '<div class="bi-status" id="biStatus" role="status">正在读取配置…</div><div class="bi-error" id="biError" role="alert"></div><div class="bi-body">' +
    '<section id="biConfigPanel" role="tabpanel" aria-labelledby="biTabConfig"><p class="bi-hint">复用「连接信息」中的 DCIM 数据源。本软件作为 SU：向 SC 注册、上报告警，接受上级实时数据与状态查询。SC 需能访问下方 SU 服务地址和端口。</p><form id="biConfigForm" class="bi-form"></form>' +
    '<div class="bi-wsdl"><strong>SoapUI / Initial WSDL</strong><div class="bi-actions"><button class="btn" type="button" id="biDownloadSuWsdl">下载 SU WSDL（查询本软件）</button><button class="btn" type="button" id="biDownloadScWsdl">下载 SC WSDL（模拟上级）</button><button class="btn" type="button" id="biCopyLoginAck">复制 LOGIN_ACK 响应</button></div><label for="biWsdlUrl">Initial WSDL（SU 在线地址）</label><input id="biWsdlUrl" readonly aria-describedby="biWsdlHint"><p class="bi-hint" id="biWsdlHint"></p><p class="bi-hint">下载文件后，在 SoapUI 的 Initial WSDL 点击 Browse 选择文件。WSDL 使用已保存的地址和 SOAP 参数；修改后请先保存，再重新下载。</p><details><summary>LOGIN_ACK 响应模板（模拟 SC 同意注册）</summary><div class="bi-actions"><label for="biLoginAckXml">完整 SOAP 响应</label><button class="btn" type="button" id="biCopyLoginAckInline">复制完整响应</button></div><textarea id="biLoginAckXml" readonly rows="10" spellcheck="false" placeholder="展开后自动生成 LOGIN_ACK 响应"></textarea><p class="bi-hint">展开后自动生成响应。点击复制后，将全文粘贴到 SoapUI 的 SC MockService → invoke → Response 1，完整替换原内容，并启动 MockService。根据已保存的 SU 编码和 SOAP 参数生成；修改后请先保存。此模板只用于 LOGIN 注册响应，告警上报需要对应的告警 ACK。</p></details></div>' +
    '<details><summary>SOAP 与运行参数（按上级平台 WSDL 核对）</summary><div id="biAdvanced" class="bi-form"></div></details>' +
    '<details><summary>使用说明与支持范围</summary><div class="bi-hint">先填写 SC 地址、SU 身份和上级 IP 白名单，再在「设备和测点」映射五位设备编码与十二位监控信息 ID。默认服务路径 /services/SUService，默认端口 8080，工程可修改。需要开放该端口；白名单填写 SC 实际连接来源 IP，不使用代理头。<br>遥测 AI 返回 Value；遥信 DI 的状态写入 ID 末两位，未知为 FF。告警按设备与名称精确匹配，BEGIN/END 复用序号，失败保留、重启补报；当前告警消失不会直接判定恢复。<br>本期不支持遥控、遥调、FTP、时钟修改、升级和控制逻辑；不代替完整 B 接口认证。默认 SOAP 绑定为参考值，规范 PDF 未嵌入 WSDL，现场必须核对。HTTP 适用于隔离专网，HTTPS 默认验证服务器证书。</div></details>' +
    '<div class="bi-actions"><button class="btn" type="button" id="biSave" data-write>保存配置</button><button class="btn" type="button" id="biEnable" data-write>启用并保存</button><button class="btn danger" type="button" id="biDisable" data-write>停用转发</button><button class="btn" type="button" id="biPoll" data-write>立即采集 / 重试</button></div></section>' +
    '<section id="biMappingPanel" role="tabpanel" aria-labelledby="biTabMapping" hidden><div class="bi-mapping-heading"><div><h2>设备与测点映射</h2><p>选择设备，配置测点，再保存到 B 接口转发。</p></div><span class="bi-caption">搜索与筛选仅改变显示</span></div>' +
    '<div class="bi-mapping-stats" aria-label="当前草稿统计"><div><span>已选设备</span><strong id="biStatDevices">0</strong><small id="biStatDeviceTotal">共 0 个设备</small></div><div><span>已选测点</span><strong id="biStatPoints">0</strong><small id="biStatTypes">AI 0 · DI 0 · ALARM 0</small></div><div><span>待填写编号</span><strong id="biStatMissing">0</strong><small>已选测点中的空 ID</small></div></div>' +
    '<div class="bi-mapping-tools"><details id="biSourceTools" class="bi-tool"><summary>添加设备与批量工具<span>读取 DCIM / 导入 Modbus / 更新类型</span></summary><div class="bi-tool-content"><div class="bi-form bi-source-form"><label>DCIM 设备 ID<input id="biDeviceId" maxlength="80" placeholder="每次填写一个设备 ID，例如 3" data-write></label><label>DCIM 分组 ID（可留空）<input id="biGroupId" maxlength="80" data-write></label><label>DCIM serverCode<input id="biServerCode" value="1" maxlength="80" data-write></label></div><div class="bi-actions"><button class="btn" id="biLoadDevice" data-write>读取 DCIM 测点</button><button class="btn" id="biImport" data-write>导入 Modbus 已选设备</button><button class="btn" id="biClassifyModbus" data-write>按 Modbus 更新 AI/DI</button></div></div></details>' +
    '<details id="biAlarmTools" class="bi-tool"><summary>批量告警映射<span>读取定义 → 核对 → 导入草稿</span></summary><div class="bi-tool-content"><p class="bi-hint">按全部已勾选设备读取本机 DCIM MySQL 告警定义。已有映射保留；空 ID 生成不冲突测试编号，正式接入需标准编码。</p><div class="bi-actions"><button class="btn" id="biReadAlarmDefs" type="button">批量读取告警定义</button><button class="btn" id="biImportAlarmDefs" type="button" data-write>导入已识别告警</button></div><div id="biAlarmDefsPreview" hidden><p id="biAlarmDefsSummary" class="bi-hint" role="status"></p><div class="bi-actions"><button class="btn" id="biAlarmDefsPrev" type="button" data-bi-page-disabled="true">上一页告警定义</button><span class="bi-hint" id="biAlarmDefsPage"></span><button class="btn" id="biAlarmDefsNext" type="button" data-bi-page-disabled="true">下一页告警定义</button></div><div class="bi-scroll bi-alarm-preview-scroll" tabindex="0" role="region" aria-label="告警定义预览，可横向滚动"><table class="bi-table bi-alarm-def-table"><thead><tr><th scope="col">设备</th><th scope="col">规则 ID</th><th scope="col">告警名称</th><th scope="col">说明</th></tr></thead><tbody id="biAlarmDefsRows"></tbody></table></div></div></div></details></div>' +
    '<div class="bi-mapping-workspace"><aside class="bi-device-directory" aria-label="设备目录"><div class="bi-directory-heading"><h3>设备目录</h3><span id="biDeviceSelection" class="bi-hint" role="status"></span></div><label class="bi-search-field" for="biDeviceSearch">查找设备<input id="biDeviceSearch" type="search" placeholder="名称 / DCIM ID / 分组 / 编码" autocomplete="off"></label><div class="bi-actions bi-device-toolbar" role="group" aria-label="全部设备选择"><button class="btn" id="biSelectAllDevices" data-write>全选设备</button><button class="btn" id="biClearAllDevices" data-write>取消全选设备</button></div><p id="biDeviceSearchCount" class="bi-hint" role="status"></p><div id="biDeviceList"></div><div class="bi-actions bi-device-pager" aria-label="设备翻页"><button class="btn" id="biPrevDevices" aria-label="上一页设备" data-bi-page-disabled="true">上一页</button><span class="bi-hint" id="biDevicePage" role="status"></span><button class="btn" id="biNextDevices" aria-label="下一页设备" data-bi-page-disabled="true">下一页</button></div></aside><div id="biDevices" class="bi-device-editor"></div></div>' +
    '<details class="bi-tool bi-mapping-help"><summary>填写说明与高级映射</summary><div class="bi-tool-content"><p class="bi-hint">勾选设备及测点后才转发，告警名称需与 DCIM 返回名称完全一致。输入完整五位设备编码，将覆盖该设备所有测点的测试 ID（含筛选隐藏项、其他页及未勾选项）：五位设备编码 + 五位测点序号 + 00。仅供联调，正式接入须按联通标准编码表填写。</p><p class="bi-hint">CSV 导出全部已选设备的已选测点，包括未保存编辑。Excel 导入时将编码列设为文本，保留前导零。</p><label class="bi-search-field" for="biAlarmFields">告警字段映射（可选 JSON）</label><p class="bi-hint">默认自动识别；可配置 id、startedAt、recoveredAt、device、deviceId、alarmName、content、value。例：{"alarmName":"AlarmContent","deviceId":"DeviceId"}。</p><textarea id="biAlarmFields" rows="4" aria-label="告警字段映射 JSON" data-write>{}</textarea></div></details></section>' +
    '<section id="biRequestsPanel" role="tabpanel" aria-labelledby="biTabRequests" hidden><p class="bi-hint">按已保存的全部设备和测点，分别生成 AI / DI / ALARM 查询。修改映射后请先保存。将完整 SOAP 请求复制到 SoapUI 的 Request 1 左侧；请求地址使用下方 SU 地址。</p><div class="bi-actions"><label for="biQueryType">查询类型</label><select id="biQueryType"><option value="AI">AI 模拟量 · GET_AIDATA</option><option value="DI">DI 状态量 · GET_DIDATA</option><option value="ALARM">ALARM 当前告警 · GET_ALARM</option></select><button class="btn" type="button" id="biGenerateRequests">生成 / 刷新请求</button></div><p class="bi-hint" id="biQuerySummary"></p><label for="biQueryEndpoint">SoapUI 请求地址（SU）</label><input id="biQueryEndpoint" readonly><p class="bi-hint" id="biQueryHeaders"></p><div class="bi-actions"><button class="btn" type="button" id="biCopyRequest">复制完整 SOAP 请求</button><button class="btn" type="button" id="biDownloadRequest">下载请求 XML</button><button class="btn" type="button" id="biQueryPreview">本机响应预览</button></div><label for="biQueryXml">完整 SOAP 请求（复制到 Request 1 左侧）</label><textarea id="biQueryXml" readonly rows="16" spellcheck="false"></textarea><p class="bi-hint">业务报文名为 GET_*，HTTP 发送方式为 POST。每条报文覆盖该类型全部已配置设备和测点；ALARM 返回当前未恢复告警，无当前告警时列表为空。</p><details><summary>本机响应预览（最近采集数据）</summary><p class="bi-hint" id="biQueryCache"></p><pre id="biQueryResponse">点击本机响应预览查看；外部连接请使用 SoapUI 发送请求验证。</pre></details></section>' +
    '<section id="biPreviewPanel" role="tabpanel" aria-labelledby="biTabPreview" hidden><p class="bi-hint">读取已保存映射的 DCIM 实时数据，预览上级查询响应，不发送到 SC。</p><button class="btn" id="biPreview">刷新预览</button><pre id="biPreviewText">保存设备映射后刷新预览。</pre></section>' +
    '<section id="biLogsPanel" role="tabpanel" aria-labelledby="biTabLogs" hidden><div class="bi-actions"><span class="bi-hint">最近 200 条运行日志，业务 ACK 成功才视为发送完成。</span><button class="btn" id="biReloadLogs">刷新日志</button><span class="bi-hint" id="biLogCount" role="status"></span></div><div class="bi-scroll bi-log-scroll" tabindex="0" role="region" aria-label="运行日志表格，可横向滚动"><table class="bi-table bi-log-table" aria-label="B接口运行日志"><thead><tr><th scope="col">时间</th><th scope="col">报文</th><th scope="col">结果</th><th scope="col">说明</th></tr></thead><tbody id="biLogRows"></tbody></table></div></section></div>';
  document.body.appendChild(dialog);
  var ackTools = node('section'); ackTools.className = 'bi-wsdl';
  ackTools.innerHTML = '<strong>SoapUI / 告警 ACK 自动响应</strong><p class="bi-hint">按已保存的 SOAP 配置生成动态脚本，自动匹配 LOGIN、LOGOUT、SEND_ALARM 和 SEND_HISALARM，并返回对应 ACK。修改 SOAP 参数后请先保存。</p>' +
    '<div class="bi-actions"><button class="btn bi-primary" type="button" id="biCopyAckScript">复制告警 ACK 脚本</button><button class="btn" type="button" id="biCopyAckBody">复制响应正文</button></div>' +
    '<label for="biAckResponseBody">第 1 步：完整替换 SC MockService → 方法 → Response 1 的 XML 正文</label><input id="biAckResponseBody" readonly spellcheck="false" value="${bAckEnvelope}">' +
    '<p class="bi-hint">第 2 步：将脚本粘贴到同一个 Response 1 底部的 Script 标签，再启动 MockService。脚本放在 Script；XML 正文仅保留下方占位符，不要把脚本粘贴到 XML 正文或 Request 1。</p>' +
    '<details id="biAckScriptDetails"><summary>查看 / 复制 Groovy 脚本</summary><div class="bi-actions"><label for="biAckScriptText">动态 ACK 脚本（粘贴到 Response 1 → Script）</label><button class="btn" type="button" id="biCopyAckScriptInline">复制脚本</button><button class="btn" type="button" id="biRegenerateAckScript">重新生成</button></div><textarea id="biAckScriptText" readonly rows="14" spellcheck="false" placeholder="展开后按已保存配置自动生成脚本"></textarea></details>' +
    '<p class="bi-hint">用于 SoapUI 联调：返回成功 ACK，但不校验账号口令、不存储告警。每条请求使用自身 SUId；非法或不支持的报文返回 SOAP Fault。</p>';
  $('biWsdlUrl').closest('.bi-wsdl').after(ackTools);
  var mappingFooter = node('footer'); mappingFooter.id = 'biMappingFooter'; mappingFooter.className = 'bi-mapping-footer'; mappingFooter.hidden = true;
  mappingFooter.innerHTML = '<div><strong id="biDraftState" role="status">已保存</strong><span id="biSaveScope" class="bi-hint">保存全部已勾选设备和测点</span></div><div class="bi-actions"><button class="btn" id="biExportCsv" type="button">导出已选测点 CSV</button><button class="btn bi-primary" id="biSaveMapping" type="button" data-write>保存设备和测点</button></div>';
  dialog.appendChild(mappingFooter);
  var removeAllDeviceButton = node('button','移除全部设备'); removeAllDeviceButton.id = 'biRemoveAllDevices'; removeAllDeviceButton.type = 'button'; removeAllDeviceButton.className = 'btn danger'; removeAllDeviceButton.dataset.write = '';
  removeAllDeviceButton.setAttribute('aria-describedby','biRemoveAllDevicesHint'); $('biClearAllDevices').after(removeAllDeviceButton);
  var removeAllDevicesHint = node('p','仅移除全部已勾选设备（含隐藏页），保存后生效。'); removeAllDevicesHint.id = 'biRemoveAllDevicesHint'; removeAllDevicesHint.className = 'bi-hint'; $('biClearAllDevices').parentElement.after(removeAllDevicesHint);
  function $(id) { return document.getElementById(id); }
  var config = null, canManage = false, busy = false, timer = null, devices = [], controls = {};
  var queryRequests = [];
  var alarmDefinitions = null, alarmPreviewPage = 0;
  var devicePage = 0, pointPages = new Map(), DEVICE_PAGE_SIZE = 10, POINT_PAGE_SIZE = 25;
  var activeDeviceId = '', deviceSearch = '', pointFilters = new Map(), mappingDirty = false, summaryTimer = null;
  var mappingRemovalPending = false;
  var mappingView = window.PcBMappingView;
  var pointTypes = window.PcPointTypes;
  function node(tag, text) { var n = document.createElement(tag); if (text != null) n.textContent = text; return n; }
  function field(parent, key, label, kind, hint) {
    var wrapper = node('label', label), input;
    if (kind === 'version') { input = node('select'); ['1.1', '1.2'].forEach(function (v) { var option = node('option', v); option.value = v; input.appendChild(option); }); }
    else if (kind === 'boolean') { input = node('select'); [['true', '验证证书（推荐）'], ['false', '关闭验证（仅专网自签名）']].forEach(function (v) { var option = node('option', v[1]); option.value = v[0]; input.appendChild(option); }); }
    else { input = node(kind === 'textarea' ? 'textarea' : 'input'); if (kind === 'textarea') input.rows = 3; else input.type = kind || 'text'; }
    input.id = 'biField-' + key; input.dataset.write = ''; if (hint) input.placeholder = hint;
    if (kind === 'password') { input.autocomplete = 'new-password'; input.maxLength = 20; }
    wrapper.appendChild(input); parent.appendChild(wrapper); controls[key] = input;
  }
  [
    ['scUrls', 'SC 注册服务 URL（最多三行）', 'textarea', 'http://上级地址:端口/services/SCService'],
    ['allowedIps', '允许接入的上级 IP（逗号或换行分隔）', 'textarea', '填写 SC 的连接来源 IP'],
    ['suId', 'SU 编码（12 位 MAC，无分隔符）', 'text', '001122AABBCC'], ['suRId', 'SU 资管编码', 'text', '按上级平台分配'],
    ['suIp', 'SU 内网 IPv4（上级可访问）', 'text', '部署本软件的服务器 IP'], ['port', 'SU SOAP 服务端口', 'number'],
    ['userName', 'SC 注册用户名', 'text'], ['password', 'SC 注册口令', 'password', '留空保留已保存口令']
  ].forEach(function (f) { field($('biConfigForm'), f[0], f[1], f[2], f[3]); });
  [
    ['host', 'SU 监听 IP', 'text'], ['servicePath', 'SU 服务路径', 'text'], ['pollSec', 'DCIM 采集周期（秒）', 'number'],
    ['retrySec', '注册重试（60–600 秒）', 'number'], ['heartbeatSec', 'SC 心跳周期（秒，三周期超时）', 'number'], ['timeoutMs', 'SC 请求超时（毫秒）', 'number'],
    ['vendor', 'SU 厂家缩写', 'text'], ['model', 'SU 型号', 'text'], ['hardVer', 'SU 硬件版本', 'text'], ['suVer', 'SU B 接口版本', 'text'],
    ['longitude', '经度', 'number'], ['latitude', '纬度', 'number'], ['verifyTls', 'SC HTTPS 证书验证', 'boolean'],
    ['soap.version', 'SOAP 版本', 'version'], ['soap.namespace', 'SOAP 命名空间', 'text'], ['soap.method', 'SOAP 方法名', 'text'],
    ['soap.parameter', 'SOAP 请求参数名', 'text'], ['soap.result', 'SOAP 响应字段名', 'text'], ['soap.action', 'SOAPAction（可留空）', 'text']
  ].forEach(function (f) { field($('biAdvanced'), f[0], f[1], f[2]); });
  $('biConfigForm').onsubmit = function (e) { e.preventDefault(); };
  function permissions() {
    dialog.querySelectorAll('[data-write]').forEach(function (n) { n.disabled = busy || !canManage || !config; });
    dialog.querySelectorAll('[data-bi-page-disabled]').forEach(function (n) { n.disabled = busy || !config || n.dataset.biPageDisabled === 'true'; });
    ['biSelectAllDevices', 'biClearAllDevices'].forEach(function (id) { $(id).disabled = busy || !canManage || !config || !devices.length; });
    $('biRemoveAllDevices').disabled = busy || !canManage || !config || !devices.some(function (d) { return d.selected; });
    ['biPreview', 'biReloadLogs', 'biDownloadSuWsdl', 'biDownloadScWsdl', 'biCopyLoginAck', 'biCopyLoginAckInline', 'biCopyAckScript', 'biCopyAckScriptInline', 'biCopyAckBody', 'biRegenerateAckScript', 'biExportCsv'].forEach(function (id) { $(id).disabled = busy || !config; });
    $('biGenerateRequests').disabled = busy || !config;
    $('biReadAlarmDefs').disabled = busy || !config || !devices.some(function (d) { return d.selected; });
    $('biImportAlarmDefs').disabled = busy || !config || !canManage || !alarmDefinitions || !alarmDefinitions.candidates.length;
    $('biQueryType').disabled = busy || !queryRequests.length;
    ['biCopyRequest', 'biDownloadRequest', 'biQueryPreview'].forEach(function (id) { $(id).disabled = busy || !queryRequests.length; });
  }
  function notice(text) { $('biError').textContent = text || ''; }
  async function api(name, method, body) {
    var r = await fetch('/api/proto-conv/b-interface/' + name, { method: method || 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    var data = await r.json(); if (!r.ok || !data.ok) throw new Error(data.message || '请求失败 ' + r.status); return data;
  }
  async function action(fn) { if (busy) return; busy = true; notice(''); permissions(); try { await fn(); } catch (e) { notice(e.message); } finally { busy = false; permissions(); } }
  function status(s) {
    $('biStatus').textContent = (s.enabled ? '已启用' : '已停用') + ' · SU ' + (s.running ? '监听中' : '未监听') + ' · SC ' + (s.registered ? '已注册' : '未注册') + ' · ' + s.devices + ' 设备 / ' + s.points + ' 测点 · 待确认告警 ' + s.pending + (s.endpoint ? ' · ' + s.endpoint : '') + (s.lastError ? ' · ' + s.lastError : '');
    $('bInterfaceDot').className = 'dot ' + (s.running && s.registered ? 'on' : 'off');
    var endpoint = s.endpoint || (config && config.suIp ? 'http://' + config.suIp + ':' + config.port + config.servicePath : '');
    $('biWsdlUrl').value = endpoint ? endpoint + '?wsdl' : '';
    $('biWsdlHint').textContent = s.running ? '可直接复制此地址到 SoapUI 的 Initial WSDL；访问电脑 IP 必须在上级白名单中。' : 'SU 尚未监听，在线地址暂不可访问；填写并保存地址后，可以先下载本地 WSDL，无需启用转发。';
  }
  function load(c) {
    config = c;
    mappingDirty = false; clearTimeout(summaryTimer); summaryTimer = null;
    mappingRemovalPending = false;
    alarmDefinitions = null; $('biAlarmDefsPreview').hidden = true;
    $('biLoginAckXml').value = ''; $('biLoginAckXml').closest('details').open = false;
    $('biLoginAckXml').placeholder = '展开后自动生成 LOGIN_ACK 响应';
    $('biAckScriptText').value = ''; $('biAckScriptDetails').open = false;
    $('biAckScriptText').placeholder = '展开后按已保存配置自动生成脚本';
    queryRequests = []; $('biQueryXml').value = ''; $('biQueryEndpoint').value = ''; $('biQuerySummary').textContent = '保存配置后点击查询请求生成。'; $('biQueryHeaders').textContent = ''; clearQueryResponse();
    Object.keys(controls).forEach(function (k) { var parts = k.split('.'), val = parts.length > 1 ? c.soap[parts[1]] : c[k]; controls[k].value = Array.isArray(val) ? val.join('\n') : val == null ? '' : String(val); });
    controls.password.placeholder = c.hasPassword ? '已保存口令，留空保留' : '填写 SC 注册口令';
    devices = c.devices.map(function (d) { return Object.assign({}, d, { selected: true, params: d.params.map(function (s) { return Object.assign({}, s, { selected: true }); }) }); });
    pointPages.clear();
    $('biAlarmFields').value = JSON.stringify(c.alarmFields, null, 2); renderDevices();
  }
  function readConfig(enabled) {
    var next = { enabled: enabled, soap: {} };
    Object.keys(controls).forEach(function (k) {
      var input = controls[k], val = input.value.trim();
      if (input.type === 'password') val = input.value;
      if (input.type === 'number') val = Number(val);
      if (k === 'verifyTls') val = val === 'true';
      if (k === 'scUrls' || k === 'allowedIps') val = val.split(k === 'scUrls' ? /\r?\n/ : /[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (k.indexOf('soap.') === 0) next.soap[k.slice(5)] = val; else next[k] = val;
    });
    next.alarmFields = JSON.parse($('biAlarmFields').value || '{}');
    next.devices = devices.filter(function (d) { return d.selected; }).map(function (d) {
      var out = Object.assign({}, d); delete out.selected;
      out.params = d.params.filter(function (s) { return s.selected; }).map(function (s) { var point = Object.assign({}, s); delete point.selected; return point; }); return out;
    });
    return next;
  }
  async function save(enabled) { var r = await api('config', 'PUT', readConfig(enabled)); load(r.config); status(r.status); notice(enabled ? '配置已保存并启用；等待 SC 注册结果，请查看运行日志。' : '配置已保存。'); }
  async function downloadWsdl(kind) {
    var r = await fetch('/api/proto-conv/b-interface/wsdl/' + kind, { credentials: 'same-origin' });
    if (!r.ok) { var error = await r.json(); throw new Error(error.message || 'WSDL 下载失败 ' + r.status); }
    var url = URL.createObjectURL(await r.blob()), link = node('a');
    link.href = url; link.download = kind === 'su' ? 'SUService.wsdl' : 'SCService.wsdl';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    notice('已下载 ' + link.download + '，在 SoapUI 的 Initial WSDL 中选择此文件。');
  }
  $('biDownloadSuWsdl').onclick = function () { action(function () { return downloadWsdl('su'); }); };
  $('biDownloadScWsdl').onclick = function () { action(function () { return downloadWsdl('sc'); }); };
  async function generateLoginAck() {
    var area = $('biLoginAckXml'); area.value = ''; area.placeholder = '正在生成 LOGIN_ACK 响应…';
    try { var r = await api('mock-login-ack'); area.value = r.xml; return r.xml; }
    catch (e) { area.placeholder = '生成失败，请查看上方提示，修正后重新展开或点击复制。'; throw e; }
  }
  $('biLoginAckXml').closest('details').addEventListener('toggle', function () {
    if (this.open && config && !$('biLoginAckXml').value) action(async function () { await generateLoginAck(); notice('已生成 LOGIN_ACK 响应，可点击响应框旁的「复制完整响应」。'); });
  });
  $('biCopyLoginAck').onclick = $('biCopyLoginAckInline').onclick = function () { action(async function () {
    var area = $('biLoginAckXml'), xml = await generateLoginAck(); area.closest('details').open = true;
    var copied = false;
    try { if (navigator.clipboard) { await navigator.clipboard.writeText(xml); copied = true; } } catch (_e) {}
    if (!copied) { area.focus(); area.select(); try { copied = document.execCommand('copy'); } catch (_e) {} }
    notice(copied ? '已复制完整 LOGIN_ACK 响应。粘贴到 SoapUI 的 SC MockService → invoke → Response 1，完整替换原内容，并启动 MockService。' : '已选中完整 LOGIN_ACK 响应，请按 Ctrl+C 复制，再粘贴到 SoapUI 的 SC MockService → invoke → Response 1。');
  }); };
  async function generateAckScript() {
    var area = $('biAckScriptText'); area.value = ''; area.placeholder = '正在生成动态 ACK 脚本…';
    try {
      var result = await api('mock-ack-script');
      if (!result.script || result.responseBody !== '${bAckEnvelope}') throw new Error('ACK 脚本内容无效，请重新生成');
      area.value = result.script; $('biAckResponseBody').value = result.responseBody; return result;
    } catch (e) { area.placeholder = '生成失败，请查看上方提示，修正后点击重新生成。'; throw e; }
  }
  async function copyAckText(area, success, manual) {
    var copied = false;
    try { if (navigator.clipboard) { await navigator.clipboard.writeText(area.value); copied = true; } } catch (_e) {}
    if (!copied) { area.focus(); area.select(); try { copied = document.execCommand('copy'); } catch (_e) {} }
    notice(copied ? success : manual);
  }
  $('biAckScriptDetails').addEventListener('toggle', function () {
    if (this.open && config && !$('biAckScriptText').value) action(async function () { await generateAckScript(); notice('已生成动态 ACK 脚本，粘贴到 SC MockService → 方法 → Response 1 → Script。'); });
  });
  $('biRegenerateAckScript').onclick = function () { action(async function () { await generateAckScript(); notice('已按保存的 SOAP 配置重新生成脚本。'); }); };
  $('biCopyAckScript').onclick = $('biCopyAckScriptInline').onclick = function () { action(async function () {
    await generateAckScript(); $('biAckScriptDetails').open = true;
    await copyAckText($('biAckScriptText'), '已复制告警 ACK 脚本。粘贴到 SC MockService → 方法 → Response 1 → Script，并用「复制响应正文」替换 XML 正文。', '已选中完整 ACK 脚本，请按 Ctrl+C 复制，粘贴到 Response 1 底部的 Script。');
  }); };
  $('biCopyAckBody').onclick = function () { action(async function () {
    await generateAckScript();
    await copyAckText($('biAckResponseBody'), '已复制响应正文 ${bAckEnvelope}，完整替换 SC MockService → 方法 → Response 1 的 XML 正文。', '已选中响应正文，请按 Ctrl+C 复制，完整替换 Response 1 的 XML 正文。');
  }); };
  function editable(parent, label, obj, key, type) {
    var wrapper = node('label', label), input = node('input'); input.type = type || 'text'; input.value = obj[key] || ''; input.dataset.write = '';
    input.autocomplete = 'off'; input.spellcheck = false;
    input.oninput = function () { obj[key] = input.value.trim(); }; wrapper.appendChild(input); parent.appendChild(wrapper); return input;
  }
  function checkbox(parent, checked, change, label) { var input = node('input'); input.type = 'checkbox'; input.checked = checked; input.dataset.write = ''; input.setAttribute('aria-label', label); input.onchange = function () { change(input.checked); }; parent.appendChild(input); return input; }
  function markMappingDirty() { mappingDirty = true; $('biDraftState').textContent = '有未保存修改'; $('biDraftState').className = 'bi-draft-pending'; }
  function updateMappingSummary() {
    var counts = mappingView.summary(devices);
    $('biStatDevices').textContent = counts.selectedDevices; $('biStatDeviceTotal').textContent = '共 ' + counts.devices + ' 个设备';
    $('biStatPoints').textContent = counts.points; $('biStatTypes').textContent = 'AI ' + counts.AI + ' · DI ' + counts.DI + ' · ALARM ' + counts.ALARM;
    $('biStatMissing').textContent = counts.missingIds; $('biStatMissing').className = counts.missingIds ? 'bi-number-warning' : '';
    $('biSaveScope').textContent = '保存全部已选 ' + counts.selectedDevices + ' 个设备 / ' + counts.points + ' 个测点';
    $('biDraftState').textContent = mappingDirty ? '有未保存修改' : '已保存'; $('biDraftState').className = mappingDirty ? 'bi-draft-pending' : '';
  }
  function updateDeviceControls() {
    var filtered = mappingView.filterDevices(devices,deviceSearch), totalPages = Math.max(1, Math.ceil(filtered.length / DEVICE_PAGE_SIZE));
    $('biDeviceSelection').textContent = '已选 ' + devices.filter(function (d) { return d.selected; }).length + ' / 共 ' + devices.length + ' 个设备';
    $('biDevicePage').textContent = (devicePage + 1) + ' / ' + totalPages;
    $('biDeviceSearchCount').textContent = deviceSearch ? '找到 ' + filtered.length + ' 个设备 · 全选操作仍覆盖全部设备' : '点击设备名称编辑 · 每页 ' + DEVICE_PAGE_SIZE + ' 个';
    $('biPrevDevices').dataset.biPageDisabled = String(devicePage === 0);
    $('biNextDevices').dataset.biPageDisabled = String(devicePage >= totalPages - 1);
    $('biReadAlarmDefs').disabled = busy || !config || !devices.some(function (d) { return d.selected; });
    updateMappingSummary();
  }
  function renderDirectory() {
    var list = $('biDeviceList'), scrollTop = list.scrollTop;
    var visible = mappingView.filterDevices(devices,deviceSearch).slice(devicePage * DEVICE_PAGE_SIZE, (devicePage + 1) * DEVICE_PAGE_SIZE), fragment = document.createDocumentFragment();
    visible.forEach(function (d) {
      var item = node('div'); item.className = 'bi-directory-item' + (d.deviceId === activeDeviceId ? ' is-active' : '');
      var check = checkbox(item,d.selected,function (v) { d.selected = v; markMappingDirty(); renderDirectory(); var active = $('biDevices').querySelector('[data-bi-device]'); if (active && active.dataset.biDevice === d.deviceId) active.checked = v; updateDeviceControls(); Array.from(list.querySelectorAll('[data-bi-directory-device]')).find(function (n) { return n.dataset.biDirectoryDevice === d.deviceId; }).focus({ preventScroll: true }); },'转发设备 ' + d.deviceName);
      check.dataset.biDirectoryDevice = d.deviceId;
      var button = node('button'); button.type = 'button'; button.className = 'bi-directory-button'; button.dataset.biOpenDevice = d.deviceId;
      button.setAttribute('aria-label','编辑设备 ' + d.deviceName + ' · DCIM ' + d.deviceId); button.setAttribute('aria-pressed',String(d.deviceId === activeDeviceId)); button.title = d.deviceName;
      button.appendChild(node('strong',d.deviceName));
      button.appendChild(node('span','DCIM ' + d.deviceId + ' · 分组 ' + (d.groupId || '未设置')));
      var count = node('small',d.params.filter(function (p) { return p.selected; }).length + ' / ' + d.params.length + ' 测点'); button.appendChild(count);
      button.onclick = function () { activeDeviceId = d.deviceId; renderDevices(); Array.from(list.querySelectorAll('[data-bi-open-device]')).find(function (n) { return n.dataset.biOpenDevice === d.deviceId; }).focus({ preventScroll: true }); };
      item.appendChild(button); fragment.appendChild(item);
    });
    if (!visible.length) { var empty = node('p',devices.length ? '没有匹配的设备，请调整搜索词。' : '还没有设备，请展开上方「添加设备与批量工具」。'); empty.className = 'bi-empty'; fragment.appendChild(empty); }
    list.replaceChildren(fragment); list.scrollTop = scrollTop; permissions();
  }
  function selectAllDevices(selected) {
    // Change the full draft, including hidden pages; point selections and codes stay intact.
    devices.forEach(function (d) { d.selected = selected; });
    $('biDevices').querySelectorAll('[data-bi-device]').forEach(function (input) { input.checked = selected; });
    markMappingDirty(); renderDirectory(); updateDeviceControls(); permissions();
  }
  function renderPoint(d, point, refresh, selectionChanged) {
    var row = node('tr'), checkCell = node('td'); var pointCheck = checkbox(checkCell, point.selected, function (v) { point.selected = v; selectionChanged(); }, '转发 ' + (point.paraName || point.alarmName)); pointCheck.dataset.biPoint = ''; row.appendChild(checkCell);
    var typeCell = node('td'), select = node('select'); select.dataset.write = ''; select.setAttribute('aria-label', '测点类型'); ['AI', 'DI', 'ALARM'].forEach(function (s) { var opt = node('option', { AI: 'AI（模拟量）', DI: 'DI（状态量）', ALARM: 'ALARM（告警）' }[s]); opt.value = s; select.appendChild(opt); }); select.value = point.type;
    select.onchange = function () { point.type = select.value; markMappingDirty(); var filter = pointFilters.get(d.deviceId); if (filter && filter.type !== 'ALL' && filter.type !== point.type) { refresh(); return; } var replacement = renderPoint(d, point, refresh, selectionChanged); row.replaceWith(replacement); selectionChanged(); permissions(); replacement.querySelector('select').focus(); }; typeCell.appendChild(select); row.appendChild(typeCell);
    var sourceCell = node('td'); editable(sourceCell, point.type === 'ALARM' ? '精确告警名称' : 'DCIM 参数名', point, point.type === 'ALARM' ? 'alarmName' : 'paraName'); row.appendChild(sourceCell);
    var idCell = node('td'); idCell.className = 'bi-signal'; var idInput = editable(idCell, '12 位 ID', point, 'signalId'); idInput.dataset.biSignalIndex = String(d.params.indexOf(point)); idInput.maxLength = 12; idInput.inputMode = 'numeric'; idInput.placeholder = point.type === 'ALARM' ? '按告警编码表填写' : '末两位为 00'; row.appendChild(idCell);
    var removeCell = node('td'), remove = node('button', '移除'); remove.className = 'btn bi-remove-point'; remove.dataset.write = ''; remove.onclick = function () { var index = d.params.indexOf(point); if (index >= 0) d.params.splice(index, 1); markMappingDirty(); refresh(); }; removeCell.appendChild(remove); row.appendChild(removeCell);
    return row;
  }
  function renderDevice(d) {
    var card = node('article'); card.className = 'bi-device';
    var heading = node('h3'); var deviceCheck = checkbox(heading, d.selected, function (v) { d.selected = v; markMappingDirty(); renderDirectory(); updateDeviceControls(); }, '转发设备 ' + d.deviceName); deviceCheck.dataset.biDevice = d.deviceId;
    heading.appendChild(node('span', d.deviceName)); card.appendChild(heading);
    var groupId = String(d.groupId == null ? '' : d.groupId).trim();
    var groupLabel = node('p', 'DCIM ' + d.deviceId + ' · 分组 ID：' + (groupId || '未设置') + ' · serverCode：' + (d.serverCode || '1')); groupLabel.className = 'bi-hint bi-device-meta';
    groupLabel.title = '当前设备配置的 DCIM 分组 ID；未设置时按设备 ID 查询。'; card.appendChild(groupLabel);
    var fields = node('div'); fields.className = 'bi-form'; var code = editable(fields, '联通五位设备编码', d, 'bDeviceId'); code.maxLength = 5; code.inputMode = 'numeric'; editable(fields, '设备资管编码', d, 'rId').maxLength = 120; card.appendChild(fields);
    var codeHint = node('p', '输入完整五位编码会覆盖本设备全部测点的测试 ID，含未勾选及隐藏项。正式接入请使用标准编号。'); codeHint.className = 'bi-code-hint'; card.appendChild(codeHint);
    var filter = pointFilters.get(d.deviceId) || { type: 'ALL', query: '' }; pointFilters.set(d.deviceId,filter);
    var filterBar = node('div'); filterBar.className = 'bi-point-filters';
    var typeGroup = node('div'); typeGroup.className = 'bi-type-filters'; typeGroup.setAttribute('role','group'); typeGroup.setAttribute('aria-label','测点类型筛选');
    var typeButtons = {};
    ['ALL','AI','DI','ALARM'].forEach(function (type) {
      var button = node('button'); button.type = 'button'; button.className = 'bi-type-filter'; button.dataset.biFilterType = type;
      button.setAttribute('aria-label',{ ALL: '全部测点', AI: 'AI 模拟量', DI: 'DI 状态量', ALARM: 'ALARM 告警' }[type]);
      button.onclick = function () { filter.type = type; pointPages.set(d.deviceId,0); renderPoints(); };
      typeGroup.appendChild(button); typeButtons[type] = button;
    });
    var searchLabel = node('label','搜索测点'); searchLabel.className = 'bi-point-search';
    var search = node('input'); search.type = 'search'; search.placeholder = '参数 / 告警名称 / 监控 ID'; search.autocomplete = 'off'; search.value = filter.query;
    search.oninput = function () { filter.query = search.value; pointPages.set(d.deviceId,0); renderPoints(); }; searchLabel.appendChild(search);
    filterBar.appendChild(typeGroup); filterBar.appendChild(searchLabel); card.appendChild(filterBar);
    var pointToolbar = node('div'); pointToolbar.className = 'bi-actions'; pointToolbar.setAttribute('role', 'group'); pointToolbar.setAttribute('aria-label', '本设备全部测点选择');
    var selectPoints = node('button', '全选测点'), clearPoints = node('button', '取消全选测点'), pointSelection = node('span');
    [selectPoints, clearPoints].forEach(function (b) { b.className = 'btn'; b.dataset.write = ''; });
    pointSelection.className = 'bi-hint'; pointSelection.setAttribute('role', 'status');
    pointToolbar.appendChild(selectPoints); pointToolbar.appendChild(clearPoints); pointToolbar.appendChild(pointSelection); card.appendChild(pointToolbar);
    var pointPager = node('div'); pointPager.className = 'bi-actions bi-point-pager';
    var prev = node('button', '上一页测点'), next = node('button', '下一页测点'), info = node('span'); info.className = 'bi-hint'; info.setAttribute('role', 'status');
    [prev, next].forEach(function (b) { b.className = 'btn'; b.dataset.biPageDisabled = 'true'; });
    pointPager.appendChild(prev); pointPager.appendChild(info); pointPager.appendChild(next);
    var wrap = node('div'); wrap.className = 'bi-scroll bi-point-scroll'; wrap.tabIndex = 0; wrap.setAttribute('role','region'); wrap.setAttribute('aria-label','测点编辑表格，可横向滚动');
    var table = node('table'); table.className = 'bi-table bi-point-table';
    var head = node('tr'); ['转发', '类型', 'DCIM 参数 / 告警名称', '联通十二位监控信息 ID', '操作'].forEach(function (s) { var th = node('th',s); th.scope = 'col'; head.appendChild(th); }); var thead = node('thead'); thead.appendChild(head); table.appendChild(thead);
    var tbody = node('tbody'); table.appendChild(tbody); wrap.appendChild(table); card.appendChild(wrap);
    function updatePointSelection() {
      pointSelection.textContent = '已选 ' + d.params.filter(function (point) { return point.selected; }).length + ' / 共 ' + d.params.length + ' 个测点（含所有类型和分页）';
      Object.keys(typeButtons).forEach(function (type) { typeButtons[type].textContent = (type === 'ALL' ? '全部' : type) + ' ' + d.params.filter(function (p) { return type === 'ALL' || p.type === type; }).length; typeButtons[type].setAttribute('aria-pressed',String(filter.type === type)); });
      renderDirectory(); updateDeviceControls();
    }
    function selectAllPoints(selected) {
      d.params.forEach(function (point) { point.selected = selected; });
      tbody.querySelectorAll('[data-bi-point]').forEach(function (input) { input.checked = selected; });
      markMappingDirty(); updatePointSelection();
    }
    selectPoints.onclick = function () { selectAllPoints(true); };
    clearPoints.onclick = function () { selectAllPoints(false); };
    function fillTestIds() {
      if (!/^\d{5}$/.test(d.bDeviceId)) return;
      window.PcBTestIds.fill(d);
      tbody.querySelectorAll('[data-bi-signal-index]').forEach(function (input) { var point = d.params[Number(input.dataset.biSignalIndex)]; if (point) input.value = point.signalId; });
      markMappingDirty(); updateMappingSummary(); notice('已更新本设备全部 ' + d.params.length + ' 个监控信息 ID 为测试编号（含其他页及未勾选测点）。仅供联调，请保存后使用。');
    }
    code.addEventListener('input', fillTestIds);
    function renderPoints(initial) {
      var filtered = mappingView.filterPoints(d.params,filter.type,filter.query), total = Math.max(1, Math.ceil(filtered.length / POINT_PAGE_SIZE));
      var page = Math.max(0, Math.min(pointPages.get(d.deviceId) || 0, total - 1)); pointPages.set(d.deviceId, page);
      var fragment = document.createDocumentFragment();
      filtered.slice(page * POINT_PAGE_SIZE, (page + 1) * POINT_PAGE_SIZE).forEach(function (point) { fragment.appendChild(renderPoint(d, point, renderPoints, function () { markMappingDirty(); updatePointSelection(); })); });
      if (!filtered.length) { var row = node('tr'), cell = node('td',d.params.length ? '没有匹配的测点，请调整类型或搜索词。' : '暂无测点，可读取 DCIM 测点或添加告警映射。'); cell.colSpan = 5; cell.className = 'bi-empty'; row.appendChild(cell); fragment.appendChild(row); }
      tbody.replaceChildren(fragment); pointPager.hidden = filtered.length <= POINT_PAGE_SIZE;
      updatePointSelection();
      info.textContent = '第 ' + (page + 1) + ' / ' + total + ' 页 · 当前显示 ' + filtered.length + ' 个';
      prev.dataset.biPageDisabled = String(page === 0); next.dataset.biPageDisabled = String(page >= total - 1);
      if (!initial) permissions();
    }
    prev.onclick = function () { pointPages.set(d.deviceId, (pointPages.get(d.deviceId) || 0) - 1); renderPoints(); };
    next.onclick = function () { pointPages.set(d.deviceId, (pointPages.get(d.deviceId) || 0) + 1); renderPoints(); };
    card.appendChild(pointPager);
    var actions = node('div'); actions.className = 'bi-actions bi-editor-actions'; var add = node('button', '添加告警映射'); add.className = 'btn'; add.dataset.write = ''; add.onclick = function () { d.params.push({ type: 'ALARM', paraName: '', alarmName: '', signalId: '', selected: true }); filter.type = 'ALARM'; filter.query = ''; search.value = ''; pointPages.set(d.deviceId, Math.floor((mappingView.filterPoints(d.params,'ALARM','').length - 1) / POINT_PAGE_SIZE)); markMappingDirty(); renderPoints(); tbody.querySelectorAll('input:not([type="checkbox"])')[tbody.querySelectorAll('input:not([type="checkbox"])').length - 2].focus(); }; actions.appendChild(add);
    var fillButton = node('button', '按当前设备编码生成测试 ID'); fillButton.className = 'btn'; fillButton.dataset.write = ''; fillButton.onclick = function () { if (!/^\d{5}$/.test(d.bDeviceId)) { notice('请先输入五位数字设备编码。'); return; } fillTestIds(); }; actions.appendChild(fillButton);
    var removeDevice = node('button', '移除设备'); removeDevice.className = 'btn danger'; removeDevice.dataset.write = ''; removeDevice.onclick = function () { var index = devices.indexOf(d); if (index >= 0) devices.splice(index, 1); pointPages.delete(d.deviceId); pointFilters.delete(d.deviceId); markMappingDirty(); renderDevices(); }; actions.appendChild(removeDevice); card.appendChild(actions);
    renderPoints(true); return card;
  }
  function renderDevices() {
    var filtered = mappingView.filterDevices(devices,deviceSearch);
    devicePage = Math.max(0, Math.min(devicePage, Math.ceil(filtered.length / DEVICE_PAGE_SIZE) - 1));
    var visible = filtered.slice(devicePage * DEVICE_PAGE_SIZE, (devicePage + 1) * DEVICE_PAGE_SIZE);
    if (!visible.some(function (d) { return d.deviceId === activeDeviceId; })) activeDeviceId = visible.length ? visible[0].deviceId : '';
    var fragment = document.createDocumentFragment();
    var active = visible.find(function (d) { return d.deviceId === activeDeviceId; });
    if (active) fragment.appendChild(renderDevice(active));
    else { var empty = node('div'); empty.className = 'bi-editor-empty'; empty.appendChild(node('h3',devices.length ? '没有匹配的设备' : '开始配置设备')); empty.appendChild(node('p',devices.length ? '调整左侧搜索词即可继续编辑。已有草稿会保留。' : '从 DCIM 读取设备，或导入 Modbus 已选设备，再配置转发测点。')); fragment.appendChild(empty); }
    if (!devices.length) $('biSourceTools').open = true;
    $('biDevices').replaceChildren(fragment); renderDirectory(); updateDeviceControls(); permissions();
  }
  function mergeDevice(d, refreshSource) {
    var old = devices.find(function (x) { return x.deviceId === d.deviceId; });
    if (old) {
      if (refreshSource === true) {
        old.groupId = d.groupId; old.serverCode = d.serverCode;
        if (d.deviceName && d.deviceName !== d.deviceId) old.deviceName = d.deviceName;
      }
      (d.params || []).forEach(function (p) { if (!old.params.some(function (s) { return s.paraName === p.paraName && s.type !== 'ALARM'; })) old.params.push(newPoint(p)); });
    } else devices.push(Object.assign({}, d, { selected: true, bDeviceId: '', rId: '', params: (d.params || []).map(newPoint) }));
  }
  function newPoint(p) { return Object.assign({}, p, { type: pointTypes.inferType(p) || (p.type === 'DI' ? 'DI' : 'AI'), signalId: '', alarmName: '', selected: false }); }
  function updateModbusTypes(catalog) {
    var types = new Map(), changed = 0, matched = 0, unknown = 0;
    catalog.forEach(function (d) { (d.params || []).forEach(function (p) {
      var key = String(d.deviceId) + '\0' + String(p.paraName), inferred = pointTypes.inferType(p);
      types.set(key, types.has(key) && types.get(key) !== inferred ? null : inferred);
    }); });
    devices.forEach(function (d) { d.params.forEach(function (p) {
      if (p.type === 'ALARM') return;
      var inferred = types.get(String(d.deviceId) + '\0' + p.paraName);
      if (!inferred) { unknown++; return; }
      matched++; if (p.type !== inferred) { p.type = inferred; changed++; }
    }); });
    if (changed) markMappingDirty(); renderDevices(); notice('匹配 ' + matched + ' 个测点，更新 ' + changed + ' 个类型；' + unknown + ' 个未匹配或类型未识别，保留当前选择。编码和勾选已保留，请核对后保存。');
  }
  async function logs() {
    var r = await api('logs'), fragment = document.createDocumentFragment();
    var results = { success: ['成功', 'success'], failed: ['失败', 'failed'], fallback: ['回退查询', 'warning'], partial: ['部分失败', 'warning'], received: ['已接收', 'received'], skipped: ['已跳过', 'neutral'], unsupported: ['未支持', 'neutral'] };
    r.logs.slice().reverse().forEach(function (l) {
      var row = node('tr'), timeCell = node('td'), at = String(l.at || '');
      var time = node('time', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) ? at.replace(' ', '\n') : at); time.className = 'bi-log-time'; time.title = at; timeCell.appendChild(time); row.appendChild(timeCell);
      var name = node('td', l.name); name.className = 'bi-log-name'; row.appendChild(name);
      var resultCell = node('td'), result = Object.prototype.hasOwnProperty.call(results, l.result) ? results[l.result] : [l.result || '—', 'neutral'];
      var badge = node('span', result[0]); badge.className = 'bi-log-result bi-log-result-' + result[1]; badge.title = String(l.result || ''); resultCell.appendChild(badge); row.appendChild(resultCell);
      var message = node('td', l.message); message.className = 'bi-log-message'; row.appendChild(message); fragment.appendChild(row);
    });
    if (!r.logs.length) { var emptyRow = node('tr'), emptyCell = node('td', '暂无运行日志'); emptyCell.colSpan = 4; emptyCell.className = 'bi-log-empty'; emptyRow.appendChild(emptyCell); fragment.appendChild(emptyRow); }
    $('biLogRows').replaceChildren(fragment); $('biLogCount').textContent = '显示 ' + r.logs.length + ' 条 · 最新在前';
  }
  var tabs = ['Config', 'Mapping', 'Requests', 'Preview', 'Logs'];
  tabs.forEach(function (name, i) {
    var tab = $('biTab' + name);
    tab.tabIndex = i === 0 ? 0 : -1;
    tab.onclick = function () { tabs.forEach(function (n) { $('bi' + n + 'Panel').hidden = name !== n; $('biTab' + n).setAttribute('aria-selected', String(name === n)); $('biTab' + n).tabIndex = name === n ? 0 : -1; }); mappingFooter.hidden = name !== 'Mapping'; dialog.classList.toggle('is-mapping',name === 'Mapping'); dialog.querySelector('.bi-body').scrollTop = 0; if (name === 'Logs') action(logs); if (name === 'Requests' && config) action(generateRequests); };
    tab.onkeydown = function (e) { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; $('biTab' + next).click(); $('biTab' + next).focus(); } };
  });
  $('biClose').onclick = function () { dialog.close(); };
  dialog.addEventListener('close', function () { clearInterval(timer); timer = null; clearTimeout(summaryTimer); summaryTimer = null; entry.focus(); });
  entry.onclick = function () {
    activeDeviceId = ''; deviceSearch = ''; $('biDeviceSearch').value = ''; devicePage = 0; pointFilters.clear();
    canManage = false; config = null; permissions(); $('biStatus').textContent = '正在读取配置…';
    dialog.showModal();
    action(async function () { var r = await api('config'); canManage = r.canManage; load(r.config); status(r.status); if (!canManage) notice('当前账户为只读，可以查看配置、预览和运行日志。'); });
    clearInterval(timer); timer = setInterval(function () { if (dialog.open && !busy) api('status').then(function (r) { status(r.status); }).catch(function (e) { notice(e.message); }); }, 5000);
  };
  $('biSave').onclick = function () { action(function () { return save(config.enabled); }); };
  $('biSaveMapping').onclick = function () { action(async function () {
    var stopForRemoval = config.enabled && mappingRemovalPending && !devices.some(function (d) { return d.selected && d.params.some(function (point) { return point.selected; }); });
    await save(stopForRemoval ? false : config.enabled);
    if (stopForRemoval) notice('配置已保存；设备测点映射已清空，B 接口转发已停用。');
  }); };
  $('biSelectAllDevices').onclick = function () { selectAllDevices(true); };
  $('biClearAllDevices').onclick = function () { selectAllDevices(false); };
  $('biRemoveAllDevices').onclick = function () {
    if (busy || !canManage || !config) return;
    var removed = devices.filter(function (d) { return d.selected; }); if (!removed.length) return;
    devices = devices.filter(function (d) { return !d.selected; });
    mappingRemovalPending = true;
    removed.forEach(function (d) { pointPages.delete(d.deviceId); pointFilters.delete(d.deviceId); });
    alarmDefinitions = null; $('biAlarmDefsPreview').hidden = true; clearTimeout(summaryTimer); summaryTimer = null;
    activeDeviceId = ''; deviceSearch = ''; $('biDeviceSearch').value = ''; devicePage = 0;
    markMappingDirty(); renderDevices();
    notice('已移除 ' + removed.length + ' 个已勾选设备及其全部测点，未勾选设备保留。仅更新草稿，点击「保存设备和测点」后生效。' + (config.enabled ? '保存空映射时将同时停用 B 接口转发。' : ''));
    $('biDeviceSearch').focus({ preventScroll: true });
  };
  $('biClassifyModbus').onclick = function () { action(async function () { var r = await api('inherited-devices'); updateModbusTypes(r.devices); }); };
  $('biDeviceSearch').oninput = function () { deviceSearch = this.value; devicePage = 0; $('biDeviceList').scrollTop = 0; renderDevices(); };
  $('biDevices').addEventListener('input',function (event) {
    if (!event.target.hasAttribute('data-write')) return;
    markMappingDirty(); clearTimeout(summaryTimer); summaryTimer = setTimeout(updateMappingSummary,180);
  });
  $('biAlarmFields').oninput = markMappingDirty;
  function selectedDeviceIds() { return devices.filter(function (d) { return d.selected; }).map(function (d) { return d.deviceId; }).sort(); }
  function renderAlarmDefinitions() {
    var all = alarmDefinitions.candidates.map(function (item) { return Object.assign({}, item, { reason: '已识别，可导入；已有映射保留' }); }).concat(alarmDefinitions.review);
    var pages = Math.max(1, Math.ceil(all.length / 25)); alarmPreviewPage = Math.max(0, Math.min(alarmPreviewPage, pages - 1));
    var fragment = document.createDocumentFragment();
    all.slice(alarmPreviewPage * 25, (alarmPreviewPage + 1) * 25).forEach(function (item) {
      var d = devices.find(function (device) { return device.deviceId === item.deviceId; }), row = node('tr');
      [d ? d.deviceName + ' · DCIM ' + item.deviceId : item.deviceId, item.ruleId, item.alarmName || item.baseName, item.reason].forEach(function (text) { row.appendChild(node('td', text)); });
      fragment.appendChild(row);
    });
    if (!all.length) { var row = node('tr'), cell = node('td', '所选设备暂无告警定义'); cell.colSpan = 4; row.appendChild(cell); fragment.appendChild(row); }
    $('biAlarmDefsRows').replaceChildren(fragment); $('biAlarmDefsPreview').hidden = false;
    $('biAlarmDefsSummary').textContent = '读取 ' + alarmDefinitions.ruleCount + ' 条定义 · 可导入 ' + alarmDefinitions.candidates.length + ' 个告警映射 · 待核对 ' + alarmDefinitions.review.length + ' 项。按已填上下限和告警特征值生成事件映射，多状态使用对应描述；待核对项不自动导入。';
    $('biAlarmDefsPage').textContent = '第 ' + (alarmPreviewPage + 1) + ' / ' + pages + ' 页 · 每页 25 项';
    $('biAlarmDefsPrev').dataset.biPageDisabled = String(alarmPreviewPage === 0); $('biAlarmDefsNext').dataset.biPageDisabled = String(alarmPreviewPage >= pages - 1); permissions();
  }
  $('biReadAlarmDefs').onclick = function () { action(async function () {
    alarmDefinitions = null; $('biAlarmDefsPreview').hidden = true; permissions();
    var r = await api('alarm-definitions', 'POST', { deviceIds: selectedDeviceIds() });
    alarmDefinitions = r.definitions; alarmPreviewPage = 0; renderAlarmDefinitions(); notice('告警定义已读取，请核对预览后点击「导入已识别告警」。');
  }); };
  $('biImportAlarmDefs').onclick = function () { action(async function () {
    if (!alarmDefinitions) return;
    if (JSON.stringify(selectedDeviceIds()) !== JSON.stringify(alarmDefinitions.deviceIds.slice().sort())) throw new Error('已选设备发生变化，请重新读取告警定义');
    var binding = await api('alarm-definitions-source');
    if (binding.sourceId !== alarmDefinitions.sourceId) throw new Error('DCIM 数据源已变化，请重新读取告警定义');
    var result = window.PcBAlarmImport.merge(devices, alarmDefinitions.candidates);
    devices = result.devices; markMappingDirty(); renderDevices();
    notice('已新增 ' + result.added + ' 个告警映射，保留 ' + result.kept + ' 个已有映射，生成 ' + result.filled + ' 个测试 ID；' + alarmDefinitions.review.length + ' 项待核对未导入。' + (result.missing.length ? '设备 ' + result.missing.join('、') + ' 未填写五位设备编码，请补齐。' : '') + '核对后点击「保存设备和测点」生效。');
  }); };
  $('biAlarmDefsPrev').onclick = function () { alarmPreviewPage--; renderAlarmDefinitions(); };
  $('biAlarmDefsNext').onclick = function () { alarmPreviewPage++; renderAlarmDefinitions(); };
  $('biPrevDevices').onclick = function () { devicePage--; $('biDeviceList').scrollTop = 0; renderDevices(); $('biDevicePage').scrollIntoView({ block: 'nearest' }); };
  $('biNextDevices').onclick = function () { devicePage++; $('biDeviceList').scrollTop = 0; renderDevices(); $('biDevicePage').scrollIntoView({ block: 'nearest' }); };
  $('biEnable').onclick = function () { action(function () { return save(true); }); };
  $('biDisable').onclick = function () { action(async function () { var r = await api('stop', 'POST', {}); load(r.config); status(r.status); notice('已停用，未确认告警仍保留。'); }); };
  $('biPoll').onclick = function () { action(async function () { var r = await api('poll', 'POST', {}); status(r.status); notice(r.status.lastError || '采集与重试完成，请查看运行日志。'); }); };
  $('biLoadDevice').onclick = function () { action(async function () { var r = await api('device', 'POST', { deviceId: $('biDeviceId').value, groupId: $('biGroupId').value, serverCode: $('biServerCode').value }); mergeDevice(r.device, true); activeDeviceId = r.device.deviceId; deviceSearch = ''; $('biDeviceSearch').value = ''; devicePage = Math.floor(devices.findIndex(function (d) { return d.deviceId === activeDeviceId; }) / DEVICE_PAGE_SIZE); markMappingDirty(); renderDevices(); notice('测点已读取，已有设备的分组和 serverCode 已更新；编码、测点勾选及手动类型已保留。模拟量默认 AI，状态量默认 DI。请核对后保存。'); }); };
  $('biImport').onclick = function () { action(async function () { var r = await api('inherited-devices'); r.devices.forEach(mergeDevice); markMappingDirty(); renderDevices(); notice('导入 ' + r.devices.length + ' 个设备，模拟量默认 AI，开关量/状态量默认 DI；已存在的测点保留当前类型，可用「按 Modbus 更新 AI/DI」重新分类。'); }); };
  $('biExportCsv').onclick = function () { action(function () {
    var csv = window.PcBCsv.generate(devices);
    if (!csv.pointCount) { notice('没有可导出的测点，请勾选设备及其测点。'); return; }
    var now = new Date();
    var stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()].map(function (v) { return String(v).padStart(2, '0'); }).join('');
    var url = URL.createObjectURL(new Blob([csv.text], { type: 'text/csv;charset=utf-8' })), link = node('a');
    link.href = url; link.download = 'B接口已选测点-' + stamp + '.csv'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    notice('已导出 ' + csv.deviceCount + ' 个设备 / ' + csv.pointCount + ' 个已选测点（当前草稿，含所有分页）。');
  }); };
  $('biPreview').onclick = function () { action(async function () { var r = await api('preview', 'POST', {}); $('biPreviewText').textContent = '遥测查询响应\n' + r.preview.ai + '\n\n遥信查询响应\n' + r.preview.di + '\n\n读取告警数：' + r.preview.alarms + '\n\n采集提示：\n' + (r.preview.warnings || []).concat(r.preview.errors || []).join('\n'); }); };
  $('biReloadLogs').onclick = function () { action(logs); };
  function currentQuery() { return queryRequests.find(function (q) { return q.type === $('biQueryType').value; }); }
  function clearQueryResponse() { $('biQueryResponse').textContent = '点击本机响应预览查看；外部连接请使用 SoapUI 发送请求验证。'; $('biQueryCache').textContent = ''; }
  function showQuery() {
    var q = currentQuery(); if (!q) return;
    $('biQueryEndpoint').value = q.endpoint; $('biQueryXml').value = q.xml;
    $('biQuerySummary').textContent = q.name + ' · Code ' + q.code + ' · ' + q.deviceCount + ' 个设备 / ' + q.pointCount + ' 个已映射测点' + (q.pointCount ? '' : ' · 当前未配置此类型测点');
    $('biQueryHeaders').textContent = 'HTTP 方法：' + q.method + ' · Content-Type：' + q.contentType + (q.soapAction == null ? '' : ' · SOAPAction：' + q.soapAction);
    clearQueryResponse(); permissions();
  }
  async function generateRequests() {
    queryRequests = []; permissions(); clearQueryResponse(); $('biQueryXml').value = ''; $('biQueryEndpoint').value = ''; $('biQueryHeaders').textContent = ''; $('biQuerySummary').textContent = '正在生成已保存配置的查询请求…';
    try { var r = await api('query-requests'); queryRequests = r.requests; showQuery(); }
    catch (e) { $('biQuerySummary').textContent = '生成失败，请检查并保存 SU 配置后重试。'; throw e; }
  }
  $('biGenerateRequests').onclick = function () { action(generateRequests); };
  $('biQueryType').onchange = showQuery;
  $('biCopyRequest').onclick = function () { action(async function () {
    var q = currentQuery(); if (!q) return; var copied = false;
    try { if (navigator.clipboard) { await navigator.clipboard.writeText(q.xml); copied = true; } } catch (_e) {}
    if (!copied) { $('biQueryXml').focus(); $('biQueryXml').select(); try { copied = document.execCommand('copy'); } catch (_e) {} }
    notice(copied ? '已复制完整 SOAP 请求。粘贴到 SoapUI 的 Request 1 左侧，并使用上方 SU 请求地址发送。' : '已选中完整请求，请按 Ctrl+C 复制，再粘贴到 SoapUI 的 Request 1 左侧。');
  }); };
  $('biDownloadRequest').onclick = function () { action(function () {
    var q = currentQuery(); if (!q) return;
    var url = URL.createObjectURL(new Blob([q.xml], { type: 'text/xml; charset=utf-8' })), link = node('a');
    link.href = url; link.download = q.name + '-request.xml'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    notice('已下载 ' + link.download + '。复制文件全文到 SoapUI 的 Request 1 左侧。');
  }); };
  $('biQueryPreview').onclick = function () { action(async function () {
    var q = currentQuery(); if (!q) return;
    var r = await api('query-preview/' + q.type, 'POST', {});
    queryRequests = queryRequests.map(function (old) { return old.type === q.type ? r.request : old; }); showQuery(); $('biQueryResponse').textContent = r.response;
    $('biQueryCache').textContent = r.cachedAt ? '最近采集：' + new Date(r.cachedAt).toLocaleString() + '。此处为本机响应预览，外部连通性请用 SoapUI 验证。' : '尚无采集缓存；请先启用采集。告警 Result=0 或 AI 空值 / DI FF 表示数据不可用。';
    $('biQueryResponse').closest('details').open = true;
  }); };
  permissions(); api('status').then(function (r) { status(r.status); }).catch(function () {});
})();
