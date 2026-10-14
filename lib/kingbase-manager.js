'use strict';

// 使用现有 pg 纯 JS 驱动；原生备份工具始终在目标容器内执行，兼容 x86/ARM。
const defaults = {
  enabled: true, host: '', port: 54321, username: 'dcim', password: '',
  database: 'dcim', schema: 'public', systemdUnit: 'kingbase.service',
  binDir: '/opt/Kingbase/ES/V8/KESRealPro/V008R006C008B0020/Server/bin',
  containerPort: 54321, container: '',
  ssh: { host: '', port: 22, username: 'root', password: '' },
};
function quoteIdentifier(value) {
  if (typeof value !== 'string' || !value || value.indexOf('\0') !== -1) throw new Error('名称非法');
  return '"' + value.replace(/"/g, '""') + '"';
}
function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
function validateDatabaseName(name) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name)) throw new Error('数据库名仅支持字母、数字、下划线和短横线');
}
function nativeCommand(db, action, database, file) {
  validateDatabaseName(database);
  if (!['backup', 'restore'].includes(action)) throw new Error('非法操作');
  const bin = String(db.binDir || defaults.binDir).replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9_./-]+$/.test(bin) || bin.split('/').includes('..')) throw new Error('工具目录必须是绝对路径');
  const port = Number(db.containerPort || 54321);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('容器端口非法');
  const connection = ' -w -h 127.0.0.1 -p ' + port + ' -U ' + shellQuote(db.username) + ' -d ' + shellQuote(database);
  return 'umask 077; KINGBASE_PASSWORD=' + shellQuote(db.password || '') + ' ' +
    shellQuote(bin + (action === 'backup' ? '/sys_dump' : '/sys_restore')) + connection +
    (action === 'backup' ? ' -F c -f ' + shellQuote(file) :
      ' --exit-on-error --single-transaction --no-owner --no-privileges ' + shellQuote(file));
}
function redact(db) {
  return Object.assign({}, db, {
    password: '***', hasPassword: !!db.password,
    ssh: Object.assign({}, db.ssh, { password: '***', hasPassword: !!(db.ssh && db.ssh.password) }),
  });
}
function createManager(pg, getConfig) {
  async function query(sql, limit, database, values, override) {
    const db = override || getConfig();
    if (!db.host) throw new Error('请配置人大金仓数据库连接地址');
    if (!pg) throw new Error('pg 未安装');
    const started = Date.now();
    const client = new pg.Client({ host: db.host, port: Number(db.port) || 54321,
      user: db.username, password: db.password || '', database: database || db.database || 'dcim',
      connectionTimeoutMillis: 5000, query_timeout: 30000, statement_timeout: 30000,
      application_name: 'webssh-db-manager' });
    // pg 的空闲连接错误也必须有处理器，不能成为未捕获 error 终止主进程。
    if (client.on) client.on('error', () => {});
    try {
      await client.connect();
      const response = await client.query(sql, values);
      const r = Array.isArray(response) ? response[response.length - 1] : response;
      const rows = r.rows || [];
      const cap = Math.max(1, Math.min(5000, Number(limit) || 500));
      return { columns: (r.fields || []).map(f => f.name), rows: rows.slice(0, cap),
        rowCount: r.rowCount == null ? rows.length : r.rowCount, elapsedMs: Date.now() - started,
        notice: rows.length > cap ? '结果超过 ' + cap + ' 行，已截断' :
          (Array.isArray(response) ? '已执行多条语句，显示最后一条结果' : null) };
    } finally { try { await client.end(); } catch (_e) {} }
  }
  async function databases() {
    return (await query('SELECT datname AS name FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname', 500)).rows.map(r => r.name);
  }
  async function tables(database) {
    return (await query("SELECT tablename AS name, schemaname AS schema FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema','sys_catalog','sys','sys_hm','sysmac') ORDER BY schemaname, tablename", 5000, database)).rows;
  }
  async function table(database, name, schema) {
    schema = schema || getConfig().schema || 'public';
    const identifier = quoteIdentifier(schema) + '.' + quoteIdentifier(name);
    const struct = await query('SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS "default" FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position', 500, database, [schema, name]);
    let preview;
    try { preview = await query('SELECT * FROM ' + identifier + ' LIMIT 100', 100, database); }
    catch (e) { preview = { columns: [], rows: [], notice: e.message }; }
    return { columns: struct.rows, preview: preview };
  }
  return { query, databases, tables, table };
}
module.exports = { defaults, quoteIdentifier, validateDatabaseName, nativeCommand, redact, createManager };
