// 8082 接口元数据：10 业务分组、91 接口（含 24 危险写入类）。
// 字段：key/method/danger/desc/params[ {name,type,required,default,note,useGlobal} ]/sample
// type: string | int | password | textarea | json
// useGlobal: 弹窗打开时从 PcConfig 全局值兜底（如 UserLsh）
(function () {
  'use strict';

  // 通用参数模板，避免重复
  var P_USER_LSH = { name: 'UserLsh', type: 'string', required: true, default: '', useGlobal: 'userLsh', note: '登录后由后端写入' };
  var P_USER_LSH_OPT = { name: 'UserLsh', type: 'string', required: false, default: '', useGlobal: 'userLsh' };
  var P_RAW_BODY = { name: '__raw__', type: 'json', required: false, default: '{}', note: '其余字段以 JSON 直接覆盖（可选）' };

  // 时间区间通用
  function timeRangeFields() {
    return [
      { name: 'StartDate', type: 'string', required: false, default: '', note: 'YYYY-MM-DD HH:mm:ss' },
      { name: 'EndDate',   type: 'string', required: false, default: '', note: 'YYYY-MM-DD HH:mm:ss' },
      { name: 'pageIndex', type: 'int',    required: false, default: 1 },
      { name: 'pageSize',  type: 'int',    required: false, default: 50 },
    ];
  }

  var groups = [
    /* ---------- 1. 登录与会话 ---------- */
    { id: 'auth', label: '登录与会话', items: [
      { key: 'LoginKey', method: 'POST', danger: false,
        desc: '登录接口（账号/密码后端 Base64）。返回 bool。后端会自动维护 cookie 和 UserLsh。',
        params: [
          { name: 'userName', type: 'string',   required: true, default: 'admin', useGlobal: 'userName', note: '后端转 Base64' },
          { name: 'passWord', type: 'password', required: true, default: '',      note: '留空表示使用配置里保存的密码' },
        ],
        sample: { userName: 'admin', passWord: 'admin' } },
      { key: 'GetAMSServerListKey', method: 'POST', danger: false,
        desc: '获取服务器/服务标识列表。', params: [], sample: {} },
      { key: 'GetMessageCountKey', method: 'POST', danger: false,
        desc: '获取消息中心数量。', params: [P_USER_LSH], sample: { UserLsh: '1' } },
    ]},

    /* ---------- 2. 告警 ---------- */
    { id: 'alarm', label: '告警', items: [
      { key: 'GetRealAlarmsKey', method: 'POST', danger: false,
        desc: '在线告警监视。',
        params: [
          P_USER_LSH,
          { name: 'serverCode',     type: 'string', required: false, default: '' },
          { name: 'alarmLevelName', type: 'string', required: false, default: '' },
          { name: 'deviceName',     type: 'string', required: false, default: '' },
          { name: 'zonesubno',      type: 'string', required: false, default: '' },
          { name: 'key',            type: 'string', required: false, default: '' },
        ],
        sample: { UserLsh: '1', serverCode: '', alarmLevelName: '', deviceName: '', zonesubno: '', key: '' } },
      { key: 'CheckAlarmKey', method: 'POST', danger: true,
        desc: '⚠ 确认告警并触发通知（写入类，会改业务数据）。',
        params: [
          P_USER_LSH,
          { name: 'AlarmId',  type: 'string', required: true,  default: '' },
          { name: 'CheckMsg', type: 'string', required: false, default: '已确认' },
          P_RAW_BODY,
        ],
        sample: { UserLsh: '1', AlarmId: '', CheckMsg: '已确认' } },
      { key: 'GetHistoryAlarmsKey', method: 'POST', danger: false,
        desc: '历史告警记录（带分页 + 时间区间）。',
        params: [P_USER_LSH].concat(timeRangeFields()),
        sample: { UserLsh: '1', StartDate: '', EndDate: '', pageIndex: 1, pageSize: 50 } },
      { key: 'GetAlarmStatisticKey', method: 'POST', danger: false,
        desc: '告警统计。',
        params: [
          { name: 'serverCode', type: 'string', required: false, default: '' },
          { name: 'Date',       type: 'string', required: false, default: '', note: 'YYYY-MM-DD' },
        ],
        sample: { serverCode: '', Date: '' } },
      { key: 'GetAllCategoryAlarmCountKey', method: 'POST', danger: false,
        desc: '分设备分组的报警数量。',
        params: [P_USER_LSH_OPT], sample: { UserLsh: '1' } },
    ]},

    /* ---------- 3. 知识库 / 图片 ---------- */
    { id: 'kb', label: '知识库 / 图片', items: [
      { key: 'GetKnowledgeBaseKey', method: 'POST', danger: false,
        desc: '查询知识库。', params: [P_RAW_BODY], sample: {} },
      { key: 'AddKnowledgeBaseKey', method: 'POST', danger: true,
        desc: '⚠ 新增知识库条目（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'UpdateReadCountKey', method: 'POST', danger: true,
        desc: '⚠ 知识库阅读次数累加（写入类）。',
        params: [{ name: 'ID', type: 'string', required: true, default: '' }], sample: { ID: '' } },
      { key: 'UpLoadPictureKey', method: 'POST', danger: true,
        desc: '⚠ 上传图片（写入类）。', params: [P_RAW_BODY], sample: {} },
      { key: 'GetPictureKey', method: 'POST', danger: false,
        desc: '获取巡检异常图片（文档显示 HTTP 500，需复核）。',
        params: [
          { name: 'ID',     type: 'string', required: true, default: 'XJP528362289192036' },
          { name: 'ParaId', type: 'int',    required: false, default: 1 },
          { name: 'type',   type: 'string', required: false, default: 'xj' },
        ],
        sample: { ID: 'XJP528362289192036', ParaId: 1, type: 'xj' } },
    ]},

    /* ---------- 4. 资产 / 盘点 ---------- */
    { id: 'asset', label: '资产 / 盘点', items: [
      { key: 'GetAssetMsgKey', method: 'POST', danger: false,
        desc: '获取资产消息列表。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'CheckAssetKey', method: 'POST', danger: true,
        desc: '⚠ 资产盘点确认（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetCheckPlanKey', method: 'POST', danger: false,
        desc: '获取盘点计划列表。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetCheckPlanDetailKey', method: 'POST', danger: false,
        desc: '获取盘点计划详情。',
        params: [P_USER_LSH_OPT, { name: 'PlanId', type: 'string', required: true, default: '' }],
        sample: { UserLsh: '1', PlanId: '' } },
      { key: 'SubmitCheckPlanKey', method: 'POST', danger: true,
        desc: '⚠ 提交盘点计划（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'SubmitAutoCheckPlanKey', method: 'POST', danger: true,
        desc: '⚠ 提交自动盘点计划（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetAssetStatusCountKey', method: 'POST', danger: false,
        desc: '资产状态计数。', params: [P_USER_LSH_OPT], sample: { UserLsh: '1' } },
      { key: 'GetAssetInfoKey', method: 'POST', danger: false,
        desc: '资产基础信息。',
        params: [P_USER_LSH_OPT, { name: 'AssetId', type: 'string', required: false, default: '' }, P_RAW_BODY],
        sample: { UserLsh: '1', AssetId: '' } },
      { key: 'GetSparePartsKey', method: 'POST', danger: false,
        desc: '备件清单。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetHKAssetKey', method: 'POST', danger: false,
        desc: '获取耗材资产列表。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetDeptKey', method: 'POST', danger: false,
        desc: '部门列表。', params: [P_RAW_BODY], sample: {} },
      { key: 'GetEmpKey', method: 'POST', danger: false,
        desc: '员工列表。',
        params: [{ name: 'DeptId', type: 'string', required: false, default: '' }],
        sample: { DeptId: '' } },
      { key: 'GetStoreLocationKey', method: 'POST', danger: false,
        desc: '库存位置列表。', params: [P_RAW_BODY], sample: {} },
      { key: 'SubmitReturnAssetKey', method: 'POST', danger: true,
        desc: '⚠ 提交资产归还（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetAssetCheckHisInfoKey', method: 'POST', danger: false,
        desc: '资产盘点历史统计。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
    ]},

    /* ---------- 5. 巡检 / 维护 / 维修 ---------- */
    { id: 'inspect', label: '巡检 / 维护 / 维修', items: [
      { key: 'GetXJTaskKey', method: 'POST', danger: false,
        desc: '巡检任务列表。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'StopXJTaskKey', method: 'POST', danger: true,
        desc: '⚠ 终止巡检任务（写入类）。',
        params: [P_USER_LSH, { name: 'TaskId', type: 'string', required: true, default: '' }],
        sample: { UserLsh: '1', TaskId: '' } },
      { key: 'GetXJTaskDetailKey', method: 'POST', danger: false,
        desc: '巡检任务详情。',
        params: [P_USER_LSH_OPT, { name: 'TaskId', type: 'string', required: true, default: '' }],
        sample: { UserLsh: '1', TaskId: '' } },
      { key: 'RecordXJTaskDetailKey', method: 'POST', danger: true,
        desc: '⚠ 记录巡检任务执行（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetXJQRTaskKey', method: 'POST', danger: false,
        desc: '巡检二维码任务。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetXJTaskDetailParaKey', method: 'POST', danger: false,
        desc: '巡检任务详情参数。',
        params: [P_USER_LSH_OPT, { name: 'TaskId', type: 'string', required: true, default: '' }],
        sample: { UserLsh: '1', TaskId: '' } },
      { key: 'ConfirmXJTaskKey', method: 'POST', danger: true,
        desc: '⚠ 巡检任务确认（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetWHTaskKey', method: 'POST', danger: false,
        desc: '维护任务列表。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'PerformWHTaskKey', method: 'POST', danger: true,
        desc: '⚠ 执行维护任务（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'StopWHTaskKey', method: 'POST', danger: true,
        desc: '⚠ 终止维护任务（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetWHQRTaskKey', method: 'POST', danger: false,
        desc: '维护二维码任务。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'ConfirmWHTaskKey', method: 'POST', danger: true,
        desc: '⚠ 维护任务确认（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetRepairPlanKey', method: 'POST', danger: false,
        desc: '维修计划列表。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'FinishRepairPlanKey', method: 'POST', danger: true,
        desc: '⚠ 完成维修计划（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetHisRepairPlanKey', method: 'POST', danger: false,
        desc: '历史维修计划。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
    ]},

    /* ---------- 6. 区域 / 设备 ---------- */
    { id: 'device', label: '区域 / 设备 / 控制', items: [
      { key: 'GetNewAllAreasKey', method: 'POST', danger: false,
        desc: '实时监视区域列表。', params: [P_USER_LSH], sample: { UserLsh: '1' } },
      { key: 'GetGroupByZonesubnoKey', method: 'POST', danger: false,
        desc: '区域下设备分组列表。',
        params: [
          P_USER_LSH,
          { name: 'serverCode', type: 'string', required: false, default: '' },
          { name: 'Zonesubno',  type: 'string', required: true,  default: '' },
        ],
        sample: { UserLsh: '1', serverCode: '', Zonesubno: '' } },
      { key: 'GetDeviceByGroupKey', method: 'POST', danger: false,
        desc: '分组下面的设备。',
        params: [P_USER_LSH_OPT, { name: 'GroupId', type: 'string', required: true, default: '' }],
        sample: { UserLsh: '1', GroupId: '' } },
      { key: 'GetDeviceParasKey', method: 'POST', danger: false,
        desc: '设备参数列表。',
        params: [
          P_USER_LSH_OPT,
          { name: 'DeviceId',   type: 'string', required: true,  default: '' },
          { name: 'serverCode', type: 'string', required: false, default: '' },
        ],
        sample: { UserLsh: '1', DeviceId: '', serverCode: '' } },
      { key: 'GetDeviceControlKey', method: 'POST', danger: false,
        desc: '实时控制操作列表（只读）。',
        params: [P_USER_LSH_OPT, { name: 'DeviceId', type: 'string', required: true, default: '' }],
        sample: { UserLsh: '1', DeviceId: '' } },
      { key: 'SendControlCommandKey', method: 'POST', danger: true,
        desc: '⚠ 下发设备控制命令（高危：会真实控制设备）。先调 GetDeviceControlKey 拿 controlId。',
        params: [
          P_USER_LSH,
          { name: 'DeviceId',  type: 'string', required: true, default: '', note: '设备 ID（如 1）' },
          { name: 'controlId', type: 'string', required: true, default: '', note: '⚠ 必须小写 c。GetDeviceControlKey 返回的 ControlId 值（如 2182）。后端按此查 dcim-devicecommand.id 取 Command 帧下发' },
          P_RAW_BODY,
        ],
        sample: { UserLsh: '1', DeviceId: '1', controlId: '2182' } },
      { key: 'GetHistoricalControlALLKey', method: 'POST', danger: false,
        desc: '控制操作历史记录（带分页+时间区间）。',
        params: [P_USER_LSH_OPT].concat(timeRangeFields()),
        sample: { UserLsh: '1', StartDate: '', EndDate: '', pageIndex: 1, pageSize: 50 } },
      { key: 'GetHistoryDoorKey', method: 'POST', danger: false,
        desc: '门禁记录。',
        params: [P_USER_LSH_OPT].concat(timeRangeFields()),
        sample: { UserLsh: '1', StartDate: '', EndDate: '', pageIndex: 1, pageSize: 50 } },
    ]},

    /* ---------- 7. IT / 机房 / 容量 / 能效 ---------- */
    { id: 'it', label: 'IT / 机房 / 容量 / 能效', items: [
      { key: 'GetITDeviceCountKey', method: 'POST', danger: false,
        desc: 'IT 设备数量。', params: [P_USER_LSH_OPT], sample: { UserLsh: '1' } },
      { key: 'GetJCDeviceCountKey', method: 'POST', danger: false,
        desc: '基础设备数量。', params: [P_USER_LSH_OPT], sample: { UserLsh: '1' } },
      { key: 'GetDBCenterKey', method: 'POST', danger: false,
        desc: '数据中心列表。', params: [P_USER_LSH_OPT], sample: { UserLsh: '1' } },
      { key: 'GetMotorRoomKey', method: 'POST', danger: false,
        desc: '机房列表。',
        params: [P_USER_LSH_OPT, { name: 'CenterId', type: 'string', required: false, default: '' }],
        sample: { UserLsh: '1', CenterId: '' } },
      { key: 'GetArrangeKey', method: 'POST', danger: false,
        desc: '机房排布。',
        params: [P_USER_LSH_OPT, { name: 'RoomId', type: 'string', required: true, default: '' }],
        sample: { UserLsh: '1', RoomId: '' } },
      { key: 'GetAssetVisualizationKey', method: 'POST', danger: false,
        desc: '资产可视化（机柜/机房）。',
        params: [
          P_USER_LSH_OPT,
          { name: 'CabinetId', type: 'string', required: false, default: '' },
          { name: 'RoomId',    type: 'string', required: false, default: '' },
        ],
        sample: { UserLsh: '1', CabinetId: '', RoomId: '' } },
      { key: 'GetCapacityInfoKey', method: 'POST', danger: false,
        desc: '容量基础信息。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetCapacityReportKey', method: 'POST', danger: false,
        desc: '容量报告。',
        params: [
          P_USER_LSH_OPT,
          { name: 'flag',    type: 'string', required: false, default: '' },
          { name: 'RoomIds', type: 'string', required: false, default: '', note: '多个用逗号分隔' },
        ],
        sample: { UserLsh: '1', flag: '', RoomIds: '' } },
      { key: 'GetNXInfoKey', method: 'POST', danger: false,
        desc: '能效基础信息。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetNXFXInfoKey', method: 'POST', danger: false,
        desc: '能效分析信息。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetDNInfoKey', method: 'POST', danger: false,
        desc: '动能/电能信息。',
        params: [
          P_USER_LSH_OPT,
          { name: 'StationLsh', type: 'string', required: false, default: '' },
          { name: 'Date',       type: 'string', required: false, default: '', note: 'YYYY-MM-DD' },
        ],
        sample: { UserLsh: '1', StationLsh: '', Date: '' } },
      { key: 'GetPayInfoKey', method: 'POST', danger: false,
        desc: '缴费信息。',
        params: [
          P_USER_LSH_OPT,
          { name: 'CenterId', type: 'string', required: false, default: '' },
          { name: 'Year',     type: 'string', required: false, default: '' },
          { name: 'flag',     type: 'string', required: false, default: '' },
        ],
        sample: { UserLsh: '1', CenterId: '', Year: '', flag: '' } },
    ]},

    /* ---------- 8. 工单 / 值班 ---------- */
    { id: 'order', label: '工单 / 值班', items: [
      { key: 'GetFaultTypeKey', method: 'POST', danger: false,
        desc: '故障类型列表（POST/GET 均支持，这里走 POST）。',
        params: [P_USER_LSH_OPT], sample: { UserLsh: '1' } },
      { key: 'GetFaultTypeKey_GET', method: 'GET', danger: false,
        desc: '故障类型列表（GET 模式，文档列表里同时存在）。实际调用时路径仍是 /GetFaultTypeKey。',
        params: [P_USER_LSH_OPT], sample: { UserLsh: '1' },
        pathOverride: '/GetFaultTypeKey' },
      { key: 'GetFaultSubTypeKey', method: 'POST', danger: false,
        desc: '故障子类型。',
        params: [P_USER_LSH_OPT, { name: 'FaultTypeLsh', type: 'string', required: true, default: '' }],
        sample: { UserLsh: '1', FaultTypeLsh: '' } },
      { key: 'CreateWorkOrderKey', method: 'POST', danger: true,
        desc: '⚠ 创建运维工单（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetYWWorkOrderKey', method: 'POST', danger: false,
        desc: '运维工单列表。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetTransferEmpKey', method: 'POST', danger: true,
        desc: '⚠ 工单转派员工（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'ReceiveYWWorkOrderKey', method: 'POST', danger: true,
        desc: '⚠ 接收工单（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'CheckYWWorkOrderKey', method: 'POST', danger: true,
        desc: '⚠ 工单检查/验收（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'SubmitYWWorkOrderKey', method: 'POST', danger: true,
        desc: '⚠ 提交工单（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'SaveLogKey', method: 'POST', danger: true,
        desc: '⚠ 保存值班日志（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'GetOndutyLogKey', method: 'POST', danger: false,
        desc: '值班日志列表。', params: [P_USER_LSH_OPT].concat(timeRangeFields()),
        sample: { UserLsh: '1', StartDate: '', EndDate: '', pageIndex: 1, pageSize: 50 } },
      { key: 'JiaoJieBanKey', method: 'POST', danger: true,
        desc: '⚠ 交接班（写入类）。', params: [P_USER_LSH, P_RAW_BODY], sample: { UserLsh: '1' } },
      { key: 'ChangePwdKey', method: 'POST', danger: true,
        desc: '⚠ 修改密码（写入类，谨慎）。',
        params: [
          P_USER_LSH,
          { name: 'OldPwd', type: 'password', required: true, default: '' },
          { name: 'NewPwd', type: 'password', required: true, default: '' },
        ],
        sample: { UserLsh: '1', OldPwd: '', NewPwd: '' } },
      { key: 'GetYWStatisticKey', method: 'POST', danger: false,
        desc: '运维统计。', params: [P_USER_LSH_OPT, P_RAW_BODY], sample: { UserLsh: '1' } },
    ]},

    /* ---------- 9. 自定义参数 ---------- */
    { id: 'custom', label: '自定义参数', items: [
      { key: 'GetCusParamListKey', method: 'POST', danger: false,
        desc: '自定义参数列表（实时）。',
        params: [{ name: 'ParamName', type: 'string', required: false, default: '' }],
        sample: { ParamName: '' } },
      { key: 'GetCusParamListKey_history', method: 'POST', danger: false,
        desc: '自定义参数列表（历史，type=history）。',
        params: [
          { name: 'type',          type: 'string', required: true,  default: 'history' },
          { name: 'ParamName',     type: 'string', required: false, default: '' },
          { name: 'startDateTime', type: 'string', required: false, default: '' },
          { name: 'endDateTime',   type: 'string', required: false, default: '' },
        ],
        sample: { type: 'history', ParamName: '', startDateTime: '', endDateTime: '' },
        pathOverride: '/GetCusParamListKey' },
    ]},

    /* ---------- 10. 资管 GET（R80–R91） ---------- */
    { id: 'asset-get', label: '资管接口（GET R80–R91）', items: [
      { key: 'GetCabinetList',          method: 'GET', danger: false, desc: '获取机柜列表。', params: [], sample: {} },
      { key: 'GetAssetsList',           method: 'GET', danger: false, desc: '获取机柜上设备。',
        params: [{ name: 'cabinetId', type: 'string', required: true, default: '' }], sample: { cabinetId: '' } },
      { key: 'GetAssetsDetail',         method: 'GET', danger: false, desc: '获取设备详情。',
        params: [{ name: 'assetId', type: 'string', required: true, default: '' }], sample: { assetId: '' } },
      { key: 'GetAssetNOList',          method: 'GET', danger: false, desc: '获取资产型号列表。', params: [], sample: {} },
      { key: 'GetTotalCapacity',        method: 'GET', danger: false, desc: '容量总统计。', params: [], sample: {} },
      { key: 'GetCapacityFromCabinets', method: 'GET', danger: false, desc: '按机柜取容量。',
        params: [{ name: 'cabinetId', type: 'string', required: true, default: '' }], sample: { cabinetId: '' } },
      { key: 'GetSpaceSearch',          method: 'GET', danger: false, desc: '空间查询。', params: [], sample: {} },
      { key: 'GetAssetsSearchParms',    method: 'GET', danger: false, desc: '资产查询参数。', params: [], sample: {} },
      { key: 'GetAssetsSearch',         method: 'POST', danger: false, desc: '资产查询（资管中唯一一个 POST）。',
        params: [P_RAW_BODY], sample: {} },
      { key: 'AssetStatisticsByStatus', method: 'GET', danger: false, desc: '按状态统计资产。', params: [], sample: {} },
      { key: 'AssetStatisticsByTypes',  method: 'GET', danger: false, desc: '按类型统计资产。', params: [], sample: {} },
      { key: 'GetCabinetStatistics',    method: 'GET', danger: false, desc: '机柜统计。', params: [], sample: {} },
    ]},
  ];

  // 统计
  var totalCount = 0, dangerCount = 0;
  groups.forEach(function (g) {
    g.items.forEach(function (it) {
      totalCount += 1;
      if (it.danger) dangerCount += 1;
    });
  });

  window.PcEndpoints = {
    groups: groups,
    totalCount: totalCount,
    dangerCount: dangerCount,
  };
})();
