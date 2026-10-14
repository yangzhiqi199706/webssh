async (page) => {
  await page.setExtraHTTPHeaders({});
  await page.goto('http://127.0.0.1:3037/proto-conv/index.html');
  await page.evaluate(async () => fetch('/fixture/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 3, points: 52 }) }));
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click();
  await page.getByRole('tab', { name: '设备和测点', exact: true }).click();
  const card = page.locator('.bi-device').first();
  if (await card.locator('tbody tr').count() !== 25) throw new Error('Point DOM is not bounded by page size');
  await card.getByRole('textbox', { name: '12 位 ID', exact: true }).first().fill('100299901000');
  await card.getByRole('checkbox', { name: '转发 参数1', exact: true }).uncheck();
  await card.getByRole('button', { name: '下一页测点', exact: true }).click();
  await card.getByRole('textbox', { name: '12 位 ID', exact: true }).first().fill('100288801000');
  await card.getByRole('button', { name: '下一页测点', exact: true }).click();
  if (await card.locator('tbody tr').count() !== 2) throw new Error('Last point page count incorrect');
  await card.getByRole('button', { name: '移除', exact: true }).first().click();
  await card.getByRole('button', { name: '移除', exact: true }).first().click();
  if (await card.locator('tbody tr').count() !== 25) throw new Error('Removing last point page failed to clamp pagination');
  await card.getByRole('button', { name: '添加告警映射', exact: true }).click();
  if (await card.getByRole('combobox', { name: '测点类型', exact: true }).first().inputValue() !== 'ALARM') throw new Error('New alarm row must be visible on its point page');
  await card.getByRole('textbox', { name: '精确告警名称', exact: true }).fill('测试告警');
  await card.getByRole('textbox', { name: '12 位 ID', exact: true }).fill('100277701001');
  await page.getByRole('button', { name: '保存设备和测点', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '配置已保存' }).waitFor();
  const payload = await page.evaluate(async () => (await (await fetch('/fixture/saved')).json()).slice(-1)[0]);
  const d = payload.devices[0];
  if (d.params.length !== 50 || d.params.some(p => p.paraName === '参数1') || !d.params.some(p => p.signalId === '100288801000') || !d.params.some(p => p.type === 'ALARM' && p.signalId === '100277701001')) throw new Error('Point draft was lost across hidden pages');
  return 'PASS point pagination bounds, hidden-page drafts, last-page removal, visible alarm addition and complete payload';
}
