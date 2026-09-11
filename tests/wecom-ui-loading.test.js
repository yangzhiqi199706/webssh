'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require.resolve('../proto-conv/assets/js/pc-wecom.js'), 'utf8');
const start = source.indexOf("  $('btnOpenWecom').onclick =");
const end = source.indexOf("  $('wcForm').onsubmit", start);
(async () => {
  const button = {};
  let busy = false;
  const context = { $: () => button, dialog: { open: false, showModal() {} },
    loaded: false, canManage: false, fill() {}, status() {}, notice() {}, setInterval() {},
    api: async () => ({ canManage: true, config: {}, status: {} }),
    loadOptions: () => new Promise(() => {}),
    action: async fn => { busy = true; try { await fn(); } finally { busy = false; } } };
  vm.runInNewContext(source.slice(start, end), context);
  button.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(context.loaded, true);
  assert.strictEqual(busy, false, 'pending device options must not lock Webhook configuration');
  console.log('PASS pending options do not block Webhook configuration');
})().catch(e => { console.error(e); process.exitCode = 1; });
