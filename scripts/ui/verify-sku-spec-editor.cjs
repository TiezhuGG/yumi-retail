// Synthetic UI responses; actual PostgreSQL and live API checks are separate.
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
      displayName: '规格说明合成验证',
      roles: ['SUPER_ADMIN'],
      permissions: ['catalog.read', 'catalog.write'],
      warehouseIds: [],
      csrfToken: 'fixture',
    };
    let current = {
      id: 'p1',
      categoryId: 'c1',
      name: '合成抽纸',
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
          enabled: true,
          expiryManaged: false,
        },
      ],
    };
    let detailFail = true,
      missing = false,
      listFail = false,
      mode = 'conflict';
    const attempts = [],
      replays = new Map();
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request(),
        p = new URL(req.url()).pathname;
      let data;
      if (p.endsWith('/staff/me')) data = profile;
      else if (p.endsWith('/admin/categories'))
        data = {
          items: [{ id: 'c1', name: '日用品', parentId: null, enabled: true, version: 0 }],
          nextCursor: null,
        };
      else if (p.endsWith('/admin/products')) {
        if (listFail)
          return route.fulfill({ status: 503, json: { error: { message: '合成列表失败' } } });
        data = { items: [current], nextCursor: null };
      } else if (p.endsWith('/admin/products/p1')) {
        if (detailFail) {
          await new Promise((r) => setTimeout(r, 800));
          return route.fulfill({ status: 503, json: { error: { message: '合成读取失败' } } });
        }
        data = missing ? { ...current, skus: [] } : current;
      } else if (p.endsWith('/update-spec')) {
        const body = req.postDataJSON(),
          key = req.headers()['idempotency-key'];
        attempts.push({ body, key });
        if (replays.has(key)) data = replays.get(key);
        else if (mode === 'conflict')
          return route.fulfill({
            status: 409,
            json: { error: { code: 'VERSION_CONFLICT', message: '合成商品版本冲突' } },
          });
        else {
          current = {
            ...current,
            version: current.version + 1,
            skus: [{ ...current.skus[0], spec: body.spec }],
          };
          data = structuredClone(current);
          replays.set(key, data);
          if (mode === 'unknown') {
            current = {
              ...current,
              version: current.version + 1,
              skus: [{ ...current.skus[0], spec: '3包装（之后的当前说明）' }],
            };
            return route.abort('failed');
          }
          if (mode === 'refresh-fail') listFail = true;
        }
      } else throw Error('Unexpected request ' + p);
      return route.fulfill({ json: { data } });
    });
    const dialog = page.getByRole('dialog'),
      open = () => page.getByRole('button', { name: '规格说明', exact: true }).click();
    const navigate = () =>
      page.getByRole('navigation').getByRole('button', { name: '商品管理', exact: true }).click();
    const shot = (name) =>
      page.screenshot({
        path: path.resolve(`docs/verification/UI-SKU-SPEC-${name}-2026-10-30.png`),
      });
    await page.goto('http://127.0.0.1:5173/');
    await navigate();
    await open();
    await dialog.getByText('正在读取最新规格说明…').waitFor();
    await shot('LOADING');
    await dialog.getByRole('alert').waitFor();
    await shot('ERROR');
    detailFail = false;
    missing = true;
    await dialog.getByRole('button', { name: '重新读取规格' }).click();
    await dialog.getByText('该规格不存在，请关闭并刷新商品列表').waitFor();
    missing = false;
    await dialog.getByRole('button', { name: '重新读取规格' }).click();
    const spec = dialog.getByLabel('规格说明', { exact: true });
    await spec.waitFor();
    assert(await dialog.getByRole('button', { name: '保存规格说明', exact: true }).isDisabled());
    await spec.fill(' ');
    assert(await dialog.getByRole('button', { name: '保存规格说明', exact: true }).isDisabled());
    assert.equal(await dialog.getByRole('textbox').count(), 1);
    await spec.fill(' 3包装（文字更正） ');
    await dialog.getByRole('button', { name: '保存规格说明', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await spec.inputValue(), ' 3包装（文字更正） ');
    assert(await spec.isDisabled());
    assert.deepEqual(attempts.at(-1).body, { version: 0, spec: '3包装（文字更正）' });
    await shot('CONFLICT');
    current = { ...current, version: 4 };
    mode = 'unknown';
    await dialog.getByRole('button', { name: '载入最新资料（替换当前填写）' }).click();
    await spec.fill('3包装（原包装说明）');
    await dialog.getByRole('button', { name: '保存规格说明', exact: true }).click();
    await dialog.getByRole('button', { name: '使用原内容重试确认' }).waitFor();
    assert(await spec.isDisabled());
    await shot('UNKNOWN');
    await dialog.getByRole('button', { name: '使用原内容重试确认' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(attempts.at(-1), attempts.at(-2));
    await page.getByRole('cell').filter({ hasText: '3包装（之后的当前说明）' }).waitFor();
    mode = 'success';
    await open();
    await spec.waitFor();
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
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    mode = 'refresh-fail';
    await open();
    await spec.fill('3包装（最后更正）');
    await dialog.getByRole('button', { name: '保存规格说明', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page
      .getByText('规格说明修改已确认，但列表刷新失败，请刷新列表核对当前资料。', { exact: true })
      .waitFor();
    listFail = false;
    profile.permissions = ['catalog.read'];
    await page.reload();
    await navigate();
    await page.getByText('合成抽纸', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '规格说明', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'SKU spec UI passed: detail loading/error/missing/retry, readonly identifiers, trim, conflict, frozen original intent replay/current refresh, acknowledged refresh failure, read-only role, 320/375/414.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
