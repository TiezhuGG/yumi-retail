// Synthetic UI responses only. No business writes reach an API.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let release, posting;
    const posted = new Promise((resolve) => {
      posting = resolve;
    });
    await page.route('**/api/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/staff/me'))
        return route.fulfill({
          json: {
            data: {
              id: 'fixture',
              displayName: 'UI合成运营',
              roles: ['ADMIN'],
              permissions: ['catalog.read', 'catalog.write'],
              warehouseIds: [],
              csrfToken: 'fixture',
            },
          },
        });
      if (p.endsWith('/admin/products') && route.request().method() === 'POST') {
        posting();
        await new Promise((resolve) => {
          release = resolve;
        });
        return route.fulfill({
          status: 409,
          json: { error: { message: 'UI合成保存冲突，输入应保留' } },
        });
      }
      const items = p.endsWith('/categories')
        ? [{ id: 'c1', name: 'UI合成日用', parentId: null, enabled: true }]
        : [];
      return route.fulfill({ json: { data: { items, nextCursor: null, hasMore: false } } });
    });
    await page.goto('http://127.0.0.1:5173/');
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    const open = page.getByRole('button', { name: '新增商品', exact: false });
    const dialog = page.getByRole('dialog');
    await open.click();
    await dialog.getByLabel('商品名称', { exact: true }).fill('UI合成未保存草稿');
    let box = await dialog.boundingBox();
    await page.mouse.click(box.x + 5, box.y + 35);
    assert.equal(
      await dialog.count(),
      1,
      'Clicking dialog padding must not discard the open draft',
    );
    assert.equal(
      await dialog.getByLabel('商品名称', { exact: true }).inputValue(),
      'UI合成未保存草稿',
    );
    const focusable = dialog.locator(
      'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])',
    );
    await focusable.last().focus();
    await page.keyboard.press('Tab');
    assert(
      await focusable.first().evaluate((el) => el === globalThis.document.activeElement),
      'Tab must remain in the modal',
    );
    await page.keyboard.press('Shift+Tab');
    assert(
      await focusable.last().evaluate((el) => el === globalThis.document.activeElement),
      'Reverse Tab must remain in the modal',
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert(
      await open.evaluate((el) => el === globalThis.document.activeElement),
      'Closing must return focus to the opener',
    );
    await open.click();
    box = await dialog.boundingBox();
    await page.mouse.click(Math.max(2, box.x - 12), 20);
    await dialog.waitFor({ state: 'hidden' });
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: 812 });
      await open.click();
      await dialog.getByLabel('商品名称', { exact: true }).fill(`UI合成手机草稿${width}`);
      box = await dialog.boundingBox();
      await page.mouse.click(box.x + 5, box.y + 35);
      assert.equal(await dialog.count(), 1, 'Mobile padding click must retain the form');
      assert(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1,
        ),
      );
      if (width === 375)
        await page.screenshot({
          path: path.resolve('docs/verification/UI-REVIEW-DIALOG-MOBILE-2026-10-30.png'),
        });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open.click();
    for (const [label, value] of [
      ['商品名称', 'UI合成忙碌草稿'],
      ['SKU编码', 'UI-MODAL'],
      ['规格', '1包'],
      ['单位', '包'],
      ['售价（元）', '1.23'],
    ])
      await dialog.getByLabel(label, { exact: true }).fill(value);
    await dialog.getByRole('combobox').selectOption('c1');
    await dialog.getByRole('button', { name: '保存商品草稿', exact: true }).click();
    await posted;
    assert.equal(await dialog.getByRole('button', { name: '关闭表单' }).isDisabled(), true);
    await page.keyboard.press('Escape');
    box = await dialog.boundingBox();
    await page.mouse.click(Math.max(2, box.x - 12), 20);
    assert.equal(await dialog.count(), 1, 'Saving form must not close on Escape/backdrop');
    release();
    await dialog.getByText('UI合成保存冲突，输入应保留', { exact: true }).waitFor();
    assert.equal(
      await dialog.getByLabel('商品名称', { exact: true }).inputValue(),
      'UI合成忙碌草稿',
    );
    await page.screenshot({
      path: path.resolve('docs/verification/UI-REVIEW-DIALOG-ERROR-2026-10-30.png'),
    });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log(
      'Modal UI passed: padding retains draft, real backdrop closes, Tab confinement, Escape/focus restoration, busy protection, failed save retains input and 320/375/414 layouts. Synthetic responses only.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
