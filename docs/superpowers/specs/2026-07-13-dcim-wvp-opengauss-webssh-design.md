# DCIM WVP openGauss WebSSH Design

## Goal

Make WebSSH the safe operation and verification surface for the already-migrated DCIM-container WVP service. Operators must be able to prove that WVP uses openGauss, configure the WVP API login without exposing a secret, start real-time preview, and start and control historical playback.

## Scope

- Manage only the DCIM WVP stack: SIP 5060 and WVP HTTPS API 18080.
- Read and restart the existing `wvp-opengauss.service` through the database-manager SSH connection.
- Keep the existing WVP JAR, mapper changes, YAML, environment file, and migration data untouched.
- Keep the existing webssh WVP stack on 5070 unchanged.

## Architecture

`setupDbManager()` owns remote WVP runtime diagnosis because it already has the SSH connection to the DCIM container. It will expose status and restart routes beneath `/api/db-manager/opengauss/wvp/`.

`setupDcimVideo()` owns WVP API authentication and the media API proxy. It will expose a masked configuration endpoint that accepts a one-time plaintext WVP password, converts it to the WVP login MD5 on the server, and stores only the hash in the existing mode-0600 video configuration file.

The active `video/index.html` remains the playback client. It will use the existing source-aware `/api/dcim-video/playback/*` proxy routes, while retaining live preview and the webssh 5070 source selector.

## Database-Manager Runtime Status

`GET /api/db-manager/opengauss/wvp/runtime-status` returns only operational facts:

- `wvp-opengauss.service` active and enabled state;
- legacy `wvp-pro.service` active/enabled state;
- one Java WVP process, TCP 18080, and SIP 5060 listeners;
- external WVP YAML uses `org.postgresql.Driver`, a PostgreSQL JDBC URL for `dcim`, and PostgreSQL PageHelper dialect;
- no MySQL JDBC URL in the active WVP YAML;
- openGauss has a `wvp_app` connection and the expected WVP tables are populated;
- recent service log error count for database-connection related failures.

The endpoint never returns environment-file values, JDBC passwords, Redis passwords, keystore passwords, SIP passwords, or media secrets. Missing files and failed shell commands become structured checks rather than HTTP 500 responses.

`POST /api/db-manager/opengauss/wvp/restart` executes only `systemctl restart wvp-opengauss.service`, waits for 5060 and 18080, then returns the same masked diagnosis. It refuses to restart if the old `wvp-pro.service` is active, so operators must resolve duplicate service ownership first.

## WVP API Login

`GET /api/dcim-video/config` returns `apiBase`, `username`, `timeoutMs`, and `hasPasswordHash`. It never returns the stored hash.

`PUT /api/dcim-video/config` accepts `apiBase`, `username`, `password`, and `timeoutMs`. A non-empty plaintext password is MD5-hashed on the server; only the hash is persisted. Empty or masked password input preserves the previous hash. Validation limits `apiBase` to HTTPS and limits timeout to a practical range. Saving clears the cached WVP token.

`POST /api/dcim-video/test-login` performs the WVP `/api/user/login` request with the configured hash and returns only reachability, HTTP status, and a generic diagnostic. It never forwards an access token to the browser.

## Playback UX

The video page adds a compact DCIM WVP connection action and a playback mode.

- Operators select the DCIM source, then select a device and channel from the existing list.
- Playback mode has start and end `datetime-local` values, defaults to the previous ten minutes, requires end after start, and caps a request to 24 hours.
- Starting playback calls `/api/<source>-video/playback/start/:device/:channel`; the tile is marked as playback and creates FLV with `isLive: false`.
- The active playback tile provides pause, resume, 0.5x, 1x, 2x, 4x, and stop. Commands call `/api/<source>-video/playback/control/:stream/:cmd` and stop calls `/api/<source>-video/playback/stop/:stream`.
- A live tile continues to call the existing live stop endpoint. Switching layouts, source, or page unload stops each tile using its own mode-specific route.
- Upstream failures, missing recordings, invalid time ranges, and unsupported browser playback are shown in the existing status hint.

## Error Handling And Rollback

- WVP runtime status failures are isolated per check so one inaccessible file does not conceal the service or port state.
- Restart does not alter WVP configuration, user roles, database objects, or source code. A failed restart reports the final service and listener checks; recovery remains `systemctl restart wvp-opengauss.service` after resolving the reported cause.
- Login configuration persists only the hash with file mode 0600 and never writes secrets to WebSSH logs.
- Playback validates client inputs before calling WVP and always uses the playback or live upstream stop route that matches the tile mode.

## Tests And Verification

Add Node 12-compatible tests using `assert` and a direct `node` command:

- runtime status parser recognizes PostgreSQL WVP and detects legacy service conflicts without including secrets;
- video configuration hashes a submitted password and masks it when returned;
- playback validation rejects bad or overlong time ranges;
- tile stop route selection distinguishes live and playback streams.

Run the new test command plus `node --check server.js`. On the target system, run runtime status, WVP login test, device/channel loading, real-time playback, and a known recorded interval through the browser. A replay test is successful only when WVP returns a stream and the FLV player renders it; a successful database query alone is insufficient.

## Non-Goals

- Rebuilding, redeploying, or reverting the WVP JAR and mapper changes.
- Modifying the WVP environment file or exposing its credentials.
- Starting the record-assist service; historical playback is tested through the GB28181 WVP playback API, while record download remains separate.
- Changing the webssh 5070 WVP stack.
