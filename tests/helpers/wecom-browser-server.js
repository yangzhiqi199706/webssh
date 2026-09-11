'use strict';
// Loopback-only UI fixture. No DCIM connection and no outbound WeCom requests.
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Forwarder } = require('../../proto-conv/wecom-forwarder');
const { normalize } = require('../../proto-conv/wecom-alarms');
const { register } = require('../../proto-conv/wecom-routes');
const app = express();
app.use(express.json());
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-ui-'));
const samples = [
  { AlarmID: 'fixture-1', AlarmTime: '2026-09-09 08:00:00', ZoneSubName: '一号机房', DeviceName: 'UPS-01', AlarmLevel: '4', AlarmContent: '市电异常' },
  { AlarmID: 'fixture-2', AlarmTime: '2026-09-09 08:05:00', ZoneSubName: '二号机房', DeviceName: '温湿度-02', AlarmLevel: '2', AlarmContent: '温度超过上限' }
];
const manager = new Forwarder({ file: path.join(directory, 'state.json'), sourceId: () => 'fixture',
  appClient: { credentials: async () => {}, send: async () => {} },
  collect: async () => ({ live: samples.map(row => normalize(row)), history: [] }),
  loadOptions: async () => ({ areas: ['一号机房', '二号机房'], devices: ['UPS-01', '温湿度-02'], levels: ['2', '4'], warnings: [] }),
  send: async url => { if (url.includes('reject')) throw Object.assign(new Error('企业微信发送失败：HTTP 200，错误码 40058'), { retryable: false }); }
});
register(app, manager, () => ({ role: 'admin' }));
app.get('/api/proto-conv/config', (_req, res) => res.json({ ok: true, config: { baseUrl: 'https://127.0.0.1:8086', userName: 'fixture', userLsh: '1', timeoutMs: 8000, pathMap: {} } }));
app.get('/api/proto-conv/:module/status', (_req, res) => res.json({ ok: true, status: { enabled: false, running: false } }));
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use('/proto-conv', express.static(path.resolve(__dirname, '../../proto-conv')));
app.get('/', (_req, res) => res.redirect('/proto-conv/index.html'));
manager.start();
app.listen(Number(process.env.PORT || 3012), '127.0.0.1', () => console.log('WeCom UI fixture ready (outbound sending disabled)'));
