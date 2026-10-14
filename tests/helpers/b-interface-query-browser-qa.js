async (page) => {
  await page.setExtraHTTPHeaders({});
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('http://127.0.0.1:3037/proto-conv/index.html');
  await page.evaluate(async () => { await fetch('/fixture/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 21, points: 2 }) }); await fetch('/fixture/add-alarm', { method: 'POST' }); });
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click();
  await page.getByRole('tab', { name: '设备和测点', exact: true }).click();
  // An unsaved draft must never enter a generated request.
  await page.getByRole('textbox', { name: '联通五位设备编码', exact: true }).first().fill('99999');
  await page.getByRole('tab', { name: '设备和测点', exact: true }).press('ArrowRight');
  await page.locator('#biQuerySummary').filter({ hasText: 'GET_AIDATA' }).waitFor();
  if (!await page.getByRole('tab', { name: '查询请求', exact: true }).getAttribute('aria-selected')) throw new Error('Query keyboard tab failed');
  const initialXml = await page.locator('#biQueryXml').inputValue();
  if ((initialXml.match(/<Device /g) || []).length !== 21 || initialXml.includes('99999')) throw new Error('All-device saved mapping query failed');
  if (await page.locator('#biQueryEndpoint').inputValue() !== 'http://127.0.0.1:8080/services/SUService') throw new Error('Incorrect SU endpoint');
  await page.locator('#biCopyRequest').click();
  await page.getByRole('alert').filter({ hasText: '已复制完整 SOAP 请求' }).waitFor();
  if ((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n') !== initialXml) throw new Error('Clipboard omitted SOAP envelope');
  const results = [];
  for (const [type, name] of [['AI', 'GET_AIDATA'], ['DI', 'GET_DIDATA'], ['ALARM', 'GET_ALARM']]) {
    await page.locator('#biQueryType').selectOption(type);
    if (!(await page.locator('#biQueryXml').inputValue()).includes('<Name>' + name + '</Name>')) throw new Error('Wrong business type');
    const pending = page.waitForEvent('download'); await page.locator('#biDownloadRequest').click(); const download = await pending;
    if (download.suggestedFilename() !== name + '-request.xml') throw new Error('Incorrect request filename');
    await download.saveAs('output/playwright/' + name + '-request.xml');
    await page.locator('#biQueryPreview').click();
    await page.locator('#biQueryResponse').filter({ hasText: name + '_ACK' }).waitFor();
    results.push({ type, summary: await page.locator('#biQuerySummary').textContent() });
  }
  await page.locator('#biQueryType').selectOption('AI');
  await page.screenshot({ path: 'output/playwright/b-interface-query-desktop.png' });
  await page.setExtraHTTPHeaders({ 'X-Fixture-Role': 'viewer' }); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '只读' }).waitFor();
  await page.getByRole('tab', { name: '查询请求', exact: true }).click(); await page.locator('#biQuerySummary').filter({ hasText: 'GET_AIDATA' }).waitFor();
  if (!await page.locator('#biDownloadRequest').isEnabled() || await page.locator('#biSave').isEnabled()) throw new Error('Viewer request permissions failed');
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await page.locator('#biQueryXml').boundingBox();
  if (!box || box.x < 0 || box.x + box.width > 390) throw new Error('Mobile request UI overflow');
  await page.screenshot({ path: 'output/playwright/b-interface-query-mobile.png' });
  return { result: 'PASS all saved devices, unsaved draft isolation, clipboard, three downloads, preview, keyboard tabs and viewer/mobile UI', requests: results };
}
