async (page) => {
  await page.setExtraHTTPHeaders({}); await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('http://127.0.0.1:3037/proto-conv/index.html');
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('biCopyLoginAck').disabled);
  await page.getByText('LOGIN_ACK 响应模板（模拟 SC 同意注册）', { exact: true }).click();
  await page.waitForFunction(() => document.getElementById('biLoginAckXml').value.includes('<Name>LOGIN_ACK</Name>'), null, { timeout: 2000 });
  const xml = await page.locator('#biLoginAckXml').inputValue();
  if (!xml.includes('<SUId>001122AABBCC</SUId>') || !xml.includes('<RightLevel>1</RightLevel>')) throw new Error('Expand generated wrong response');
  await page.getByText('LOGIN_ACK 响应模板（模拟 SC 同意注册）', { exact: true }).click();
  await page.getByText('LOGIN_ACK 响应模板（模拟 SC 同意注册）', { exact: true }).click();
  if (await page.locator('#biLoginAckXml').inputValue() !== xml) throw new Error('Reopen lost template');
  await page.locator('#biCopyLoginAckInline').click(); await page.getByRole('alert').filter({ hasText: '已复制完整 LOGIN_ACK' }).waitFor();
  if ((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n') !== xml) throw new Error('Inline button did not copy complete response');
  const button = await page.locator('#biCopyLoginAckInline').boundingBox(), area = await page.locator('#biLoginAckXml').boundingBox();
  if (!button || !area || area.y - (button.y + button.height) > 30) throw new Error('Inline button is far from response');
  await page.screenshot({ path: 'output/playwright/b-interface-login-ack-expanded.png' });
  await page.setExtraHTTPHeaders({ 'X-Fixture-Role': 'viewer' }); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '只读' }).waitFor();
  await page.getByText('LOGIN_ACK 响应模板（模拟 SC 同意注册）', { exact: true }).click();
  await page.waitForFunction(() => document.getElementById('biLoginAckXml').value.includes('<Name>LOGIN_ACK</Name>'), null, { timeout: 2000 });
  if (!await page.locator('#biCopyLoginAckInline').isEnabled()) throw new Error('Viewer inline copy disabled');
  return 'PASS expanding LOGIN_ACK generates saved template without copying; reopen and viewer also work';
}
