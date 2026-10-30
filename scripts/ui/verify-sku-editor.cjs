// Synthetic UI states. PostgreSQL and live API checks are separate.
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
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const profile = {
      id: 'fixture',
      displayName: '合成规格验证',
      roles: ['SUPER_ADMIN'],
      permissions: ['catalog.read', 'catalog.write'],
      warehouseIds: [],
      csrfToken: 'fixture',
    };
    let current = {
      id: 'p1',
      name: 'UI合成纸品',
      categoryId: 'c1',
      description: '',
      status: 'PUBLISHED',
      version: 0,
      skus: [
        {
          id: 's1',
          productId: 'p1',
          code: 'FIXTURE',
          spec: '3包装',
          unit: '包',
          priceCents: 719,
          expiryManaged: false,
          enabled: true,
        },
      ],
    };
    let detailFail = true,
      mode = 'conflict',
      listFail = false;
    const attempts = [],
      replays = new Map();
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request(),
        p = new URL(req.url()).pathname;
      let data;
      if (p.endsWith('/staff/me')) data = profile;
      else if (p.endsWith('/admin/categories'))
        data = {
          items: [{ id: 'c1', name: '日用纸品', enabled: true, parentId: null }],
          nextCursor: null,
        };
      else if (p.endsWith('/admin/products')) {
        if (listFail)
          return route.fulfill({ status: 503, json: { error: { message: '合成列表失败' } } });
        data = { items: [current], nextCursor: null };
      } else if (p.endsWith('/admin/products/p1')) {
        if (detailFail) {
          await new Promise((r) => setTimeout(r, 800));
          return route.fulfill({ status: 503, json: { error: { message: '合成详情失败' } } });
        }
        data = current;
      } else if (/\/(set-price|enable|disable)$/.test(p)) {
        const body = req.postDataJSON(),
          key = req.headers()['idempotency-key'];
        attempts.push({ p, body, key });
        if (replays.has(key)) data = replays.get(key);
        else if (mode === 'conflict')
          return route.fulfill({
            status: 409,
            json: { error: { code: 'VERSION_CONFLICT', message: '合成版本冲突，请载入最新资料' } },
          });
        else {
          current = {
            ...current,
            version: current.version + 1,
            skus: [
              {
                ...current.skus[0],
                ...(p.endsWith('set-price')
                  ? { priceCents: body.priceCents }
                  : { enabled: p.endsWith('/enable') }),
              },
            ],
          };
          data = structuredClone(current);
          replays.set(key, data);
          if (mode === 'unknown') {
            current = {
              ...current,
              version: current.version + 1,
              skus: [{ ...current.skus[0], priceCents: 888 }],
            };
            return route.abort('failed');
          }
          if (mode === 'refresh-fail') listFail = true;
        }
      } else throw Error('Unexpected request ' + p);
      return route.fulfill({ json: { data } });
    });
    const dialog = page.getByRole('dialog');
    const open = () => page.getByRole('button', { name: '售价与启停', exact: true }).click();
    const shot = (name) =>
      page.screenshot({ path: path.resolve(`docs/verification/UI-SKU-${name}-2026-10-30.png`) });
    await page.goto('http://127.0.0.1:5173/');
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    await open();
    await dialog.getByText('正在读取最新规格…').waitFor();
    await shot('LOADING');
    await dialog.getByRole('alert').waitFor();
    await shot('ERROR');
    detailFail = false;
    await dialog.getByRole('button', { name: '重新读取规格' }).click();
    const price = dialog.getByLabel('售价（元）');
    await price.waitFor();
    assert(await dialog.getByRole('button', { name: '停用规格', exact: true }).isDisabled());
    for (const invalid of ['0', '0.001', '-1', '1000000.01', '1e2']) {
      await price.fill(invalid);
      assert(await dialog.getByRole('button', { name: '保存售价' }).isDisabled());
    }
    await price.fill('0.29');
    await dialog.getByRole('button', { name: '保存售价' }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(attempts.at(-1).body.priceCents, 29);
    assert.equal(await price.inputValue(), '0.29');
    assert(await price.isDisabled());
    await shot('CONFLICT');
    current = { ...current, version: 5 };
    mode = 'unknown';
    await dialog.getByRole('button', { name: '载入最新资料（替换当前填写）' }).click();
    await price.fill('12.34');
    await dialog.getByRole('button', { name: '保存售价' }).click();
    await dialog.getByRole('button', { name: '使用原操作重试确认' }).waitFor();
    assert(await price.isDisabled());
    await shot('UNKNOWN');
    await dialog.getByRole('button', { name: '使用原操作重试确认' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(attempts.at(-1), attempts.at(-2));
    await page.getByText('¥8.88', { exact: true }).waitFor();
    current = { ...current, status: 'UNPUBLISHED' };
    mode = 'success';
    await open();
    await price.waitFor();
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: 812 });
      assert(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
      );
      assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    }
    await shot('MOBILE');
    await dialog.getByRole('button', { name: '停用规格', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('规格已停用', { exact: true }).waitFor();
    await open();
    await dialog.getByRole('button', { name: '启用规格', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    mode = 'refresh-fail';
    await open();
    await price.fill('7.19');
    await dialog.getByRole('button', { name: '保存售价' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page
      .getByText('规格操作已确认，但列表刷新失败，请刷新列表核对当前资料。', { exact: true })
      .waitFor();
    profile.permissions = ['catalog.read'];
    listFail = false;
    await page.reload();
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    assert.equal(await page.getByRole('button', { name: '售价与启停', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'SKU UI passed: loading/error/retry, cents, last enabled rule, conflict, same intent retry/current refresh, enable/disable, acknowledged refresh failure, read-only, 320/375/414.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
