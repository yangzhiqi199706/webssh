async (page) => {
  await page.setExtraHTTPHeaders({});
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:3037/proto-conv/index.html');
  await page.evaluate(() => fetch('/fixture/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 500, points: 20 }) }));
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('biSave').disabled, null, { timeout: 60000 });
  await page.locator('#biTabMapping').click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const metrics = await page.evaluate(() => ({ elements: document.querySelector('.bi-dialog').querySelectorAll('*').length, deviceCards: document.querySelectorAll('.bi-device').length, inputControls: document.querySelector('#biDevices').querySelectorAll('input,select').length }));
  metrics.fields = [];
  for (const item of [['联通五位设备编码', '10001', '.bi-form input', 0], ['设备资管编码', 'asset-123456789', '.bi-form input', 1], ['12 位 ID', '100200001000', '.bi-signal input', 0]]) {
    const field = page.locator('#biDevices .bi-device').first().locator(item[2]).nth(item[3]);
    await field.fill('');
    await page.evaluate(() => {
      window.bProfilePaints = []; window.bProfileInput = () => { const t = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.bProfilePaints.push(performance.now() - t))); };
      document.addEventListener('input', window.bProfileInput, true);
    });
    const start = Date.now(); await field.pressSequentially(item[1]); const elapsed = Date.now() - start;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const paints = await page.evaluate(() => { document.removeEventListener('input', window.bProfileInput, true); return window.bProfilePaints; });
    metrics.fields.push({ field: item[0], typingMs: elapsed, maxInputToPaintMs: Math.round(Math.max(0, ...paints)), meanInputToPaintMs: Math.round(paints.reduce((a, b) => a + b, 0) / Math.max(1, paints.length)) });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  return metrics;
}
