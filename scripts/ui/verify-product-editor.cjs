// Synthetic UI responses; real PostgreSQL edit behavior is covered separately.
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
    const profile = {
      id: 'fixture',
      displayName: 'UI合成运营',
      roles: ['SUPER_ADMIN'],
      permissions: ['catalog.read', 'catalog.write'],
      warehouseIds: [],
      csrfToken: 'fixture',
    };
    let current = {
      id: 'p1',
      name: 'UI合成原名称',
      categoryId: 'c1',
      description: '原说明',
      status: 'PUBLISHED',
      version: 0,
      skus: [
        {
          id: 's1',
          productId: 'p1',
          code: 'UI-EDIT',
          spec: '3包装',
          unit: '包',
          priceCents: 123,
          expiryManaged: false,
          enabled: true,
        },
      ],
    };
    let detailFail = true,
      categoryFail = false,
      listFail = false,
      mode = 'conflict';
    const keys = [],
      bodies = [],
      replay = new Map();
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request(),
        p = new URL(req.url()).pathname;
      let data;
      if (p.endsWith('/staff/me')) data = profile;
      else if (p.endsWith('/admin/categories')) {
        if (categoryFail)
          return route.fulfill({ status: 503, json: { error: { message: 'UI合成分类断网' } } });
        data = {
          items: [{ id: 'c1', name: '日用纸品', parentId: null, enabled: true }],
          nextCursor: null,
        };
      } else if (p.endsWith('/admin/products')) {
        if (listFail)
          return route.fulfill({ status: 503, json: { error: { message: 'UI合成列表失败' } } });
        data = { items: [current], nextCursor: null };
      } else if (p.endsWith('/admin/products/p1')) {
        if (detailFail) await new Promise((resolve) => setTimeout(resolve, 700));
        if (detailFail)
          return route.fulfill({ status: 503, json: { error: { message: 'UI合成详情失败' } } });
        data = current;
      } else if (p.endsWith('/update-details')) {
        const body = req.postDataJSON(),
          key = req.headers()['idempotency-key'];
        keys.push(key);
        bodies.push(body);
        if (replay.has(key)) data = replay.get(key);
        else if (mode === 'conflict')
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: 'VERSION_CONFLICT',
                message: '商品已被更新，请重新载入最新资料后编辑',
              },
            },
          });
        else {
          current = { ...current, ...body, version: body.version + 1 };
          data = structuredClone(current);
          replay.set(key, data);
          if (mode === 'unknown') return route.abort('failed');
          if (mode === 'refresh-fail') listFail = true;
        }
      } else throw Error(`Unexpected request: ${p}`);
      return route.fulfill({ json: { data } });
    });
    const dialog = page.getByRole('dialog');
    const open = () => page.getByRole('button', { name: '编辑资料', exact: true }).click();
    const shot = (name) =>
      page.screenshot({
        path: path.resolve(`docs/verification/UI-PRODUCT-EDIT-${name}-2026-10-30.png`),
      });
    await page.goto('http://127.0.0.1:5173/');
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    await open();
    await dialog.getByText('正在读取最新商品资料…', { exact: true }).waitFor();
    await shot('LOADING');
    await dialog.getByRole('button', { name: '重新读取商品' }).waitFor();
    await shot('LOAD-ERROR');
    detailFail = false;
    await dialog.getByRole('button', { name: '重新读取商品' }).click();
    await dialog.getByLabel('商品名称', { exact: true }).fill('UI合成自己填写');
    await dialog.getByRole('button', { name: '保存商品资料' }).click();
    await dialog.getByRole('button', { name: '载入最新资料（替换当前填写）' }).waitFor();
    assert.equal(
      await dialog.getByLabel('商品名称', { exact: true }).inputValue(),
      'UI合成自己填写',
    );
    assert.equal(await dialog.getByRole('button', { name: '保存商品资料' }).isDisabled(), true);
    await shot('CONFLICT');
    current = { ...current, name: '另一员工最新名称', version: 1 };
    await dialog.getByRole('button', { name: '载入最新资料（替换当前填写）' }).click();
    await dialog.getByLabel('商品名称', { exact: true }).fill('UI合成未知响应内容');
    mode = 'unknown';
    await dialog.getByRole('button', { name: '保存商品资料' }).click();
    await dialog.getByRole('button', { name: '使用原内容重试确认' }).waitFor();
    assert.equal(await dialog.getByLabel('商品名称', { exact: true }).isDisabled(), true);
    await shot('UNKNOWN');
    current = { ...current, name: '之后员工修改的当前名称', version: 3 };
    await dialog.getByRole('button', { name: '使用原内容重试确认' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('之后员工修改的当前名称', { exact: true }).waitFor();
    assert.equal(keys[1], keys[2]);
    assert.deepEqual(bodies[1], bodies[2]);
    assert.deepEqual(Object.keys(bodies[1]).sort(), [
      'categoryId',
      'description',
      'name',
      'version',
    ]);
    categoryFail = true;
    await open();
    await dialog.getByRole('button', { name: '重试分类' }).waitFor();
    categoryFail = false;
    await dialog.getByRole('button', { name: '重试分类' }).click();
    await dialog.getByRole('button', { name: '重试分类' }).waitFor({ state: 'hidden' });
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: 812 });
      assert(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1,
        ),
      );
      if (width === 375) await shot('MOBILE');
    }
    mode = 'refresh-fail';
    await dialog.getByLabel('商品名称', { exact: true }).fill('UI合成已确认保存');
    await dialog.locator('textarea').fill('');
    await dialog.getByRole('button', { name: '保存商品资料' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page
      .getByText('商品修改已确认，但列表刷新失败，请刷新列表核对当前资料。', { exact: true })
      .waitFor();
    assert.equal(bodies.at(-1).description, '');
    listFail = false;
    profile.permissions = ['catalog.read'];
    await page.reload();
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    await page.getByText('UI合成已确认保存', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '编辑资料', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Product editor UI passed: current detail/retry, conflict keeps input and reloads explicitly, unknown save freezes original intent and reuses key, current list beats historical replay, categories retry, clearing description, acknowledged save + list failure closes editor, read-only role and 320/375/414 layouts. Fixtures only.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
