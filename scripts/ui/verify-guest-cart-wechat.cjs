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
    mini,
    mocked = false;
  let hadStorage = false,
    storageBackup,
    storageTouched = false,
    storageMocked = false,
    modalMocked = false;
  const storageKey = 'yumi.guest-cart.v1:http://127.0.0.1:3000/api/v1';
  const createdCategories = [],
    products = [];
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
    const stamp = Date.now(),
      root = await call('/admin/categories', { name: `游客草稿验收-${stamp}` });
    createdCategories.push(root.id);
    const warehouse = (await call('/warehouse/warehouses')).items[0],
      stockPath = `/warehouse/warehouses/${warehouse.id}/stock?limit=50`,
      before = await call(stockPath);
    let p = await call('/admin/products', {
      categoryId: root.id,
      name: `购物车合成-${stamp}`,
      description: '本地草稿验收，原生有货数量为显示夹具',
      skus: [
        {
          code: `CART-A-${stamp}`,
          spec: '单包装',
          unit: '包',
          priceCents: 450,
          expiryManaged: false,
        },
        {
          code: `CART-B-${stamp}`,
          spec: '3包装',
          unit: '组',
          priceCents: 1299,
          expiryManaged: false,
        },
      ],
    });
    products.push(p.id);
    p = await call(`/admin/products/${p.id}/publish`, { version: p.version });
    const a = p.skus.find((s) => s.code.startsWith('CART-A-')),
      b = p.skus.find((s) => s.code.startsWith('CART-B-'));
    const realA = await call(`/products/${a.id}`),
      realB = await call(`/products/${b.id}`);
    assert.equal(realA.available, 0);
    assert.equal(realB.available, 0);
    assert.equal(realA.priceCents, 450);
    assert.equal(realB.priceCents, 1299);
    const details = {
      [a.id]: {
        ...realA,
        available: 3,
        variants: realA.variants.map((v) => ({ ...v, available: v.id === a.id ? 3 : 4 })),
      },
      [b.id]: {
        ...realB,
        available: 4,
        variants: realB.variants.map((v) => ({ ...v, available: v.id === a.id ? 3 : 4 })),
      },
    };
    mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    const storageInfo = await mini.callWxMethod('getStorageInfoSync');
    hadStorage = storageInfo.keys.includes(storageKey);
    if (hadStorage) storageBackup = await mini.callWxMethod('getStorageSync', storageKey);
    await mini.callWxMethod('setStorageSync', storageKey, { version: 1, items: [] });
    storageTouched = true;
    const respond = async (f) => {
      await mini.mockWxMethod(
        'request',
        async function (options, fixture) {
          const path = options.url.split('/api/v1')[1] || '',
            id = path.split('?')[0].split('/').pop();
          if (fixture.delay) await new Promise((r) => setTimeout(r, fixture.delay));
          if (fixture.failId === id)
            return { statusCode: 503, data: { error: { message: '合成网络错误' } } };
          if (fixture.goneId === id)
            return { statusCode: 404, data: { error: { message: '商品不可用' } } };
          if (path.startsWith('/products/'))
            return { statusCode: 200, data: { data: fixture.details[id] } };
          return {
            statusCode: 200,
            data: { data: { items: [], hasMore: false, nextCursor: null } },
          };
        },
        f,
      );
      mocked = true;
    };
    let page;
    async function wait(selector, text) {
      for (let i = 0; i < 70; i++) {
        for (const e of await page.$$(selector))
          if (text === undefined || (await e.text()).includes(text)) return e;
        await page.waitFor(150);
      }
      throw Error('Missing cart UI ' + selector + ' ' + (text || ''));
    }
    const shot = async (name) => {
      await page.waitFor(300);
      await mini.screenshot({
        path: path.resolve(`docs/verification/WECHAT-GUEST-CART-${name}-2026-10-31.png`),
      });
    };
    const raw = () => mini.callWxMethod('getStorageSync', storageKey);
    const waitStorage = async (test) => {
      for (let i = 0; i < 40; i++) {
        const value = await raw();
        if (test(value)) return value;
        await page.waitFor(100);
      }
      throw Error('Local storage did not settle');
    };
    const row = async (spec) => wait('.cart-row', spec);
    await respond({ details: { [a.id]: realA, [b.id]: realB } });
    page = await mini.reLaunch(`/pages/product/index?id=${a.id}`);
    await wait('.detail-buy', '商品暂时缺货');
    assert.equal((await raw()).items.length, 0);
    await respond({ details });
    page = await mini.reLaunch(`/pages/product/index?id=${a.id}`);
    await wait('.detail-buy', '加入本机草稿');
    await shot('DETAIL');
    await (await wait('.detail-buy')).tap();
    await page.waitFor(250);
    await (await wait('.detail-buy')).tap();
    await waitStorage((value) => value.items[0]?.quantity === 2);
    const choices = await page.$$('.spec-choice');
    for (const c of choices)
      if ((await c.text()).includes('3包装')) {
        await c.tap();
        break;
      }
    await wait('.detail-price', '12.99');
    await (await wait('.detail-buy')).tap();
    await waitStorage((value) => value.items.length === 2);
    await (await wait('.detail-cart-link')).tap();
    for (let i = 0; i < 40; i++) {
      const current = await mini.currentPage();
      if (current.path === 'pages/cart/index') {
        page = current;
        break;
      }
      await page.waitFor(150);
    }
    await wait('.cart-total', '21.99');
    await wait('.cart-note', '草稿仅保存在这台设备');
    assert.equal((await page.$$('.cart-row')).length, 2);
    await shot('READY');
    await (await (await row('单包装')).$('.cart-check')).tap();
    await wait('.cart-total', '12.99');
    await (await (await row('单包装')).$('.cart-check')).tap();
    await wait('.cart-total', '21.99');
    await mini.mockWxMethod('setStorageSync', function () {
      throw Error('合成存储失败');
    });
    storageMocked = true;
    await (await (await row('单包装')).$$('.cart-stepper button'))[1].tap();
    await wait('.store-feedback', '本机保存失败');
    assert.equal((await raw()).items.find((i) => i.skuId === a.id).quantity, 2);
    await shot('SAVE-ERROR');
    await mini.restoreWxMethod('setStorageSync');
    storageMocked = false;
    await (await (await row('单包装')).$$('.cart-stepper button'))[1].tap();
    await wait('.cart-total', '26.49');
    await (await (await row('单包装')).$$('.cart-stepper button'))[0].tap();
    await wait('.cart-total', '21.99');
    await respond({ details, delay: 5000 });
    page = await mini.reLaunch('/pages/cart/index');
    await wait('.cart-heading', '正在核验');
    await shot('LOADING');
    await wait('.cart-total', '21.99');
    await respond({
      details: { ...details, [a.id]: { ...details[a.id], available: 1 } },
      failId: b.id,
    });
    await (await wait('.cart-heading button')).tap();
    await wait('.cart-status', '数量超出');
    await wait('.cart-status', '暂未核验');
    await wait('.cart-total', '0.00');
    assert.equal((await raw()).items.find((i) => i.skuId === a.id).quantity, 2);
    await shot('UNKNOWN-AND-EXCESS');
    await (await (await row('单包装')).$$('.cart-stepper button'))[0].tap();
    await wait('.cart-total', '4.50');
    p = await call(`/admin/products/${p.id}/skus/${b.id}/disable`, { version: p.version });
    const disabled = await fetch(base + `/products/${b.id}`);
    assert.equal(disabled.status, 404);
    await respond({
      details: { ...details, [a.id]: { ...details[a.id], available: 0 } },
      goneId: b.id,
    });
    await (await wait('.cart-heading button')).tap();
    await wait('.cart-status', '商品已失效');
    await wait('.cart-status', '暂时缺货');
    await shot('GONE-AND-OUT');
    p = await call(`/admin/products/${p.id}/skus/${a.id}/set-price`, {
      version: p.version,
      priceCents: 499,
    });
    const newA = await call(`/products/${a.id}`);
    assert.equal(newA.priceCents, 499);
    await respond({ details: { ...details, [a.id]: { ...newA, available: 3 } }, goneId: b.id });
    await (await wait('.cart-heading button')).tap();
    await wait('.cart-total', '4.99');
    await shot('NEW-PRICE');
    page = await mini.reLaunch('/pages/cart/index');
    await wait('.cart-total', '4.99');
    assert.equal((await raw()).items.find((i) => i.skuId === a.id).quantity, 1);
    await (await (await row('3包装')).$('.cart-remove')).tap();
    await waitStorage((value) => value.items.length === 1);
    await (await (await row('单包装')).$('.cart-remove')).tap();
    await wait('.cart-empty', '购物车还是空的');
    await shot('EMPTY');
    await mini.callWxMethod('setStorageSync', storageKey, { version: 2, items: [] });
    page = await mini.reLaunch('/pages/cart/index');
    await wait('.store-feedback', '原资料已保留');
    assert.equal((await raw()).version, 2);
    await shot('CORRUPT');
    await mini.mockWxMethod('showModal', { confirm: false, cancel: true });
    modalMocked = true;
    let buttons = await page.$$('.store-feedback button');
    await buttons[1].tap();
    await page.waitFor(300);
    assert.equal((await raw()).version, 2);
    await mini.mockWxMethod('showModal', { confirm: true, cancel: false });
    buttons = await page.$$('.store-feedback button');
    await buttons[1].tap();
    await wait('.cart-empty', '购物车还是空的');
    assert.equal((await raw()).version, 1);
    await mini.restoreWxMethod('showModal');
    modalMocked = false;
    assert.deepEqual(await call(stockPath), before);
    fs.writeFileSync(
      '.local/cart-live.json',
      JSON.stringify(
        {
          productIds: products,
          categoryIds: createdCategories,
          actualPrices: [450, 1299, 499],
          actualDisabled404: true,
          stockUnchanged: true,
          nativeStockFixture: true,
          localStorageBackedUp: true,
          persisted: true,
          writeFailure: true,
          corruptProtected: true,
          referenceTotals: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Guest cart passed: actual API prices/disabled 404 and unchanged stock; native explicit stock fixtures verify add/variants, persisted quantity, selection, storage failure, loading, unknown/excess/gone/out, new price, removal, corrupt/reset. Original local storage restored in finally; no checkout or inventory write.',
    );
  } finally {
    if (mini) {
      if (storageMocked) await mini.restoreWxMethod('setStorageSync');
      if (modalMocked) await mini.restoreWxMethod('showModal');
      if (mocked) await mini.restoreWxMethod('request');
      if (storageTouched) {
        if (hadStorage) await mini.callWxMethod('setStorageSync', storageKey, storageBackup);
        else await mini.callWxMethod('removeStorageSync', storageKey);
      }
      if (storageTouched) {
        const restored = await mini.callWxMethod('getStorageInfoSync');
        assert.equal(restored.keys.includes(storageKey), hadStorage);
        if (hadStorage)
          assert.deepEqual(await mini.callWxMethod('getStorageSync', storageKey), storageBackup);
        fs.writeFileSync(
          '.local/cart-storage-restored.json',
          JSON.stringify({ hadStorage, restored: true }) + '\n',
        );
      }
      await mini.disconnect();
    }
    if (profile) {
      for (const id of products) {
        const p = await call(`/admin/products/${id}`);
        if (p.status === 'PUBLISHED')
          await call(`/admin/products/${id}/unpublish`, { version: p.version });
      }
      for (const id of [...createdCategories].reverse()) {
        const c = await call(`/admin/categories/${id}`);
        if (c.enabled) await call(`/admin/categories/${id}/disable`, { version: c.version });
      }
    }
    if (profile) await call('/staff/auth/logout', {});
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
