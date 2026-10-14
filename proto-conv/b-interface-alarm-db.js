'use strict';
const cp = require('child_process'), os = require('os'), mysql = require('mysql2');
// Keep the deployed x86 path first; ARM installations may only have collection/web configs.
const configPaths = ['/www/dbconfig.json', '/www/python/src/collection/dbconfig.json',
  '/www/wwwroot/localhost_8086/wwwroot/dbconfig.json'];
function localHost(host) {
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return true;
  const interfaces = os.networkInterfaces();
  return Object.keys(interfaces).some(k => interfaces[k].some(address => address.address === host));
}
function validateIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !/^[1-9][0-9]{0,9}$/.test(id))) throw new Error('请选择有效的 DCIM 设备（最多 500 个，设备 ID 必须为正整数）');
  return Array.from(new Set(ids));
}
function commandError(args, err, stderr) {
  // Never return raw stderr: it can contain credentials or SQL/data values.
  const text = String(stderr || ''), readingConfig = args[2] === 'cat';
  const file = readingConfig ? args[args.length - 1] : '';
  let message, code;
  if (err.code === 'ENOENT') message = '无法执行 Docker 命令，请检查安装和服务运行环境';
  else if (err.killed) message = 'DCIM 容器数据库读取超时（20 秒），请检查容器和查询耗时';
  else if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') message = 'DCIM 数据库读取结果超过缓冲区限制，请减少设备范围';
  else if (/No such container/i.test(text)) message = 'dcim 容器不存在，请检查容器名称';
  else if (/is not running/i.test(text)) message = 'dcim 容器未运行，请检查容器状态';
  else if (readingConfig && text.includes(file) && /No such file or directory/i.test(text)) {
    message = 'DCIM 数据库配置不存在：' + file; code = 'DCIM_CONFIG_NOT_FOUND';
  } else if (/permission denied/i.test(text)) message = 'DCIM 容器或数据库配置读取权限不足，请检查服务权限';
  else if (readingConfig) message = 'DCIM 数据库配置读取失败：' + file;
  else {
    const match = text.match(/ERROR\s+(\d+)\b/);
    const reasons = {
      '1045': '账号或密码认证失败，请核对容器数据库配置',
      '1049': '数据库不存在，请核对容器数据库配置中的库名',
      '1054': '查询字段不存在，请核对 DCIM 表结构',
      '1142': '数据库账号缺少查询权限',
      '1146': '查询表不存在，请核对 DCIM 数据库',
      '1193': '数据库不支持查询使用的系统变量，请核对数据库版本',
      '1305': '数据库不支持查询使用的函数，请核对数据库版本',
      '2002': '容器内 MySQL 本地连接失败，请检查服务和 socket 配置',
      '2003': '容器内 MySQL 连接失败，请检查服务和端口',
      '3024': '数据库查询超过执行时间限制，请减少设备范围',
    };
    message = match && reasons[match[1]] ? 'DCIM MySQL 错误 ' + match[1] + '：' + reasons[match[1]] :
      'DCIM 容器 MySQL 查询失败，请检查容器、MySQL 和数据库配置';
  }
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}
function execute(args, input, maxBuffer) {
  return new Promise((resolve, reject) => {
    const child = cp.execFile('docker', args, { timeout: 20000, maxBuffer: maxBuffer || 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(commandError(args, err, stderr));
      resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
async function readProfile(run) {
  for (const file of configPaths) {
    let raw;
    try { raw = await run(['exec', 'dcim', 'cat', file], '', 65536); }
    catch (err) {
      if (err.code === 'DCIM_CONFIG_NOT_FOUND') continue;
      throw err;
    }
    let profile;
    try { profile = JSON.parse(String(raw).replace(/^\uFEFF/, '').trim()); }
    catch (_e) { throw new Error('DCIM 数据库配置格式错误：' + file); }
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('DCIM 数据库配置格式错误：' + file);
    return profile;
  }
  throw new Error('未找到 DCIM 数据库配置，已检查：' + configPaths.join('、'));
}
async function read(config, ids, options) {
  options = options || {};
  ids = validateIds(ids);
  const address = new URL(config.baseUrl), host = address.hostname;
  if (!['http:', 'https:'].includes(address.protocol)) throw new Error('DCIM 数据源地址必须为 HTTP 或 HTTPS');
  if (!(options.localHost || localHost)(host)) throw new Error('数据库批量读取目前要求 DCIM 与本软件部署在同一台主机');
  const run = options.execute || execute;
  const profile = await readProfile(run);
  if (String(profile.type).toLowerCase() !== 'mysql') throw new Error('告警定义批量读取目前支持 DCIM MySQL 数据库');
  const database = String(profile.name || profile.database || '');
  const user = String(profile.user || profile.username || '');
  const password = String(profile.password || '');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database) || !/^[A-Za-z0-9_.-]{1,80}$/.test(user) || /[\r\n\0]/.test(password) ||
      !['localhost', '127.0.0.1', '::1', ''].includes(String(profile.host || ''))) throw new Error('DCIM 本机数据库配置不符合只读查询要求');
  const query = "SELECT JSON_OBJECT('kind','rule','ruleId',CAST(m.id AS CHAR),'deviceId',CAST(m.DevId AS CHAR),'baseName',m.AlarmName,'alarmKey',m.AlarmKey,'type',m.AlarmType,'deviceStatus',d.status,'upper',m.AlarmUpLimit,'lower',m.AlarmDownLimit,'alarmValue',m.AlarmValue) FROM `dcim-alarmnotifymode` m LEFT JOIN `dcim-device` d ON d.id=m.DevId WHERE m.status=1 AND FIND_IN_SET(CAST(m.DevId AS CHAR),?) ORDER BY m.DevId,m.id LIMIT 10001";
  const sql = 'SET SESSION MAX_EXECUTION_TIME=10000;\n' +
    "SELECT JSON_OBJECT('kind','type','id',CAST(id AS CHAR),'name',TypeName) FROM `dcim-alarmtype` WHERE status=1;\n" +
    'SET @b_device_ids=' + mysql.escape(ids.join(',')) + ';\nPREPARE b_alarm_defs FROM ' + mysql.escape(query) +
    ';\nEXECUTE b_alarm_defs USING @b_device_ids;\nDEALLOCATE PREPARE b_alarm_defs;\n';
  // The password travels over stdin, not command arguments, and is never returned.
  const output = await run(['exec', '-i', 'dcim', 'sh', '-c',
    'IFS= read -r MYSQL_PWD; export MYSQL_PWD; exec mysql --default-character-set=utf8mb4 --batch --skip-column-names --raw --connect-timeout=5 -u "$1" "$2"',
    'b-alarm-definitions', user, database], password + '\n' + sql);
  let rows;
  try { rows = output.trim() ? output.trim().split(/\r?\n/).map(line => JSON.parse(line)) : []; }
  catch (_e) { throw new Error('告警定义查询结果格式错误，未导入任何数据'); }
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('告警定义查询结果格式错误，未导入任何数据');
  const rules = rows.filter(row => row.kind === 'rule'), types = Object.create(null);
  if (rules.length > 10000) throw new Error('已选设备的告警定义超过 10000 条，请减少设备范围');
  rows.filter(row => row.kind === 'type').forEach(row => { types[String(row.id)] = String(row.name || '').trim(); });
  if (rules.some(row => !ids.includes(String(row.deviceId)))) throw new Error('数据库返回了所选范围以外的设备，已拒绝导入');
  return { rules, types, source: 'dcim-alarmnotifymode', deviceIds: ids };
}
module.exports = { read, validateIds, localHost };
