// 接口按钮渲染 + 参数弹窗 + 调用代理。所有 fetch 都走 /api/proto-conv/invoke。
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Mon = window.PcMonitor || { append: function () {} };
  var EP = window.PcEndpoints;
  if (!EP) {
    Mon.error('pc-endpoints.js 未加载');
    return;
  }

  var el = {
    container: $('groupContainer'),
    countHint: $('endpointCountHint'),
    btnExpandAll: $('btnExpandAll'),
    btnCollapseAll: $('btnCollapseAll'),
    paramModal: $('paramModal'),
    paramTitle: $('paramModalTitle'),
    paramFields: $('paramFields'),
    paramDesc: $('paramDesc'),
    paramDanger: $('paramDangerBanner'),
    paramHint: $('paramHint'),
    btnInvoke: $('btnInvoke'),
    btnFillSample: $('btnFillSample'),
    btnCancelParam: $('btnCancelParam'),
    btnCloseParam: $('btnCloseParam'),
  };

  var current = { ep: null }; // 当前打开的接口

  // 字段中文含义映射表：字段名 → 中文含义
  // 优先用 ep.params[].label（每条接口可单独覆盖），fallback 到这张表，再 fallback 到字段名本身
  // 命名说明：
  // - 大部分含义来自 dcim 数据库 information_schema.COLUMNS 的 COLUMN_COMMENT（已用 192.168.0.50:3333 dcim 库校验）
  // - 数据库无 COMMENT 的字段（UserLsh / Zonesubno / RoomId 等）按 8082 接口文档术语标注
  // - 数据库 COMMENT 与接口语境不一致的（如 CommandKey 在 dcim 里是"指令类型"、接口里是控制项 Key），以接口语义为准
  var FIELD_LABEL_MAP = {
    // 通用 / 分页 / 时间
    UserLsh: '用户流水号',           // 接口文档术语，登录后由后端写入
    serverCode: '服务器编码',         // 来自 dcim-area.ServerCode COMMENT
    Date: '日期 YYYY-MM-DD',
    StartDate: '起始时间',
    EndDate: '结束时间',
    pageIndex: '页码',
    pageSize: '每页条数',
    PageIndex: '页码',                // dcim COMMENT 写"页面排序"，按接口语义统一
    PageSize: '每页条数',
    // 登录 / 改密
    userName: '登录账号',
    passWord: '登录密码',
    OldPwd: '原密码',
    NewPwd: '新密码',
    // 区域 / 设备 / 控制
    Zonesubno: '区域子号',           // 8082 接口术语
    zonesubno: '区域子号',
    GroupId: '设备分组 ID',          // dcim 库里 GroupId 是门禁/用户组，但接口语境是设备分组
    DeviceId: '设备 ID',             // dcim-device.id（COMMENT：维护设备 / 巡检点）
    CommandKey: '控制项 Key',        // dcim 库里叫 CommandType（指令类型），接口里语义略不同
    CommandVal: '控制值',
    // 告警
    alarmLevelName: '告警级别',      // 来自 dcim-alarmnotifymode.AlarmLevel COMMENT
    deviceName: '设备名称',          // 来自 dcim DeviceName COMMENT
    key: '关键字',
    AlarmId: '告警 ID',              // 来自 dcim-devicesnmpalarm.AlarmID COMMENT
    CheckMsg: '确认意见',
    // 资产 / 盘点
    PlanId: '盘点任务 ID',           // 来自 dcim PlanId COMMENT
    AssetId: '资产 ID',              // 来自 dcim-assetcheckresult.AssetsId COMMENT
    DeptId: '部门 ID',               // 来自 dcim DeptId COMMENT
    // 巡检 / 维护
    TaskId: '任务 ID',               // 来自 dcim TaskId COMMENT
    FaultTypeLsh: '故障类型流水号',   // dcim 里有 FaultSubTypeLsh（故障子类型）, 此处对应主类型
    // 知识库 / 图片
    ID: '记录 ID',
    ParaId: '参数 ID',               // dcim 里 ParamId COMMENT 多义：自定义参数 id / 设备参数 id
    type: '类型',                    // dcim COMMENT：记录类型 / 计算类型(1历史 2实时)
    // IT / 机房 / 容量 / 能效
    CenterId: '数据中心 ID',
    RoomId: '机房 ID',
    RoomIds: '机房 ID 列表（逗号分隔）',
    CabinetId: '机柜 ID',            // 来自 dcim CabinetId COMMENT
    StationLsh: '站点流水号',
    Year: '年份',
    flag: '标记位',                  // dcim 里 Flag 是知识库分类，接口里多义，保留通用
    // 自定义参数
    ParamName: '参数名称',           // 来自 dcim ParamName COMMENT
    startDateTime: '起始时间',
    endDateTime: '结束时间',
    // 资管 GET
    cabinetId: '机柜 ID',
    assetId: '资产 ID',
    // 兜底
    __raw__: '原始 JSON 兜底',
  };

  function fieldCnLabel(p) {
    if (p.label) return p.label;
    return FIELD_LABEL_MAP[p.name] || '';
  }


  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setHint(text, cls) {
    el.paramHint.textContent = text || '';
    el.paramHint.className = 'hint' + (cls ? ' ' + cls : '');
  }

  function renderGroups() {
    if (el.countHint) {
      el.countHint.textContent = '共 ' + EP.totalCount + ' 接口（含 ' + EP.dangerCount + ' 写入/控制类）';
    }
    var html = '';
    EP.groups.forEach(function (g) {
      html += '<div class="card" data-group="' + escHtml(g.id) + '">';
      html += '<h3 class="card-title group-toggle" data-toggle="' + escHtml(g.id) + '">';
      html += '<span>' + escHtml(g.label) + '</span>';
      html += '<span class="count">（' + g.items.length + '）</span>';
      html += '</h3>';
      html += '<div class="endpoint-grid">';
      g.items.forEach(function (it) {
        var cls = 'btn' + (it.danger ? ' danger' : '');
        var mtag = '<span class="method-tag ' + (it.method === 'GET' ? 'get' : '') + '">' + it.method + '</span>';
        html += '<button class="' + cls + '" type="button" data-key="' + escHtml(it.key) + '" data-group="' + escHtml(g.id) + '" title="' + escHtml(it.desc || it.key) + '">';
        html += mtag + escHtml(it.key);
        html += '</button>';
      });
      html += '</div></div>';
    });
    el.container.innerHTML = html;
    // 绑定折叠
    el.container.querySelectorAll('.group-toggle').forEach(function (n) {
      n.addEventListener('click', function () {
        var card = n.parentElement;
        if (card) card.classList.toggle('collapsed');
      });
    });
    // 绑定接口按钮
    el.container.querySelectorAll('button[data-key]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var ep = findEp(btn.dataset.group, btn.dataset.key);
        if (ep) onClickEndpoint(ep);
      });
    });
  }

  function findEp(groupId, key) {
    var g = EP.groups.find(function (g) { return g.id === groupId; });
    if (!g) return null;
    return g.items.find(function (it) { return it.key === key; });
  }

  function applyGlobals(values) {
    var cfg = (window.PcConfig && window.PcConfig.getCfg && window.PcConfig.getCfg()) || {};
    (current.ep.params || []).forEach(function (p) {
      if (p.useGlobal && (values[p.name] === '' || values[p.name] == null)) {
        var g = cfg[p.useGlobal];
        if (g != null && g !== '') values[p.name] = g;
      }
    });
    return values;
  }

  function buildField(p) {
    var cn = fieldCnLabel(p);
    var nameWithCn = cn ? (p.name + '（' + cn + '）') : p.name;
    var label = '<span>' + escHtml(nameWithCn) +
      (p.required ? '<span class="req">*</span>' : '') +
      (p.note ? '<span class="note">' + escHtml(p.note) + '</span>' : '') +
      '</span>';
    var input;
    var fid = 'pc-fld-' + p.name;
    var defv = p.default == null ? '' : p.default;
    // 如果有 useGlobal，弹窗打开时由 fillGlobals 注入实际值
    if (p.type === 'int') {
      input = '<input id="' + fid + '" type="number" data-pname="' + escHtml(p.name) + '" data-ptype="int" value="' + escHtml(defv) + '" />';
    } else if (p.type === 'password') {
      input = '<input id="' + fid + '" type="password" data-pname="' + escHtml(p.name) + '" data-ptype="password" value="' + escHtml(defv) + '" autocomplete="off" />';
    } else if (p.type === 'textarea' || p.type === 'json') {
      var v = (typeof defv === 'object') ? JSON.stringify(defv, null, 2) : defv;
      input = '<textarea id="' + fid + '" data-pname="' + escHtml(p.name) + '" data-ptype="' + p.type + '" rows="4">' + escHtml(v) + '</textarea>';
    } else {
      input = '<input id="' + fid + '" type="text" data-pname="' + escHtml(p.name) + '" data-ptype="string" value="' + escHtml(defv) + '" />';
    }
    var span2 = (p.type === 'textarea' || p.type === 'json' || p.name === '__raw__') ? ' span-2' : '';
    return '<label class="field' + span2 + '">' + label + input + '</label>';
  }

  function openParamModal(ep) {
    current.ep = ep;
    el.paramTitle.textContent = ep.method + ' ' + ep.key;
    el.paramDesc.textContent = ep.desc || '';
    el.paramDanger.style.display = ep.danger ? 'block' : 'none';
    setHint('', '');

    var params = ep.params || [];
    if (!params.length) {
      el.paramFields.innerHTML = '<div class="hint">该接口无参数，点「调用」直接发起。</div>';
    } else {
      el.paramFields.innerHTML = params.map(buildField).join('');
    }
    // 全局值兜底注入
    var cfg = (window.PcConfig && window.PcConfig.getCfg && window.PcConfig.getCfg()) || {};
    params.forEach(function (p) {
      if (!p.useGlobal) return;
      var node = el.paramFields.querySelector('[data-pname="' + p.name + '"]');
      if (node && (!node.value || node.value === '') && cfg[p.useGlobal]) {
        node.value = cfg[p.useGlobal];
      }
    });

    el.paramModal.classList.add('open');
    el.paramModal.setAttribute('aria-hidden', 'false');
  }

  function closeParamModal() {
    el.paramModal.classList.remove('open');
    el.paramModal.setAttribute('aria-hidden', 'true');
    current.ep = null;
  }

  function collectValues() {
    var ep = current.ep;
    if (!ep) return null;
    var body = {};
    var rawOverride = null;
    var missingRequired = null;
    (ep.params || []).forEach(function (p) {
      var node = el.paramFields.querySelector('[data-pname="' + p.name + '"]');
      if (!node) return;
      var v = node.value;
      if (p.name === '__raw__') {
        if (v && v.trim()) {
          try { rawOverride = JSON.parse(v); }
          catch (e) { missingRequired = '__raw__ JSON 解析失败：' + e.message; }
        }
        return;
      }
      if (p.required && (v == null || v === '')) {
        missingRequired = p.name + ' 必填';
      }
      if (p.type === 'int') {
        body[p.name] = v === '' ? undefined : Number(v);
      } else if (p.type === 'json') {
        if (v && v.trim()) {
          try { body[p.name] = JSON.parse(v); }
          catch (e) { missingRequired = p.name + ' JSON 解析失败：' + e.message; }
        }
      } else {
        if (v !== '') body[p.name] = v;
      }
    });
    if (missingRequired) return { error: missingRequired };
    if (rawOverride && typeof rawOverride === 'object') {
      Object.keys(rawOverride).forEach(function (k) { body[k] = rawOverride[k]; });
    }
    return { body: body };
  }

  async function doInvoke() {
    var ep = current.ep;
    if (!ep) return;
    var c = collectValues();
    if (!c) return;
    if (c.error) { setHint(c.error, 'err'); return; }
    var body = c.body;
    if (ep.danger) {
      var ok = window.confirm('该接口为写入/控制类，确认调用？\n\n' + ep.method + ' ' + ep.key + '\n\n' + JSON.stringify(body, null, 2));
      if (!ok) { setHint('已取消', 'warn'); return; }
    }
    el.btnInvoke.disabled = true;
    setHint('调用中…');
    var t0 = Date.now();
    Mon.append('info', '→ ' + ep.method + ' ' + ep.key + ' ' + JSON.stringify(body));
    try {
      var payload = {
        key: ep.key,
        method: ep.method,
        body: ep.method === 'GET' ? null : body,
        query: ep.method === 'GET' ? body : null,
        pathOverride: ep.pathOverride || null,
      };
      var r = await fetch('/api/proto-conv/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json(); });
      var dt = Date.now() - t0;
      var dataStr = (typeof r.data === 'string') ? r.data : JSON.stringify(r.data);
      if (dataStr && dataStr.length > 800) dataStr = dataStr.slice(0, 800) + '… (truncated)';
      var lvl = r.ok ? 'info' : 'error';
      var line = '← ' + ep.key + ' HTTP ' + (r.status == null ? '?' : r.status) + ' ' + dt + 'ms';
      if (r.message) line += ' [' + r.message + ']';
      line += ' ' + (dataStr || '');
      Mon.append(lvl, line);
      setHint(r.ok ? '已返回（' + dt + 'ms）' : '失败：' + (r.message || 'HTTP ' + r.status), r.ok ? 'ok' : 'err');
      // 登录类自动同步会话
      if (ep.key === 'LoginKey' && r.ok && window.PcConfig && window.PcConfig.reload) {
        window.PcConfig.reload();
      }
    } catch (err) {
      Mon.append('error', '× ' + ep.key + ' ' + err.message);
      setHint('调用异常：' + err.message, 'err');
    } finally {
      el.btnInvoke.disabled = false;
    }
  }

  function fillSample() {
    var ep = current.ep;
    if (!ep || !ep.sample) return;
    Object.keys(ep.sample).forEach(function (k) {
      var node = el.paramFields.querySelector('[data-pname="' + k + '"]');
      if (!node) return;
      var v = ep.sample[k];
      node.value = (typeof v === 'object') ? JSON.stringify(v, null, 2) : v;
    });
    setHint('已填示例', 'ok');
  }

  function onClickEndpoint(ep) {
    if (!ep.params || ep.params.length === 0) {
      // 无参直接弹窗也行，但更顺手是直接调用 + 危险确认
      current.ep = ep;
      if (ep.danger) {
        var ok = window.confirm('该接口为写入/控制类，确认调用？\n\n' + ep.method + ' ' + ep.key);
        if (!ok) { current.ep = null; return; }
      }
      // 无参时打开弹窗也方便看到结果状态
      openParamModal(ep);
      return;
    }
    openParamModal(ep);
  }

  el.btnInvoke && el.btnInvoke.addEventListener('click', doInvoke);
  el.btnFillSample && el.btnFillSample.addEventListener('click', fillSample);
  el.btnCancelParam && el.btnCancelParam.addEventListener('click', closeParamModal);
  el.btnCloseParam && el.btnCloseParam.addEventListener('click', closeParamModal);
  el.paramModal && el.paramModal.addEventListener('click', function (e) {
    if (e.target === el.paramModal) closeParamModal();
  });

  el.btnExpandAll && el.btnExpandAll.addEventListener('click', function () {
    el.container.querySelectorAll('.card').forEach(function (n) { n.classList.remove('collapsed'); });
  });
  el.btnCollapseAll && el.btnCollapseAll.addEventListener('click', function () {
    el.container.querySelectorAll('.card').forEach(function (n) { n.classList.add('collapsed'); });
  });

  renderGroups();
  Mon.append('info', '已加载 ' + EP.totalCount + ' 个接口（' + EP.groups.length + ' 业务分组，含 ' + EP.dangerCount + ' 写入/控制类）');
})();
