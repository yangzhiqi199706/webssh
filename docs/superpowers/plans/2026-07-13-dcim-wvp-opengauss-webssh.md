# DCIM WVP openGauss WebSSH Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give WebSSH safe operational visibility into the DCIM-container openGauss WVP service, configure WVP API authentication without persisting plaintext, and provide verified live preview and historical playback controls.

**Architecture:** Add small testable utility modules for sensitive configuration, WVP runtime probe parsing, and browser playback validation. Keep SSH-based WVP runtime checks inside `setupDbManager()` and WVP API authentication inside `setupDcimVideo()`; the active video page consumes those routes and retains its current dcim/webssh source selection.

**Tech Stack:** Node.js 12, Express, ssh2, http-proxy, native `assert`, browser-native JavaScript, flv.js, openGauss via container `gsql`.

---

## File Map

- Create: `lib/dcim-wvp.js` - Node 12 utility functions for password hashing, masked configuration, WVP runtime probe parsing, and restart eligibility.
- Create: `video/assets/js/video-runtime.js` - browser/CommonJS utility functions for playback time validation and source-aware stop URL selection.
- Create: `tests/dcim-wvp-opengauss.test.js` - Node 12 `assert` regression tests for both utility modules.
- Modify: `package.json` - add the direct Node test command.
- Modify: `server.js` - add masked DCIM WVP connection configuration routes and openGauss WVP runtime status/restart routes.
- Modify: `db/index.html` - add the WVP openGauss status dialog and restart interaction to the existing openGauss card.
- Modify: `video/index.html` - add DCIM WVP connection dialog and a source-aware historical playback bar.
- Modify: `video/assets/css/style.css` - add compact selected playback and diagnostic states without changing existing layouts.
- Modify: `CLAUDE.md` - document the WebSSH runtime routes, credential storage boundary, and the end-to-end acceptance procedure.

### Task 1: Establish Node 12 Test Harness And Pure Utilities

**Files:**
- Create: `tests/dcim-wvp-opengauss.test.js`
- Create: `lib/dcim-wvp.js`
- Create: `video/assets/js/video-runtime.js`
- Modify: `package.json:6-9`

- [ ] **Step 1: Write the failing utility test**

Create `tests/dcim-wvp-opengauss.test.js` with no production utility files present:

```js
'use strict';

var assert = require('assert');
var wvp = require('../lib/dcim-wvp');
var videoRuntime = require('../video/assets/js/video-runtime');

function test(name, fn) {
  try { fn(); process.stdout.write('ok - ' + name + '\n'); }
  catch (err) { process.stderr.write('not ok - ' + name + '\n' + err.stack + '\n'); process.exitCode = 1; }
}

test('hashes a submitted WVP password without returning plaintext', function () {
  var next = wvp.mergeDcimVideoConfig({ username: 'admin', password: 'test-password', timeoutMs: 7000 }, {});
  assert.strictEqual(next.username, 'admin');
  assert.strictEqual(next.passwordHash, 'dfb450efddbb5387197c84460623675b');
  assert.deepStrictEqual(wvp.publicDcimVideoConfig(next), {
    apiBase: 'https://127.0.0.1:18080', username: 'admin', timeoutMs: 7000, hasPasswordHash: true,
  });
});

test('recognizes a healthy PostgreSQL WVP probe without leaking configuration values', function () {
  var status = wvp.parseWvpRuntimeProbe([
    'service_active=active', 'service_enabled=enabled', 'legacy_active=inactive', 'legacy_enabled=disabled',
    'java_count=1', 'http_18080=1', 'sip_5060=1', 'postgres_driver=1', 'postgres_url=1',
    'postgres_dialect=1', 'mysql_url=0', 'wvp_app_connections=1', 'wvp_device_rows=1',
    'wvp_channel_rows=3', 'wvp_log_rows=74', 'db_error_lines=0',
  ].join('\n'));
  assert.strictEqual(status.ready, true);
  assert.strictEqual(status.restartAllowed, true);
  assert.strictEqual(JSON.stringify(status).indexOf('password'), -1);
});

test('blocks restart when the legacy WVP service is active', function () {
  var status = wvp.parseWvpRuntimeProbe('service_active=active\nlegacy_active=active');
  assert.strictEqual(status.restartAllowed, false);
  assert.strictEqual(status.checks.legacyService.ok, false);
});

test('rejects invalid and overlong playback ranges', function () {
  assert.strictEqual(videoRuntime.validatePlaybackRange('', '').ok, false);
  assert.strictEqual(videoRuntime.validatePlaybackRange('2026-07-13T10:00', '2026-07-13T09:59').ok, false);
  assert.strictEqual(videoRuntime.validatePlaybackRange('2026-07-13T00:00', '2026-07-14T00:01').ok, false);
  assert.strictEqual(videoRuntime.validatePlaybackRange('2026-07-13T10:00', '2026-07-13T10:10').ok, true);
});

test('selects the mode-specific upstream stop route', function () {
  assert.strictEqual(videoRuntime.stopPath('dcim', 'live', 'device-1', 'channel-1', ''), '/api/dcim-video/play/stop/device-1/channel-1');
  assert.strictEqual(videoRuntime.stopPath('dcim', 'playback', '', '', 'rtp/record-1'), '/api/dcim-video/playback/stop/rtp%2Frecord-1');
  assert.strictEqual(videoRuntime.stopPath('webssh', 'playback', '', '', 'rtp/record-2'), '/api/webssh-video/playback/stop/rtp%2Frecord-2');
});

test('preserves an existing WVP hash when the password field is empty', function () {
  var next = wvp.mergeDcimVideoConfig({ username: 'admin', password: '', timeoutMs: 6000 }, { passwordHash: 'abc', apiBase: 'https://127.0.0.1:18080' });
  assert.strictEqual(next.passwordHash, 'abc');
  assert.throws(function () { wvp.mergeDcimVideoConfig({ apiBase: 'http://127.0.0.1:18080' }, {}); }, /HTTPS/);
});
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `node tests/dcim-wvp-opengauss.test.js`

Expected: failure with `Cannot find module '../lib/dcim-wvp'`.

- [ ] **Step 3: Implement the Node utility module**

Create `lib/dcim-wvp.js` with this public API:

```js
'use strict';

var crypto = require('crypto');

function bool(v) { return String(v || '') === '1' || String(v || '') === 'active' || String(v || '') === 'enabled'; }
function number(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function md5(value) { return crypto.createHash('md5').update(String(value), 'utf8').digest('hex'); }

function mergeDcimVideoConfig(input, current) {
  input = input || {}; current = current || {};
  var apiBase = String(input.apiBase || current.apiBase || 'https://127.0.0.1:18080').trim();
  var url = new URL(apiBase);
  if (url.protocol !== 'https:') throw new Error('DCIM WVP API 必须使用 HTTPS');
  var timeoutMs = Number(input.timeoutMs == null ? current.timeoutMs || 6000 : input.timeoutMs);
  if (!isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new Error('timeoutMs 必须在 1000-30000 之间');
  var next = { apiBase: apiBase.replace(/\/$/, ''), username: String(input.username || current.username || 'admin').trim(), timeoutMs: Math.round(timeoutMs), passwordHash: String(current.passwordHash || '') };
  if (!next.username) throw new Error('WVP 用户名不能为空');
  if (input.password && input.password !== '***') next.passwordHash = md5(input.password);
  return next;
}

function publicDcimVideoConfig(cfg) {
  return { apiBase: cfg.apiBase, username: cfg.username, timeoutMs: cfg.timeoutMs, hasPasswordHash: !!cfg.passwordHash };
}

function parseWvpRuntimeProbe(text) {
  var fields = {};
  String(text || '').split(/\r?\n/).forEach(function (line) {
    var at = line.indexOf('='); if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1).trim();
  });
  var checks = {
    service: { ok: fields.service_active === 'active' && fields.service_enabled === 'enabled', active: fields.service_active || 'unknown', enabled: fields.service_enabled || 'unknown' },
    legacyService: { ok: fields.legacy_active !== 'active' && fields.legacy_enabled !== 'enabled', active: fields.legacy_active || 'unknown', enabled: fields.legacy_enabled || 'unknown' },
    listeners: { ok: number(fields.java_count) === 1 && bool(fields.http_18080) && bool(fields.sip_5060), javaCount: number(fields.java_count), http18080: bool(fields.http_18080), sip5060: bool(fields.sip_5060) },
    datasource: { ok: bool(fields.postgres_driver) && bool(fields.postgres_url) && bool(fields.postgres_dialect) && !bool(fields.mysql_url), postgresDriver: bool(fields.postgres_driver), postgresUrl: bool(fields.postgres_url), postgresDialect: bool(fields.postgres_dialect), mysqlUrl: bool(fields.mysql_url) },
    database: { ok: number(fields.wvp_app_connections) > 0, wvpAppConnections: number(fields.wvp_app_connections), deviceRows: number(fields.wvp_device_rows), channelRows: number(fields.wvp_channel_rows), logRows: number(fields.wvp_log_rows) },
    logs: { ok: number(fields.db_error_lines) === 0, databaseErrorLines: number(fields.db_error_lines) },
  };
  var restartAllowed = checks.legacyService.ok;
  return { ready: checks.service.ok && checks.legacyService.ok && checks.listeners.ok && checks.datasource.ok && checks.database.ok && checks.logs.ok, restartAllowed: restartAllowed, checks: checks };
}

module.exports = { mergeDcimVideoConfig: mergeDcimVideoConfig, publicDcimVideoConfig: publicDcimVideoConfig, parseWvpRuntimeProbe: parseWvpRuntimeProbe };
```

- [ ] **Step 4: Implement the browser/CommonJS playback utility**

Create `video/assets/js/video-runtime.js`:

```js
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DcimVideoRuntime = api;
})(this, function () {
  function validatePlaybackRange(startText, endText) {
    var start = new Date(startText); var end = new Date(endText);
    if (!startText || !endText || isNaN(start.getTime()) || isNaN(end.getTime())) return { ok: false, message: '请选择有效的开始和结束时间' };
    if (end.getTime() <= start.getTime()) return { ok: false, message: '结束时间必须晚于开始时间' };
    if (end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) return { ok: false, message: '单次回放最长 24 小时' };
    return { ok: true, startTime: startText, endTime: endText };
  }
  function stopPath(source, mode, deviceId, channelId, streamKey) {
    var base = '/api/' + encodeURIComponent(source) + '-video';
    if (mode === 'playback') return base + '/playback/stop/' + encodeURIComponent(streamKey);
    return base + '/play/stop/' + encodeURIComponent(deviceId) + '/' + encodeURIComponent(channelId);
  }
  return { validatePlaybackRange: validatePlaybackRange, stopPath: stopPath };
});
```

- [ ] **Step 5: Add the test script and verify green**

Change `package.json` scripts to:

```json
"scripts": {
  "start": "node server.js",
  "dev": "node server.js",
  "test": "node tests/dcim-wvp-opengauss.test.js"
}
```

Run: `npm test`

Expected: six `ok -` lines and exit code 0.

- [ ] **Step 6: Commit the tested utility foundation**

```bash
git add package.json lib/dcim-wvp.js video/assets/js/video-runtime.js tests/dcim-wvp-opengauss.test.js
git commit -m "test: add dcim wvp opengauss utilities"
```

### Task 2: Add WVP openGauss Runtime Status And Controlled Restart

**Files:**
- Modify: `server.js:10202-11982`
- Modify: `db/index.html:570-645, 919-936, 991-1166`
- Test: `tests/dcim-wvp-opengauss.test.js`

- [ ] **Step 1: Write a failing runtime-probe command test**

Append this test before changing the runtime probe implementation:

```js
test('builds a WVP runtime probe without referencing a runtime secret', function () {
  var command = wvp.wvpRuntimeProbeCommand();
  assert.ok(command.indexOf('wvp-opengauss.service') !== -1);
  assert.ok(command.indexOf('jdbc:postgresql://127.0.0.1:5432/dcim') !== -1);
  assert.strictEqual(command.indexOf('WVP_DB_PASSWORD'), -1);
});
```

 - [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm test`

Expected: failure with `wvp.wvpRuntimeProbeCommand is not a function`.

- [ ] **Step 3: Implement the testable runtime-probe command builder**

Add this function to `lib/dcim-wvp.js` and export it:

```js
function wvpRuntimeProbeCommand() {
  var config = '/www/media/wvp-GB28181-pro/target/classes/application-dev.yml';
  return [
    'CONFIG=' + config,
    'service_active=$(systemctl is-active wvp-opengauss.service 2>/dev/null || true)',
    'service_enabled=$(systemctl is-enabled wvp-opengauss.service 2>/dev/null || true)',
    'legacy_active=$(systemctl is-active wvp-pro.service 2>/dev/null || true)',
    'legacy_enabled=$(systemctl is-enabled wvp-pro.service 2>/dev/null || true)',
    "java_count=$(ps -ef | grep '[w]vp-pro-2.6.9-06021439.jar' | wc -l | tr -d ' ')",
    "http_18080=$(ss -lnt 2>/dev/null | grep -c ':18080 ' || true)",
    "sip_5060=$(ss -lunt 2>/dev/null | grep -c ':5060 ' || true)",
    "postgres_driver=$(grep -c 'driver-class-name: org.postgresql.Driver' $CONFIG 2>/dev/null || true)",
    "postgres_url=$(grep -c 'jdbc:postgresql://127.0.0.1:5432/dcim' $CONFIG 2>/dev/null || true)",
    "postgres_dialect=$(grep -c 'helper-dialect: postgresql' $CONFIG 2>/dev/null || true)",
    "mysql_url=$(grep -ci 'jdbc:mysql:' $CONFIG 2>/dev/null || true)",
  ].join('\n');
}
```

Run: `npm test`

Expected: all Task 1 tests plus the runtime-probe command test pass.

- [ ] **Step 4: Add the remote probe in `setupDbManager()`**

After the existing WVP sequence routes, import the utility once at IIFE scope and add `collectWvpRuntimeStatus()`. Execute one container command through `sshRun(runInContainerCmd(cfg.container, command))`; emit only these key/value lines:

```sh
service_active=$(systemctl is-active wvp-opengauss.service 2>/dev/null || true)
service_enabled=$(systemctl is-enabled wvp-opengauss.service 2>/dev/null || true)
legacy_active=$(systemctl is-active wvp-pro.service 2>/dev/null || true)
legacy_enabled=$(systemctl is-enabled wvp-pro.service 2>/dev/null || true)
java_count=$(ps -ef | grep '[w]vp-pro-2.6.9-06021439.jar' | wc -l | tr -d ' ')
http_18080=$(ss -lnt 2>/dev/null | grep -c ':18080 ' || true)
sip_5060=$(ss -lunt 2>/dev/null | grep -c ':5060 ' || true)
postgres_driver=$(grep -c 'driver-class-name: org.postgresql.Driver' "$CONFIG" 2>/dev/null || true)
postgres_url=$(grep -c 'jdbc:postgresql://127.0.0.1:5432/dcim' "$CONFIG" 2>/dev/null || true)
postgres_dialect=$(grep -c 'helper-dialect: postgresql' "$CONFIG" 2>/dev/null || true)
mysql_url=$(grep -ci 'jdbc:mysql:' "$CONFIG" 2>/dev/null || true)
```

Run `gsql` as `omm` with the existing openGauss library path and append `wvp_app_connections`, `wvp_device_rows`, `wvp_channel_rows`, and `wvp_log_rows`. Count only `error|exception|mysql.*jdbc` in the last ten minutes of `journalctl -u wvp-opengauss.service`; do not return raw logs.

- [ ] **Step 5: Expose status and restart routes**

Add these routes:

```js
app.get('/api/db-manager/opengauss/wvp/runtime-status', async function (_req, res) {
  var result = await collectWvpRuntimeStatus();
  res.status(result.sshCode === 0 ? 200 : 502).json(result);
});

app.post('/api/db-manager/opengauss/wvp/restart', async function (_req, res) {
  var before = await collectWvpRuntimeStatus();
  if (!before.status.restartAllowed) return res.status(409).json({ ok: false, message: '旧 wvp-pro.service 仍在运行，拒绝重启以避免端口竞争', status: before.status });
  var restarted = await sshRun(runInContainerCmd(cfg.container, 'systemctl restart wvp-opengauss.service 2>&1'));
  var after = await waitForWvpRuntimeStatus(15, 1000);
  res.status(after.status.ready ? 200 : 502).json({ ok: after.status.ready, restartCode: restarted.code, status: after.status });
});
```

`waitForWvpRuntimeStatus` polls `collectWvpRuntimeStatus()` until service, 5060, and 18080 are healthy or fifteen seconds elapse. All responses must contain parsed checks only, never command text or secrets.

- [ ] **Step 6: Add the database-manager dialog**

In `db/index.html`, add `🔎 WVP 高斯状态` next to the existing WVP table and sync buttons. Add a modal with check rows for service, legacy service, listeners, datasource, database, and logs; add a guarded `重启 WVP` command button. Use:

```js
async function loadWvpRuntimeStatus() {
  var r = await jfetch(API + '/opengauss/wvp/runtime-status');
  renderWvpRuntimeChecks((r && r.status && r.status.checks) || {});
}
```

The restart handler must require `confirm('确定重启 dcim 容器内 wvp-opengauss.service？实时预览将短暂中断。')`, disable the button while pending, then refresh the check rows.

- [ ] **Step 7: Verify the server and utility tests**

Run:

```bash
npm test
node --check server.js
```

Expected: all tests pass and `node --check` produces no output.

- [ ] **Step 8: Commit the WVP runtime operation surface**

```bash
git add server.js db/index.html tests/dcim-wvp-opengauss.test.js
git commit -m "feat: manage dcim wvp opengauss runtime"
```

### Task 3: Add Masked DCIM WVP API Login Configuration

**Files:**
- Modify: `server.js:8816-9081`
- Modify: `video/index.html:8-120, 380-450`
- Test: `tests/dcim-wvp-opengauss.test.js`

- [ ] **Step 1: Replace the embedded default hash and add masked configuration routes**

In `setupDcimVideo()`, set `defaults.passwordHash` to an empty string. Require `lib/dcim-wvp.js` and use its `mergeDcimVideoConfig` and `publicDcimVideoConfig` functions. Preserve the existing `/api/dcim-video/config` WVP system-config proxy.

Add the non-conflicting routes:

```js
app.get('/api/dcim-video/connection-config', function (_req, res) {
  res.json({ ok: true, config: wvpUtils.publicDcimVideoConfig(cfg) });
});

app.put('/api/dcim-video/connection-config', function (req, res) {
  try {
    cfg = wvpUtils.mergeDcimVideoConfig(req.body || {}, cfg);
    writeCfg(); cachedToken = ''; lastLoginAt = 0; lastError = '';
    res.json({ ok: true, config: wvpUtils.publicDcimVideoConfig(cfg) });
  } catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

app.post('/api/dcim-video/test-login', async function (_req, res) {
  var ok = await loginDcim();
  res.status(ok ? 200 : 502).json({ ok: ok, status: ok ? 200 : 502, message: ok ? 'WVP 登录成功' : 'WVP 登录失败，请检查账号或密码' });
});
```

Do not log request bodies, hashes, access tokens, or WVP upstream response bodies in these new paths.

- [ ] **Step 2: Add the compact video connection dialog**

Add a `DCIM WVP 连接` button and a modal to `video/index.html` using existing `.modal-mask`, `.modal`, `.form-grid`, and `.hint` CSS. The modal contains API address, username, password, timeout, `测试登录`, and `保存` controls. On load, call `GET /api/dcim-video/connection-config`; leave password empty and set its placeholder from `hasPasswordHash`. On save, submit the plaintext password only when non-empty. The test button calls `POST /api/dcim-video/test-login` and only renders its generic message.

- [ ] **Step 3: Verify configuration safety**

Run:

```bash
npm test
node --check server.js
rg -n "passwordHash" video/index.html db/index.html
```

Expected: tests and syntax check pass; the browser files contain no persisted password/hash values.

- [ ] **Step 4: Commit login configuration support**

```bash
git add server.js video/index.html tests/dcim-wvp-opengauss.test.js
git commit -m "feat: configure dcim wvp api login safely"
```

### Task 4: Implement Source-Aware Historical Playback In The Active Video Page

**Files:**
- Modify: `video/index.html:1-453`
- Modify: `video/assets/css/style.css:219-302`
- Modify: `tests/dcim-wvp-opengauss.test.js`

- [ ] **Step 1: Load the shared browser utility and add playback controls**

Load `./assets/js/video-runtime.js` before the inline script. In the top bar add `历史回放` beside the layout selector. In the grid column add a hidden `.playback-bar` with `pbDevice`, `pbChannel`, `pbStart`, `pbEnd`, `btnPbStart`, `btnPbPause`, `btnPbResume`, `pbSpeed`, `btnPbScale`, and `pbHint`.

When `loadSource(source, btnId)` succeeds, save the device list, populate `pbDevice`, and clear `pbChannel`. On device selection, call `/api/<source>-video/channels` and populate `pbChannel` with online channels first. Default `pbStart` to ten minutes before local time and `pbEnd` to local time.

- [ ] **Step 2: Make each tile mode-aware**

Extend the inline `Tile` state with `mode`. Replace its fixed live `isLive: true` option with:

```js
isLive: params.mode !== 'playback'
```

Set the overlay badge to `回放` for playback and `LIVE` otherwise. Replace the fixed live stop request with:

```js
var path = window.DcimVideoRuntime.stopPath(this.source, this.mode || 'live', dev, ch, streamKey);
fetch(path, { method: 'POST' }).catch(function () {});
```

For playback `Tile.stop()` must call the playback stop route with `streamKey`; live tiles continue to call the device/channel stop route.

- [ ] **Step 3: Implement playback start and controls**

The start handler must call `DcimVideoRuntime.validatePlaybackRange(pbStart.value, pbEnd.value)`, require a selected device and channel, then POST:

```js
fetch('/api/' + currentSource + '-video/playback/start/' + encodeURIComponent(deviceId) + '/' + encodeURIComponent(channelId), {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ startTime: range.startTime, endTime: range.endTime })
})
```

On success call `tiles[activeIdx].play({ flvUrl: data.flvUrl, streamKey: data.streamKey, deviceId: deviceId, channelId: channelId, channelName: selectedChannelName, deviceName: selectedDeviceName, source: currentSource, mode: 'playback' })`.

Pause, resume, and scale must target the active tile only when `tile.mode === 'playback'`, using `POST /api/<source>-video/playback/control/<encoded streamKey>/<pause|play|scale>`; scale sends `{ value: pbSpeed.value }`. Render WVP error messages and no-recording responses in `pbHint`.

- [ ] **Step 4: Add focused CSS and verify browser syntax**

Use the existing playback-bar styles. Add only rules needed to keep the playback fields readable in the compact grid header and make the playback badge amber. Do not change the existing dual-source, device-list, or tile dimensions.

Run:

```bash
npm test
node --check server.js
node -e "require('./video/assets/js/video-runtime')"
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the video playback feature**

```bash
git add video/index.html video/assets/css/style.css video/assets/js/video-runtime.js tests/dcim-wvp-opengauss.test.js
git commit -m "feat: add dcim wvp historical playback"
```

### Task 5: Document And Execute End-To-End Verification

**Files:**
- Modify: `CLAUDE.md:1262-1400, 1492-1513`

- [ ] **Step 1: Document the new operator routes and secret boundary**

Add the following facts to the WVP and database-manager sections:

```markdown
- `GET /api/db-manager/opengauss/wvp/runtime-status` reports WVP high-level service, listener, JDBC, database, and log checks without returning any secret.
- `POST /api/db-manager/opengauss/wvp/restart` restarts only `wvp-opengauss.service` and refuses when legacy `wvp-pro.service` is active.
- `/api/dcim-video/connection-config` stores only the MD5 login hash in `config/dcim-video.json` with mode 0600; the browser never receives the hash or a WVP access token.
- Historical playback uses the WVP GB28181 playback API. Record-assist on 18081 is not required for preview/playback but remains required for record-download functions.
```

- [ ] **Step 2: Run local verification**

Run:

```bash
npm test
node --check server.js
git diff --check
```

Expected: all commands exit 0 and `git diff --check` has no whitespace errors.

- [ ] **Step 3: Perform target-system verification after deployment**

Use the database-manager WVP dialog to confirm all checks are green. Then use the video connection dialog to save the valid WVP login and run the test-login action. In the video page select `dcim (5060)`, verify device and channel load, start one live preview, then run a historical playback request over a known recorded ten-minute interval. Test pause, resume, 2x scale, and stop. Record the returned failure message if the NVR has no recording for the selected window.

- [ ] **Step 4: Commit documentation**

```bash
git add CLAUDE.md
git commit -m "docs: document dcim wvp opengauss operations"
```
