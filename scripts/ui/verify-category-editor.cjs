// Synthetic UI failures; real database behavior is verified separately.
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
      displayName: '分类合成验证',
      roles: ['SUPER_ADMIN'],
      permissions: ['catalog.read', 'catalog.write'],
      warehouseIds: [],
      csrfToken: 'fixture',
    };
    let current = {
      id: 'c1',
      name: '合成日用分类',
      parentId: null,
      enabled: true,
      version: 0,
      parent: null,
    };
    let detailFail = true,
      listFail = false,
      empty = false,
      mode = 'conflict';
    const attempts = [],
      replays = new Map();
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request(),
        p = new URL(req.url()).pathname;
      let data;
      if (p.endsWith('/staff/me')) data = profile;
      else if (p.endsWith('/admin/products')) data = { items: [], nextCursor: null };
      else if (p.endsWith('/admin/categories')) {
        if (listFail)
          return route.fulfill({ status: 503, json: { error: { message: '合成分类列表失败' } } });
        data = { items: empty ? [] : [current], nextCursor: null };
      } else if (p.endsWith('/admin/categories/c1')) {
        if (detailFail) {
          await new Promise((r) => setTimeout(r, 800));
          return route.fulfill({ status: 503, json: { error: { message: '合成分类详情失败' } } });
        }
        data = current;
      } else if (/\/(rename|enable|disable)$/.test(p)) {
        const body = req.postDataJSON(),
          key = req.headers()['idempotency-key'];
        attempts.push({ p, body, key });
        if (replays.has(key)) data = replays.get(key);
        else if (mode === 'conflict')
          return route.fulfill({
            status: 409,
            json: { error: { code: 'VERSION_CONFLICT', message: '合成分类版本冲突' } },
          });
        else {
          current = {
            ...current,
            version: current.version + 1,
            ...(p.endsWith('/rename') ? { name: body.name } : { enabled: p.endsWith('/enable') }),
          };
          data = structuredClone(current);
          replays.set(key, data);
          if (mode === 'unknown') {
            current = { ...current, name: '之后更新的当前名称', version: current.version + 1 };
            return route.abort('failed');
          }
          if (mode === 'refresh-fail') listFail = true;
        }
      } else throw Error('Unexpected request ' + p);
      return route.fulfill({ json: { data } });
    });
    const dialog = page.getByRole('dialog'),
      open = () => page.getByRole('button', { name: '维护分类', exact: true }).click();
    const shot = (name) =>
      page.screenshot({
        path: path.resolve(`docs/verification/UI-CATEGORY-${name}-2026-10-30.png`),
      });
    const navigate = () =>
      page.getByRole('navigation').getByRole('button', { name: '商品分类', exact: true }).click();
    await page.goto('http://127.0.0.1:5173/');
    await navigate();
    await page.getByRole('button', { name: '维护分类', exact: true }).waitFor();
    await shot('LIST');
    await open();
    await dialog.getByText('正在读取最新分类…').waitFor();
    await shot('LOADING');
    await dialog.getByRole('alert').waitFor();
    await shot('ERROR');
    detailFail = false;
    await dialog.getByRole('button', { name: '重新读取分类' }).click();
    const name = dialog.getByLabel('分类名称', { exact: true });
    await name.waitFor();
    await name.fill(' ');
    assert(await dialog.getByRole('button', { name: '保存名称', exact: true }).isDisabled());
    await name.fill(' 改名草稿 ');
    assert(await dialog.getByRole('button', { name: '停用分类', exact: true }).isDisabled());
    await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(attempts.at(-1).body.name, '改名草稿');
    assert.equal(await name.inputValue(), ' 改名草稿 ');
    assert(await name.isDisabled());
    await shot('CONFLICT');
    current = { ...current, version: 3 };
    mode = 'unknown';
    await dialog.getByRole('button', { name: '载入最新资料（替换当前填写）' }).click();
    await name.fill('未知响应改名');
    await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
    await dialog.getByRole('button', { name: '使用原操作重试确认' }).waitFor();
    assert(await name.isDisabled());
    await shot('UNKNOWN');
    await dialog.getByRole('button', { name: '使用原操作重试确认' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(attempts.at(-1), attempts.at(-2));
    await page.getByText('▤　之后更新的当前名称', { exact: true }).waitFor();
    mode = 'success';
    await open();
    await name.waitFor();
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
    await dialog.getByRole('button', { name: '停用分类', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    current = {
      ...current,
      parentId: 'parent',
      parent: {
        id: 'parent',
        name: '未载入列表的父分类',
        enabled: false,
        version: 1,
        parentId: null,
      },
    };
    await open();
    await name.waitFor();
    assert(await dialog.getByRole('button', { name: '启用分类', exact: true }).isDisabled());
    await dialog.getByText(/父分类已停用，此分类下商品/).waitFor();
    await shot('PARENT-DISABLED');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    await page.getByRole('button', { name: '新增商品', exact: false }).click();
    assert(
      await dialog
        .locator('select[name="categoryId"] option[value="c1"]')
        .evaluate((option) => option.disabled),
    );
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await navigate();
    current = { ...current, parent: { ...current.parent, enabled: true } };
    await open();
    await dialog.getByRole('button', { name: '启用分类', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    mode = 'refresh-fail';
    await open();
    await name.fill('最后改名');
    await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page
      .getByText('分类操作已确认，但列表刷新失败，请刷新分类核对当前资料。', { exact: true })
      .waitFor();
    listFail = false;
    empty = true;
    await page.reload();
    await navigate();
    await page.getByText('还没有商品分类，先为好物建立分类吧。', { exact: true }).waitFor();
    await shot('EMPTY');
    empty = false;
    profile.permissions = ['catalog.read'];
    await page.reload();
    await navigate();
    await page.getByText('自身启用', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '维护分类', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Category UI passed: loading/error/retry, empty, parent detail, conflict, original intent replay/current refresh, enable/disable, acknowledged refresh failure, read-only and 320/375/414.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
