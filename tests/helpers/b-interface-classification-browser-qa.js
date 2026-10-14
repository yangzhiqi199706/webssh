async (page) => {
  await page.setExtraHTTPHeaders({});
  await page.goto('http://127.0.0.1:3037/proto-conv/index.html');
  await page.evaluate(async () => { await fetch('/fixture/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 21, points: 4 }) }); await fetch('/fixture/wrong-types', { method: 'POST' }); });
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click();
  await page.getByRole('tab', { name: '设备和测点', exact: true }).click();
  await page.locator('#biSourceTools > summary').click();
  const card = page.locator('.bi-device').first();
  await card.getByRole('textbox', { name: '联通五位设备编码' }).fill('10077');
  await card.getByRole('textbox', { name: '设备资管编码' }).fill('keep-rid');
  await card.getByRole('textbox', { name: '12 位 ID', exact: true }).nth(1).fill('100299901000');
  await card.getByRole('checkbox', { name: '转发 参数2', exact: true }).uncheck();
  await card.getByRole('combobox', { name: '测点类型', exact: true }).nth(3).selectOption('ALARM');
  await card.getByRole('textbox', { name: '精确告警名称', exact: true }).fill('独立告警');
  await page.getByRole('button', { name: '按 Modbus 更新 AI/DI', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '更新' }).waitFor();
  if (await card.getByRole('combobox', { name: '测点类型', exact: true }).nth(0).inputValue() !== 'AI' || await card.getByRole('combobox', { name: '测点类型', exact: true }).nth(1).inputValue() !== 'DI') throw new Error('Existing AI/DI correction failed');
  if (await card.getByRole('combobox', { name: '测点类型', exact: true }).nth(3).inputValue() !== 'ALARM') throw new Error('ALARM mapping overwritten');
  if (await card.getByRole('textbox', { name: '联通五位设备编码' }).inputValue() !== '10077' || await card.getByRole('textbox', { name: '设备资管编码' }).inputValue() !== 'keep-rid' || await card.getByRole('textbox', { name: '12 位 ID', exact: true }).nth(1).inputValue() !== '100299901000' || await card.getByRole('checkbox', { name: '转发 参数2', exact: true }).isChecked()) throw new Error('Reclassification changed codes/selection');
  await page.getByRole('button', { name: '下一页设备', exact: true }).click();
  if (await page.getByRole('combobox', { name: '测点类型', exact: true }).nth(1).inputValue() !== 'DI') throw new Error('Hidden page not classified');
  // Manual override must survive normal reimport of the same source device.
  await page.getByRole('combobox', { name: '测点类型', exact: true }).nth(1).selectOption('AI');
  await page.getByRole('button', { name: '导入 Modbus 已选设备', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '导入' }).waitFor();
  if (await page.getByRole('combobox', { name: '测点类型', exact: true }).nth(1).inputValue() !== 'AI') throw new Error('Reimport erased manual type');
  await page.getByRole('button', { name: '取消全选设备', exact: true }).click();
  await page.getByRole('button', { name: '保存设备和测点', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '配置已保存' }).waitFor();
  await page.getByRole('button', { name: '导入 Modbus 已选设备', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '导入' }).waitFor();
  if (await page.getByRole('combobox', { name: '测点类型', exact: true }).nth(0).inputValue() !== 'AI' || await page.getByRole('combobox', { name: '测点类型', exact: true }).nth(1).inputValue() !== 'DI') throw new Error('New import did not infer types');
  await page.setExtraHTTPHeaders({ 'X-Fixture-Role': 'viewer' }); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '只读' }).waitFor(); await page.getByRole('tab', { name: '设备和测点', exact: true }).click();
  if (await page.getByRole('button', { name: '按 Modbus 更新 AI/DI', exact: true }).isEnabled()) throw new Error('Viewer can classify');
  return 'PASS automatic new-point AI/DI, explicit correction across pages, ALARM/code/check preservation, manual override and viewer permissions';
}
