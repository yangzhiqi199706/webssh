async (page) => {
  await page.goto('http://127.0.0.1:3037/proto-conv/index.html');
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click();
  await page.locator('#biWsdlUrl').waitFor();
  const savedUrl = 'http://127.0.0.1:8080/services/SUService?wsdl';
  if (await page.locator('#biWsdlUrl').inputValue() !== savedUrl) throw new Error('Saved WSDL URL not displayed');
  await page.locator('#biField-port').fill('9999');
  if (await page.locator('#biWsdlUrl').inputValue() !== savedUrl) throw new Error('Unsaved config changed WSDL URL');
  for (const kind of ['Su', 'Sc']) {
    const pending = page.waitForEvent('download');
    await page.locator('#biDownload' + kind + 'Wsdl').click();
    const download = await pending;
    const expected = kind.toUpperCase() + 'Service.wsdl';
    if (download.suggestedFilename() !== expected) throw new Error('Wrong filename: ' + download.suggestedFilename());
    await download.saveAs('output/playwright/' + expected);
    await page.getByRole('alert').filter({ hasText: expected }).waitFor();
  }
  await page.locator('#biField-port').fill('8080');
  await page.locator('.bi-wsdl').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'output/playwright/b-interface-wsdl-desktop.png' });
  await page.setExtraHTTPHeaders({ 'X-Fixture-Role': 'viewer' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '只读' }).waitFor();
  if (await page.locator('#biSave').isEnabled()) throw new Error('Viewer can save');
  if (!await page.locator('#biDownloadSuWsdl').isEnabled()) throw new Error('Viewer cannot download WSDL');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.bi-wsdl').scrollIntoViewIfNeeded();
  const bounds = await page.locator('.bi-wsdl').boundingBox();
  if (!bounds || bounds.x < 0 || bounds.x + bounds.width > 390) throw new Error('Mobile WSDL panel overflows');
  await page.screenshot({ path: 'output/playwright/b-interface-wsdl-mobile.png' });
  return 'PASS browser SU/SC file downloads, saved URL, draft isolation, disabled-mode hints, viewer controls and mobile layout';
}
