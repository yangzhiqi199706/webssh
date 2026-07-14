# ARM64 WebSSH Main Shell Design

## Goal

Deliver a reproducible offline package for the fresh ARM64 server at
`192.168.50.13`. It runs the WebSSH main shell on port `3010`, without the
protocol assistant or video-monitoring subsystem.

## Target Facts

- OS: Kylin Linux Advanced Server V10, kernel `4.19.90`, glibc `2.28`.
- CPU: HiSilicon Kunpeng 920, `aarch64` / ARM64, 64-bit.
- The current `/opt/webssh` installation does not exist.
- Node.js is not installed. The server can reach the official Node.js download
  endpoint and has `tar`, `xz`, `systemctl`, `curl`, and an active firewalld.
- The existing `linux-x64` release embeds x86_64 Node.js and x86_64
  `MediaServer`; neither can run on this server.

## Scope

The ARM64 package includes the current main application and these views:

- SSH terminal and SFTP file management.
- Browser WebSerial page.
- SMS modem management.
- High-availability management.
- Protocol-conversion UI and its Node proxy APIs.
- Database-management UI and its Node proxy APIs.

The package does not include the Flask protocol assistant, its Python runtime,
or video monitoring. The deployment profile hides the `protocol` and `video`
menu entries so users are not sent to unavailable services. External targets
such as SMS gateways, HA peers, 8082 services, database hosts, and serial
devices remain runtime configuration and are not bundled.

## Architecture

The release is named
`webssh-main-offline-linux-arm64-v<version>-<timestamp>.tar.gz` and has this
layout:

```
app/                         main Node application and node_modules
app/runtime-features.js      browser feature profile (protocol/video disabled on ARM)
runtime/node/                Node.js 12.22.12 linux-arm64 runtime
systemd/webssh.service.template
scripts/install-main-arm64.sh
scripts/uninstall-main.sh
install-main-arm64.sh
INSTALL-ARM64.md
```

`app` remains the existing Node application. `app/runtime-features.js` is
loaded by `index.html`; its tracked default enables all existing views, while
the ARM64 installer writes it with `protocol` and `video` disabled. This keeps
the current x86 full-stack package behavior unchanged and makes the menu
selection explicit instead of leaving broken entries.

The installer deploys only the `webssh` systemd service. It neither creates nor
starts `webssh-protocol` or `webssh-mediaserver`, and it does not install
`protocol/` or `mediaserver/` directories. `server.js` retains its existing
routes so the included main-shell APIs keep their current contracts; the
disabled browser menus are the scope boundary for unavailable subsystems.

## Build and Installation

`scripts/build-main-arm64.js` stages the current application, verifies that no
native Node add-ons (`*.node`) are included, downloads or reuses the official
`node-v12.22.12-linux-arm64.tar.xz`, and verifies its SHA-256 against Node's
published checksum file before packaging. It does not include Python wheels,
Python standalone runtimes, or MediaServer. `scripts/deploy-main-arm64.js`
uploads the generated archive, verifies its remote SHA-256, runs the installer,
and performs the remote health checks against the configured host.

The installer fails before changing the machine unless all of the following are
true:

- It is run as root and `systemctl` is available.
- `uname -m` is `aarch64` or `arm64`.
- `runtime/node/bin/node` is executable and reports `process.arch === 'arm64'`.
- `app/server.js`, `app/index.html`, `app/node_modules`, and the main systemd
  template are present.

Once validated, it stops only an existing `webssh` service, backs up existing
`app` and `runtime/node` directories with a timestamp, preserves an existing
`config/.env` or creates an empty one for a first install, installs the
application at `/opt/webssh`, writes the ARM64 feature profile, renders
`webssh.service`, enables and starts it, and opens `3010/tcp` only when
firewalld is active. A failed service or health check leaves the installation
error visible and does not claim success.

## Error Handling

- Architecture and Node-runtime mismatches fail closed before any deployment
  copy or service restart.
- The deployment script checks the archive checksum before extraction and the
  remote package structure before running the installer.
- Existing application and Node runtime directories are timestamp-backed up;
  an explicit rollback command restores both and restarts only `webssh`.
- The installer does not touch unrelated `webssh-protocol`,
  `webssh-mediaserver`, or configuration directories if they happen to exist.

## Verification

Package verification asserts the expected archive contents, the absence of
protocol, Python, and MediaServer payloads, and ARM64 Node runtime identity.
Remote installation verification checks:

1. `systemctl is-active webssh` returns `active`.
2. `GET http://127.0.0.1:3010/health` returns HTTP 200 with `ok: true`.
3. The feature profile disables `protocol` and `video` and enables all six
   included menu entries.
4. The server can load `express`, `ws`, `ssh2`, `http-proxy`, `net-snmp`,
   `mysql2`, `pg`, and `dmdb` under ARM64 Node.
5. The public port `3010/tcp` is present in firewalld when firewalld is active.

SSH/SFTP can be exercised against the ARM server itself after the UI is up.
Serial hardware, SMS delivery, HA replication, protocol calls, and database
operations require their respective target systems and credentials; their
menus and local APIs are included, but they cannot be proven end-to-end without
those external dependencies.

## Out of Scope

- Flask protocol-assistant functionality and any Python ARM64 runtime.
- GB/T 28181 video monitoring, ZLMediaKit/MediaServer, SIP, and RTP ports.
- Docker/container deployment and changes to external SMS, HA, protocol, or
  database servers.
