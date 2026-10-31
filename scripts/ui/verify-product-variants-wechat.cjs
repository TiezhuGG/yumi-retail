// Local opt-in writes and simulator rendering only: wx.request fixtures are restored.
const automator = require(process.env.YUMI_MINI_AUTOMATOR_PATH || 'miniprogram-automator');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const database = new URL(process.env.DATABASE_URL || '');
if (
  process.env.YUMI_LIVE_UI !== '1' ||
  process.env.NODE_ENV === 'production' ||
  database.hostname !== '127.0.0.1' ||
  database.pathname !== '/yumi_dev' ||
  database.searchParams.has('schema')
)
  throw Error('Requires opt-in local yumi_dev/public');
(async () => {
  const base = 'http://127.0.0.1:3000/api/v1',
    origin = 'http://127.0.0.1:5173';
  let cookie,
    profile,
    product,
    mini,
    mocked = false;
  async function call(route, body) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie || '',
        Origin: origin,
        ...(body === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
              'X-CSRF-Token': profile?.csrfToken || '',
              'Idempotency-Key': randomUUID(),
            }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 200, route);
    return (await response.json()).data;
  }
  try {
    const login = await fetch(base + '/staff/auth/session', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginName: process.env.LOCAL_ADMIN_LOGIN,
        password: process.env.LOCAL_ADMIN_PASSWORD,
      }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    profile = (await login.json()).data;
    // Login returns a profile; reload to ensure CSRF shape is current.
    profile = await call('/staff/me');
    const category = (await call('/admin/categories?limit=50')).items.find(
      (c) => c.enabled && !c.parentId,
    );
    const stamp = Date.now();
    const warehouse = (await call('/warehouse/warehouses')).items[0];
    const stockPath = `/warehouse/warehouses/${warehouse.id}/stock?limit=50`;
    const stockBefore = await call(stockPath);
    product = await call('/admin/products', {
      categoryId: category.id,
      name: `微信规格合成验收-${stamp}`,
      description: '仅本地验收；原生库存展示含明确合成夹具',
      skus: [
        {
          code: `WXVAR-A-${stamp}`,
          spec: '单包装',
          unit: '包',
          priceCents: 450,
          expiryManaged: false,
        },
        {
          code: `WXVAR-B-${stamp}`,
          spec: '3包装',
          unit: '组',
          priceCents: 1299,
          expiryManaged: false,
        },
        {
          code: `WXVAR-C-${stamp}`,
          spec: '停用测试规格',
          unit: '箱',
          priceCents: 9900,
          expiryManaged: false,
        },
      ],
    });
    const a = product.skus.find((s) => s.code.startsWith('WXVAR-A-')),
      b = product.skus.find((s) => s.code.startsWith('WXVAR-B-')),
      c = product.skus.find((s) => s.code.startsWith('WXVAR-C-'));
    product = await call(`/admin/products/${product.id}/skus/${c.id}/disable`, {
      version: product.version,
    });
    product = await call(`/admin/products/${product.id}/publish`, { version: product.version });
    const realA = await call(`/products/${a.id}`),
      realB = await call(`/products/${b.id}`);
    assert.deepEqual(realA.variants.map((v) => v.id).sort(), [a.id, b.id].sort());
    assert.equal(realA.priceCents, 450);
    assert.equal(realB.priceCents, 1299);
    assert(realA.variants.every((v) => v.available === 0));
    // Display-only stock fixture: no receipt, inventory write, or fake real stock assertion.
    const fixture = (row) => ({
      ...row,
      available: row.id === a.id ? 3 : 0,
      variants: row.variants.map((v) => ({ ...v, available: v.id === a.id ? 3 : 0 })),
    });
    mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    const respond = async (data, statusCode = 200) => {
      await mini.mockWxMethod('request', {
        statusCode,
        data: statusCode === 200 ? { data } : { error: { message: data } },
      });
      mocked = true;
    };
    let page;
    async function wait(selector, text) {
      for (let i = 0; i < 45; i++) {
        const el = await page.$(selector);
        if (el && (text === undefined || (await el.text()).includes(text))) return el;
        await page.waitFor(150);
      }
      throw Error('Missing native state ' + selector + ' ' + (text || ''));
    }
    const shot = async (name) => {
      await page.waitFor(300);
      await mini.screenshot({
        path: path.resolve(`docs/verification/WECHAT-PRODUCT-VARIANTS-${name}-2026-10-31.png`),
      });
    };
    async function showOptions() {
      const el = await wait('.detail-spec-options');
      const offset = await el.offset();
      await mini.pageScrollTo(Math.max(0, offset.top - 95));
      await page.waitFor(250);
    }
    await respond(fixture(realA));
    page = await mini.reLaunch(`/pages/product/index?id=${a.id}`);
    await wait('.detail-price', '4.50');
    await shot('FIRST');
    await showOptions();
    await shot('OPTIONS');
    let options = await page.$$('.detail-spec-options button');
    assert.equal(options.length, 2);
    const choose = async (spec) => {
      const buttons = await page.$$('.detail-spec-options button');
      for (const button of buttons)
        if ((await button.text()).includes(spec)) {
          await button.tap();
          return;
        }
      throw Error('Missing option ' + spec);
    };
    await respond(fixture(realB));
    await choose('3包装');
    await wait('.detail-price', '12.99');
    assert((await (await wait('.detail-buy')).text()).includes('缺货'));
    await mini.pageScrollTo(0);
    await shot('SECOND');
    await showOptions();
    assert((await (await wait('.spec-choice.selected')).text()).includes('3包装'));
    await respond('合成网络错误，请重试', 503);
    await choose('单包装');
    await wait('.store-feedback', '合成网络错误');
    assert.equal(await page.$('.detail-price'), null);
    await shot('ERROR');
    await respond(fixture(realA));
    await (await page.$$('.store-feedback button'))[0].tap();
    await wait('.detail-price', '4.50');
    assert((await (await wait('.spec-choice.selected')).text()).includes('单包装'));
    product = await call(`/admin/products/${product.id}/skus/${b.id}/disable`, {
      version: product.version,
    });
    const hidden = await fetch(base + `/products/${b.id}`);
    assert.equal(hidden.status, 404);
    await showOptions();
    await respond('商品不可用', 404);
    await choose('3包装');
    await wait('.store-feedback', '商品不可用');
    await shot('UNAVAILABLE');
    assert.equal(await page.$('.detail-price'), null);
    product = await call(`/admin/products/${product.id}/skus/${b.id}/enable`, {
      version: product.version,
    });
    product = await call(`/admin/products/${product.id}/skus/${b.id}/set-price`, {
      version: product.version,
      priceCents: 1399,
    });
    const newB = await call(`/products/${b.id}`);
    assert.equal(newB.priceCents, 1399);
    await respond(fixture(newB));
    await (await page.$$('.store-feedback button'))[0].tap();
    await wait('.detail-price', '13.99');
    await shot('REFRESHED');
    product = await call(`/admin/products/${product.id}/skus/${a.id}/disable`, {
      version: product.version,
    });
    const single = await call(`/products/${b.id}`);
    assert.equal(single.variants.length, 1);
    await respond(single);
    page = await mini.reLaunch(`/pages/product/index?id=${b.id}`);
    await wait('.detail-spec-options');
    assert.equal((await page.$$('.detail-spec-options button')).length, 1);
    await showOptions();
    await shot('SINGLE');
    // Explicit 20-spec layout fixture, independent of the real 20-spec PostgreSQL test.
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...realA,
      id: `native-layout-${i}`,
      spec: i === 0 ? '超长规格文字'.repeat(20).slice(0, 100) : `${i + 1}包装`,
      priceCents: 100 + i,
      available: 0,
    }));
    const wide = { ...many[0], variants: many };
    await respond(wide);
    page = await mini.reLaunch(`/pages/product/index?id=${wide.id}`);
    await wait('.detail-spec-options');
    options = await page.$$('.detail-spec-options button');
    assert.equal(options.length, 20);
    const info = await mini.systemInfo();
    for (const button of options)
      assert(
        parseFloat((await button.size()).width) <= info.windowWidth,
        'option wider than screen',
      );
    await showOptions();
    await shot('TWENTY');
    const lastOffset = await options.at(-1).offset();
    await mini.pageScrollTo(Math.max(0, lastOffset.top - 250));
    await page.waitFor(200);
    await shot('TWENTY-END');
    await respond({ ...many[19], variants: many });
    await options.at(-1).tap();
    await wait('.detail-price', '1.19');
    assert((await (await wait('.spec-choice.selected')).text()).includes('20包装'));
    page = await mini.reLaunch('/pages/product/index');
    await wait('.store-feedback', '暂未找到');
    await shot('MISSING');
    assert.deepEqual(await call(stockPath), stockBefore);
    fs.writeFileSync(
      '.local/variants-live.json',
      JSON.stringify(
        {
          id: product.id,
          realVariants: 2,
          disabledExcluded: true,
          realPriceRefresh: true,
          actualStockUnchanged: true,
          nativeRequestFixture: true,
          nativeInStockDisplayFixture: true,
          switchRetry: true,
          unavailable: true,
          single: true,
          twentyLongLayout: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Variants: actual API siblings/price refresh/disabled visibility and unchanged stock passed. Native mocked request: price/stock fixture, switch/exact retry, unavailable, single, 20 long labels and missing ID passed. Not real-device or complete native HTTP acceptance.',
    );
  } finally {
    if (mini) {
      if (mocked) await mini.restoreWxMethod('request');
      await mini.disconnect();
    }
    if (product && profile) {
      let current = await call(`/admin/products/${product.id}`);
      if (current.status === 'PUBLISHED')
        await call(`/admin/products/${product.id}/unpublish`, { version: current.version });
    }
    if (profile) await call('/staff/auth/logout', {});
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
