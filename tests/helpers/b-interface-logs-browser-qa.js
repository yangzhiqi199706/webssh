async (page) => {
  const warning = '设备 4：分组 1 未返回该设备，已改按设备 ID 查询；设备 5：分组 1 未返回该设备，已改按设备 ID 查询；设备 17：分组 9 未返回该设备，已改按设备 ID 查询';
  let entries = [
    { at: '2026-10-13 15:50:50', name: 'LOGIN', result: 'success', message: '业务 ACK 已确认' },
    { at: '2026-10-13 15:50:51', name: 'LOGIN', result: 'failed', message: 'XML 格式错误或超出限制' },
    { at: '2026-10-13 15:50:52', name: 'GET_DIDATA', result: 'received', message: 'SC 查询已处理' },
    { at: '2026-10-13 15:50:53', name: 'MAPPING', result: 'skipped', message: '1 条告警未找到唯一设备和名称映射，未转发' },
    { at: '2026-10-13 15:50:54', name: 'POLL', result: 'partial', message: '部分设备采集失败（1）：设备 31 查询失败' },
    { at: '2026-10-13 15:50:55', name: 'UNSUPPORTED', result: 'unsupported', message: '本次转发未实现此指令' },
    { at: '2026-10-13 15:50:56', name: 'SEND_HISALARM', result: 'other', message: '<img src=x onerror=alert(1)>\n' + 'A'.repeat(160) },
    { at: '2026-10-13 15:50:59', name: 'SOURCE', result: 'fallback', message: warning }
  ];
  await page.route('**/api/proto-conv/b-interface/logs', route => route.fulfill({ json: { ok: true, logs: entries } }));
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('http://127.0.0.1:3037/proto-conv/index.html');
  await page.getByRole('button', { name: 'B接口转发', exact: true }).click();
  await page.getByRole('tab', { name: '运行日志', exact: true }).click();
  await page.locator('#biLogCount').filter({ hasText: '显示 8 条' }).waitFor();
  const first = page.locator('#biLogRows tr').first();
  if (await first.locator('td').nth(1).textContent() !== 'SOURCE' || await first.locator('.bi-log-result').textContent() !== '回退查询' || await first.locator('td').last().textContent() !== warning) throw new Error('Log order or complete message lost');
  const columns = await first.locator('td').evaluateAll(cells => cells.map(c => c.getBoundingClientRect().width));
  if (columns[0] < 130 || columns[3] < 450 || columns[3] < columns[2] * 3) throw new Error('Log column widths still narrow: ' + columns);
  const time = await first.locator('time').boundingBox(), row = await first.boundingBox();
  if (time.height > 48 || row.height > 140) throw new Error('Timestamp or message still breaks vertically');
  if (await page.locator('#biLogRows img').count()) throw new Error('Untrusted log message rendered as HTML');
  const labels = await page.locator('.bi-log-result').allTextContents();
  for (const label of ['成功', '失败', '回退查询', '部分失败', '已接收', '已跳过', '未支持', 'other']) if (!labels.includes(label)) throw new Error('Missing result badge ' + label);
  await page.screenshot({ path: 'output/playwright/b-interface-logs-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const scroll = page.locator('.bi-log-scroll');
  if (!await scroll.evaluate(el => el.scrollWidth > el.clientWidth)) throw new Error('Mobile log table must scroll horizontally');
  const bounds = await scroll.boundingBox();
  if (bounds.x < 0 || bounds.x + bounds.width > 390) throw new Error('Mobile log region overflows');
  await scroll.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  if (!await scroll.evaluate(el => el.scrollLeft > 0)) throw new Error('Cannot reach mobile description');
  await page.screenshot({ path: 'output/playwright/b-interface-logs-mobile.png' });
  entries = []; await page.locator('#biReloadLogs').click(); await page.getByRole('cell', { name: '暂无运行日志', exact: true }).waitFor();
  if (await page.locator('#biLogRows td').getAttribute('colspan') !== '4') throw new Error('Empty state width wrong');
  return { result: 'PASS desktop widths, compact timestamp, full descriptions, badges, XSS safety, latest-first, empty state and mobile horizontal scrolling', columns };
}
