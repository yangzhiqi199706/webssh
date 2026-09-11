'use strict';
// Explicit opt-in only. Inserts marked rows on 0.22; finally removes only those rows.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Client } = require('ssh2');
const { collect } = require('../../proto-conv/wecom-alarms');
const { Forwarder } = require('../../proto-conv/wecom-forwarder');
const marker = 'WECOM_SIM_' + Date.now();
const dir = path.resolve('output', marker);
const ids = [];
const results = [];
const sent = [];
let clock = Math.floor(Date.now() / 1000) * 1000;
let failSend = false;
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
const date = () => new Date(clock + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
const c = new Client();
function remote(command) {
  return new Promise((resolve, reject) => c.exec(command, (err, stream) => {
    if (err) return reject(err);
    let out = '', stderr = '';
    stream.on('data', b => { out += b; }); stream.stderr.on('data', b => { stderr += b; });
    stream.on('close', code => code ? reject(new Error(stderr || out)) : resolve(out.trim()));
  }));
}
async function sql(statement) {
  const code = "const fs=require('fs'),cp=require('child_process');" +
    "const mon=JSON.parse(fs.readFileSync('/opt/webssh/app/config/sms-monitor.json'));if(mon.enabled)throw Error('SMS monitoring is enabled');" +
    "const cfg=JSON.parse(fs.readFileSync('/opt/webssh/app/config/sms-db.json'));" +
    "const r=cp.spawnSync('docker',['exec','-e','MYSQL_PWD='+cfg.password,'dcim','mysql','-u'+cfg.user,'--default-character-set=utf8','-N','dcim','-e'," + JSON.stringify(statement) + "],{encoding:'utf8'});process.stdout.write(r.stdout||'');if(r.status){process.stderr.write('Database command failed');process.exit(1)}";
  return remote('/opt/webssh/runtime/node/bin/node -e ' + quote(code));
}
function api({ key, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({ hostname: '192.168.0.22', port: 8082, path: '/' + key, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let text = ''; res.on('data', b => { text += b; }); res.on('end', () => {
        try { resolve({ ok: res.statusCode === 200, data: JSON.parse(text) }); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('API timeout'))); req.on('error', reject); req.end(data);
  });
}
let manager;
const options = { file: path.join(dir, 'state.json'), now: () => clock, sourceId: () => '192.168.0.22:8082',
  collect: (config, since) => collect({ getCfg: () => ({ userLsh: '1' }), callUpstream: api }, config, since, clock),
  send: async (_url, payload) => {
    if (failSend) throw Object.assign(new Error('SIMULATED_OFFLINE_FAILURE'), { retryable: true });
    sent.push(payload);
  } };
function record(name) { results.push({ name, passed: true, sent: sent.length }); console.log('PASS ' + name + ' sent=' + sent.length); }
async function poll() { clock += 2000; await manager.poll(); assert.strictEqual(manager.status().lastError, ''); }
async function drain() {
  for (let i = 0; i < 100 && manager.status().pending; i++) { clock += 61000; await manager.drain(); }
  assert.strictEqual(manager.status().pending, 0);
}
async function insert(label, level) {
  const stamp = date();
  const text = 'SIM,SIM,' + marker + '_' + label + ',SIM,' + stamp.slice(5);
  const id = await sql("INSERT INTO `dcim-alarmlist` (AlarmType,NotifyModeID,NotifyState,NotifyMode,DevId,DevClass,AlarmLevel,AlarmStatus,status,TextMessage,create_time,update_time) VALUES (5,0,0,'',3,1," + (level || 3) + ",1,1,'" + text + "','" + stamp + "','" + stamp + "'); SELECT LAST_INSERT_ID();");
  assert.match(id, /^\d+$/); ids.push(id);
  fs.writeFileSync(path.join(dir, 'ids.json'), JSON.stringify({ marker, ids }, null, 2));
  return id;
}
async function update(selected, changes) {
  assert.ok(selected.length && selected.every(id => ids.includes(id)));
  await sql('UPDATE `dcim-alarmlist` SET ' + changes + ' WHERE id IN (' + selected.join(',') + ") AND TextMessage LIKE 'SIM,SIM," + marker + "_%'");
}
async function recover(selected) {
  clock += 2000;
  await update(selected, "CancelTime='" + date() + "',CancelDesc='" + marker + "',AlarmStatus=3,NotifyState=0");
}
async function main() {
  if (process.env.WECOM_DB_SIMULATE !== 'YES' || !process.env.WECOM_SSH_PASS || !process.env.WECOM_API_PASS) throw Error('Explicit simulation opt-in and credentials required');
  fs.mkdirSync(dir, { recursive: true });
  await new Promise((resolve, reject) => c.on('ready', resolve).on('error', reject).connect({ host: '192.168.0.22', username: 'root', password: process.env.WECOM_SSH_PASS, readyTimeout: 15000 }));
  let failure;
  try {
    const login = await api({ key: 'LoginKey', body: { userName: Buffer.from('admin').toString('base64'), passWord: Buffer.from(process.env.WECOM_API_PASS).toString('base64') } });
    assert.ok(login.ok && login.data.status === 'ok');
    assert.strictEqual(await sql("SELECT COUNT(*) FROM `dcim-device` WHERE id=3 AND DeviceClass=1"), '1');
    const baseline = await insert('BASELINE');
    manager = new Forwarder(options);
    manager.configure({ enabled: true, webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=offline-simulation', filters: { areas: [], devices: [], levels: ['3'], keyword: marker } });
    await poll(); await drain(); assert.strictEqual(sent.length, 0); record('existing baseline does not send');
    const single = await insert('SINGLE'); await poll(); await drain(); assert.strictEqual(sent.length, 1); record('single new alarm');
    await poll(); await drain(); assert.strictEqual(sent.length, 1); record('duplicate polls do not resend');
    await update([single], "AlarmStatus=2,ConfirmTime='" + date() + "'"); await poll(); await drain(); assert.strictEqual(sent.length, 1); record('confirmation is not recovery');
    await update([single], 'status=0'); await poll(); await drain(); assert.strictEqual(sent.length, 1); record('disappearance is not recovery');
    await update([single], 'status=1'); await recover([single]); await poll(); await drain(); assert.strictEqual(sent.length, 2); record('single explicit recovery');
    await recover([baseline]); await poll(); await drain(); assert.strictEqual(sent.length, 2); record('baseline recovery does not send');
    const batch = []; for (let i = 0; i < 10; i++) batch.push(await insert('BATCH_' + i));
    await poll(); assert.strictEqual(manager.status().pending, 10); await drain(); assert.strictEqual(sent.length, 12); record('batch 10 new alarms');
    await recover(batch.slice(0, 4)); await poll(); await drain(); assert.strictEqual(sent.length, 16); record('partial batch 4 recoveries');
    await recover(batch.slice(4)); await poll(); await drain(); assert.strictEqual(sent.length, 22); record('remaining batch 6 recoveries');
    manager = new Forwarder(options); await poll(); await drain(); assert.strictEqual(sent.length, 22); record('restart and recovery dedupe');
    const filtered = await insert('FILTERED', 2); await poll(); await recover([filtered]); await poll(); await drain(); assert.strictEqual(sent.length, 22); record('level filter suppresses new and recovery');
    const retry = await insert('RETRY'); await poll(); failSend = true; clock += 5000; await manager.drain(); assert.strictEqual(manager.status().pending, 1);
    await recover([retry]); await manager.poll(); assert.strictEqual(manager.status().pending, 2);
    failSend = false; manager = new Forwarder(options); await drain(); assert.strictEqual(sent.length, 24); record('failure restart retry sends new before recovery');
    const rapid = await insert('RAPID'); await recover([rapid]); await poll(); await drain(); assert.strictEqual(sent.length, 26); record('new and recovery between polls');
    assert.strictEqual(manager.logs().filter(x => x.result === 'sent' && x.type === 'new').length, 13);
    assert.strictEqual(manager.logs().filter(x => x.result === 'sent' && x.type === 'recovery').length, 13);
  } catch (e) { failure = e; console.error(e.stack); }
  finally {
    try {
      const targets = await sql("SELECT id FROM `dcim-alarmlist` WHERE TextMessage LIKE 'SIM,SIM," + marker + "_%'");
      const exact = targets ? targets.split(/\s+/) : [];
      assert.ok(exact.every(id => /^\d+$/.test(id)));
      if (exact.length) await sql('DELETE FROM `dcim-alarmlist` WHERE id IN (' + exact.join(',') + ") AND TextMessage LIKE 'SIM,SIM," + marker + "_%'");
      assert.strictEqual(await sql("SELECT COUNT(*) FROM `dcim-alarmlist` WHERE TextMessage LIKE 'SIM,SIM," + marker + "_%'"), '0');
      record('database test rows cleaned: ' + exact.length);
    } catch (e) { failure = failure || e; console.error('CLEANUP FAILED: ' + e.message); }
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ marker, ids, results, sent, error: failure ? failure.message : null, realWeComSend: false, simulatedClock: true }, null, 2));
    c.end();
  }
  console.log('REPORT ' + path.join(dir, 'report.json'));
  if (failure) throw failure;
}
main().catch(e => { console.error(e.message); c.end(); process.exitCode = 1; });
