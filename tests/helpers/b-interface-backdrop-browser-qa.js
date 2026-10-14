async (page) => {
  await page.setExtraHTTPHeaders({}); await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('http://127.0.0.1:3037/proto-conv/index.html');
  await page.evaluate(() => fetch('/fixture/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 2, points: 4 }) }));
  await page.route('**/api/proto-conv/b-interface/logs', route => route.fulfill({ json: { ok: true, logs: [] } }));
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click();
  await page.locator('#biField-userName').fill('未保存的账号草稿');
  await page.getByRole('tab', { name: '设备和测点', exact: true }).click();
  await page.locator('.bi-device').getByRole('textbox', { name: '设备资管编码', exact: true }).fill('未保存的设备草稿');
  await page.locator('.bi-device').getByRole('checkbox', { name: '转发 参数1', exact: true }).uncheck();
  for (const name of ['接入配置','设备和测点','查询请求','报文预览','运行日志']) {
    await page.getByRole('tab', { name, exact: true }).click();
    const bounds = await page.locator('.bi-dialog').boundingBox();
    await page.mouse.click(1,1);
    if (!await page.locator('.bi-dialog').evaluate(el => el.open)) throw new Error('Backdrop click closed ' + name);
    await page.mouse.dblclick(1, bounds.y + bounds.height / 2);
    if (!await page.locator('.bi-dialog').evaluate(el => el.open)) throw new Error('Backdrop double-click closed ' + name);
  }
  await page.getByRole('tab', { name: '设备和测点', exact: true }).click();
  if (await page.locator('.bi-device').getByRole('textbox', { name: '设备资管编码', exact: true }).inputValue() !== '未保存的设备草稿' || await page.locator('.bi-device').getByRole('checkbox', { name: '转发 参数1', exact: true }).isChecked()) throw new Error('Outside click lost mapping drafts');
  if (await page.locator('#biField-userName').inputValue() !== '未保存的账号草稿') throw new Error('Outside click lost config draft');
  if ((await page.evaluate(() => fetch('/fixture/saved').then(r => r.json()))).length) throw new Error('Outside click saved config');
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator('.bi-dialog').boundingBox(); await page.mouse.click(1,bounds.y + bounds.height / 2);
  if (!await page.locator('.bi-dialog').evaluate(el => el.open)) throw new Error('Mobile outside click closed dialog');
  await page.locator('#biClose').click(); if (await page.locator('.bi-dialog').evaluate(el => el.open)) throw new Error('Close button stopped working');
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click(); await page.keyboard.press('Escape');
  if (await page.locator('.bi-dialog').evaluate(el => el.open)) throw new Error('Escape stopped working');
  return 'PASS outside click/double-click in five tabs, config/mapping drafts preserved, no save, mobile, explicit Close and Escape';
}
