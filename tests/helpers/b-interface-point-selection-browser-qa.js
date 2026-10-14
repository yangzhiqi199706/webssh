async (page) => {
  await page.setExtraHTTPHeaders({});
  await page.goto('http://127.0.0.1:3037/proto-conv/index.html');
  await page.evaluate(() => fetch('/fixture/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 2, points: 83 }) }));
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click();
  await page.getByRole('tab', { name: '设备和测点', exact: true }).click();
  const card = page.locator('.bi-device');
  await page.locator('[data-bi-open-device="4"]').click();
  await card.getByRole('checkbox', { name: '转发 参数1', exact: true }).uncheck();
  await page.locator('[data-bi-open-device="3"]').click();
  const code = card.getByRole('textbox', { name: '联通五位设备编码', exact: true });
  await code.evaluate(el => { window.originalPointSelectionCode = el; });
  await card.getByRole('combobox', { name: '测点类型', exact: true }).nth(2).selectOption('ALARM');
  await card.getByRole('textbox', { name: '精确告警名称', exact: true }).fill('测试告警');
  await card.getByRole('button', { name: '取消全选测点', exact: true }).click();
  if (await card.locator('[data-bi-point]:checked').count() !== 0) throw new Error('Visible points not cleared');
  if (!await card.getByRole('checkbox', { name: /^转发设备 / }).isChecked()) throw new Error('Point clear changed device selection');
  await card.getByRole('button', { name: '下一页测点', exact: true }).click();
  if (await card.locator('[data-bi-point]:checked').count() !== 0) throw new Error('Hidden points not cleared');
  await card.getByRole('button', { name: '全选测点', exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await card.getByRole('button', { name: '下一页测点', exact: true }).click();
    if (await card.locator('[data-bi-point]:checked').count() !== await card.locator('[data-bi-point]').count()) throw new Error('Hidden points not selected');
  }
  await card.locator('[data-bi-point]').last().uncheck();
  if (!(await card.textContent()).includes('已选 82 / 共 83')) throw new Error('Individual selection count stale');
  await card.getByRole('button', { name: '全选测点', exact: true }).click();
  if (!await code.evaluate(el => el === window.originalPointSelectionCode)) throw new Error('Batch selection rebuilt device fields');
  await page.getByRole('button', { name: '保存设备和测点', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '配置已保存' }).waitFor();
  let saved = await page.evaluate(() => fetch('/fixture/saved').then(r => r.json()));
  const full = saved[saved.length - 1];
  if (full.devices[0].params.length !== 83 || full.devices[1].params.length !== 82 || full.devices[0].params[2].type !== 'ALARM' || full.devices[0].params[2].alarmName !== '测试告警') throw new Error('Save lost page/type/device selections');
  if (full.devices[0].params[0].signalId !== '100200001000') throw new Error('Selection modified point IDs');
  await page.screenshot({ path: 'output/playwright/b-interface-point-selection.png' });
  await card.getByRole('button', { name: '取消全选测点', exact: true }).click();
  await page.getByRole('button', { name: '保存设备和测点', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '配置已保存' }).waitFor();
  saved = await page.evaluate(() => fetch('/fixture/saved').then(r => r.json()));
  if (saved[saved.length - 1].devices[0].params.length !== 0 || saved[saved.length - 1].devices[1].params.length !== 82) throw new Error('Clear-all save did not cover all pages');
  await page.setExtraHTTPHeaders({ 'X-Fixture-Role': 'viewer' }); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '只读' }).waitFor();
  await page.getByRole('tab', { name: '设备和测点', exact: true }).click();
  if (await card.getByRole('button', { name: '全选测点', exact: true }).isEnabled() || await card.getByRole('button', { name: '取消全选测点', exact: true }).isEnabled()) throw new Error('Viewer can batch edit');
  return 'PASS 83 points across 4 pages: select/clear, individual count, all types, device independence, IDs, stable inputs, saved payload and viewer permissions';
}
