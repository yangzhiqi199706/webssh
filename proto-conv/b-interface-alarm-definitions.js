'use strict';
function text(value) { return value == null ? '' : String(value).trim(); }
function validName(value) { return value && value.length <= 255 && !/[,，\r\n]/.test(value); }
function branches(rule, base) {
  if (String(rule.type) === '5') return [{ type: '5', name: base }];
  if (!['0','1'].includes(String(rule.type))) throw new Error('无法确定该类型的事件名称规则');
  const output = [];
  ['upper','lower'].forEach((field,index) => {
    const value = text(rule[field]);
    // DCIM to_float_like extracts the first signed decimal number.
    if (value) {
      if (!/[-+]?\d+(?:\.\d+)?/.test(value)) throw new Error('上下限格式无法确定，请核对');
      output.push({ type: String(index + 1), name: base });
    }
  });
  const feature = text(rule.alarmValue);
  if (feature) {
    if (feature[0] !== '*') output.push({ type: '3', name: base });
    else {
      const seen = new Set();
      feature.slice(1).split('/').forEach(part => {
        const separator = part.indexOf('='), value = text(separator < 0 ? part : part.slice(0,separator));
        const name = separator < 0 ? value : text(part.slice(separator + 1));
        const key = value && Number.isFinite(Number(value)) ? 'n:' + Number(value) : 's:' + value;
        if (!value || !validName(name) || seen.has(key)) throw new Error('多状态告警特征值或描述不明确，请核对');
        seen.add(key); output.push({ type: '3', name });
      });
    }
  }
  if (!output.length) throw new Error('未配置上下限或告警特征值，无法确定事件名称');
  return output;
}
function build(data) {
  const candidates = [], review = [], groups = new Map();
  for (const rule of data.rules) {
    const base = String(rule.baseName || '').trim();
    const item = { deviceId: String(rule.deviceId), ruleId: String(rule.ruleId), baseName: base };
    if (Object.prototype.hasOwnProperty.call(rule, 'deviceStatus') && Number(rule.deviceStatus) !== 1) {
      review.push(Object.assign({}, item, { reason: '设备已在 DCIM 标记为删除或不可用，未自动导入' })); continue;
    }
    let events;
    try { events = branches(rule,base); }
    catch (e) { review.push(Object.assign({},item,{ reason: e.message })); continue; }
    if (!validName(base) || events.some(event => !data.types[event.type])) {
      review.push(Object.assign({}, item, { reason: '名称、类型或事件名称规则无法确定' })); continue;
    }
    events.forEach(event => {
      const type = event.type, alarmName = event.name + data.types[type];
      if (alarmName.length > 300) { review.push(Object.assign({}, item, { reason: '生成的告警名称过长' })); return; }
      const candidate = Object.assign({}, item, { alarmName, eventType: type });
      const key = item.deviceId + ':' + alarmName;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(candidate);
    });
  }
  groups.forEach(items => {
    if (items.length === 1) candidates.push(items[0]);
    else items.forEach(item => review.push(Object.assign({}, item, { reason: '同设备存在重复事件名称，请核对规则' })));
  });
  return { source: data.source, deviceIds: data.deviceIds, ruleCount: data.rules.length, candidates, review };
}
module.exports = { build };
