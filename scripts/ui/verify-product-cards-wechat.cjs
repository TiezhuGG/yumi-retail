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
    const stamp = Date.now();
    const root = await call('/admin/categories', { name: `商品聚合验收-${stamp}` });
    createdCategories.push(root.id);
    const warehouse = (await call('/warehouse/warehouses')).items[0],
      stockPath = `/warehouse/warehouses/${warehouse.id}/stock?limit=50`,
      stockBefore = await call(stockPath);
    let multi = await call('/admin/products', {
      categoryId: root.id,
      name: `多规格合成-${stamp}`,
      description: '本地聚合验收；有货仅原生显示夹具',
      skus: [
        {
          code: `CUI-A-${stamp}`,
          spec: '单包参考规格',
          unit: '包',
          priceCents: 100,
          expiryManaged: false,
        },
        {
          code: `CUI-B-${stamp}`,
          spec: '目标规格三包装',
          unit: '组',
          priceCents: 450,
          expiryManaged: false,
        },
        {
          code: `CUI-OFF-${stamp}`,
          spec: '停用低价',
          unit: '包',
          priceCents: 1,
          expiryManaged: false,
        },
      ],
    });
    products.push(multi.id);
    const bSku = multi.skus.find((s) => s.code.startsWith('CUI-B-')),
      off = multi.skus.find((s) => s.code.startsWith('CUI-OFF-'));
    multi = await call(`/admin/products/${multi.id}/skus/${off.id}/disable`, {
      version: multi.version,
    });
    multi = await call(`/admin/products/${multi.id}/publish`, { version: multi.version });
    let single = await call('/admin/products', {
      categoryId: root.id,
      name: `单规格合成-${stamp}`,
      description: '本地聚合验收',
      skus: [
        {
          code: `CUI-SINGLE-${stamp}`,
          spec: '单件装',
          unit: '件',
          priceCents: 550,
          expiryManaged: false,
        },
      ],
    });
    products.push(single.id);
    single = await call(`/admin/products/${single.id}/publish`, { version: single.version });
    const real = await call(`/storefront/products?categoryId=${root.id}`),
      legacy = await call(`/products?categoryId=${root.id}`);
    assert.equal(real.items.length, 2);
    assert.equal(legacy.items.length, 3);
    const realMulti = real.items.find((r) => r.id === multi.id);
    assert.equal(realMulti.variantCount, 2);
    assert.equal(realMulti.priceCents, 100);
    assert.equal(realMulti.hasStock, false);
    const match = await call(
      `/storefront/products?categoryId=${root.id}&keyword=${encodeURIComponent('目标规格')}`,
    );
    assert.equal(match.items.length, 1);
    assert.equal(match.items[0].entrySkuId, bSku.id);
    assert.equal(match.items[0].priceCents, 450);
    const first = await call(`/storefront/products?categoryId=${root.id}&limit=1`),
      second = await call(
        `/storefront/products?categoryId=${root.id}&limit=1&cursor=${first.nextCursor}`,
      );
    assert.equal(new Set([...first.items, ...second.items].map((r) => r.id)).size, 2);
    const detail = await call(`/products/${bSku.id}`);
    assert.equal(detail.variants.length, 2);
    const mixed = real.items.map((r) =>
      r.id === multi.id
        ? {
            ...r,
            entrySkuId: bSku.id,
            priceCents: 450,
            spec: bSku.spec,
            unit: bSku.unit,
            hasStock: true,
          }
        : r,
    );
    // hasStock/available are explicit display fixtures; no local stock is created.
    const detailFixture = {
      ...detail,
      available: 3,
      variants: detail.variants.map((v) => ({ ...v, available: v.id === bSku.id ? 3 : 0 })),
    };
    const fixture = {
      multiId: multi.id,
      categories: {
        items: [{ id: root.id, name: root.name, parentId: null, parentName: null }],
        hasMore: false,
        nextCursor: null,
      },
      all: { ...real, items: mixed },
      real,
      first: { ...first, items: first.items.map((r) => mixed.find((m) => m.id === r.id)) },
      second: { ...second, items: second.items.map((r) => mixed.find((m) => m.id === r.id)) },
      match: { ...match, items: match.items.map((r) => ({ ...r, hasStock: true })) },
      detail: detailFixture,
    };
    mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    const respond = async (f) => {
      await mini.mockWxMethod(
        'request',
        async function (options, fixture) {
          const path = options.url.split('/api/v1')[1] || '';
          if (path.startsWith('/categories'))
            return { statusCode: 200, data: { data: fixture.categories } };
          if (path.startsWith('/products/'))
            return { statusCode: 200, data: { data: fixture.detail } };
          if (fixture.delay) await new Promise((r) => setTimeout(r, fixture.delay));
          if (fixture.failCursor && path.includes('cursor='))
            return { statusCode: 503, data: { error: { message: '合成追加失败' } } };
          let data = fixture.paged
            ? path.includes('cursor=')
              ? fixture.second
              : fixture.first
            : fixture.all;
          if (path.includes('keyword=')) data = fixture.match;
          if (fixture.empty) data = { items: [], hasMore: false, nextCursor: null };
          return { statusCode: 200, data: { data } };
        },
        f,
      );
      mocked = true;
    };
    let page;
    async function wait(selector, text) {
      for (let i = 0; i < 65; i++) {
        for (const e of await page.$$(selector))
          if (text === undefined || (await e.text()).includes(text)) return e;
        await page.waitFor(150);
      }
      throw Error('Missing card UI ' + selector + ' ' + (text || ''));
    }
    const shot = async (name) => {
      await page.waitFor(300);
      await mini.screenshot({
        path: path.resolve(`docs/verification/WECHAT-PRODUCT-CARDS-${name}-2026-10-31.png`),
      });
    };
    const scrollTo = async (el) => {
      await mini.pageScrollTo(0);
      const offset = await el.offset();
      await mini.pageScrollTo(Math.max(0, offset.top - 30));
      await page.waitFor(200);
    };
    await respond({ ...fixture, delay: 5000 });
    page = await mini.reLaunch('/pages/index/index');
    await scrollTo(await wait('.skeleton'));
    await shot('LOADING');
    await wait('.product-title', multi.name);
    await respond(fixture);
    assert.equal((await page.$$('.product-card')).length, 2);
    await scrollTo(await wait('.product-title', multi.name));
    await shot('HOME');
    const multiCard = await wait('.product-card', multi.name);
    assert((await multiCard.text()).includes('2种规格'));
    assert((await multiCard.text()).includes('有货规格起价'));
    assert((await multiCard.text()).includes('4.50'));
    const badgeSize = await (await multiCard.$('.product-open')).size();
    assert(
      parseFloat(badgeSize.width) > parseFloat(badgeSize.height),
      'text badge should not use the old arrow circle',
    );
    await multiCard.tap();
    for (let i = 0; i < 40; i++) {
      const p = await mini.currentPage();
      if (p.path === 'pages/product/index') {
        page = p;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(page.query.id, bSku.id);
    await wait('.detail-price', '4.50');
    await wait('.spec-choice.selected', bSku.spec);
    await shot('DETAIL');
    await respond(fixture);
    page = await mini.reLaunch('/pages/index/index');
    await wait('.product-card');
    await (await wait('.category-chip', root.name)).tap();
    await wait('.category-context', root.name);
    await scrollTo(await wait('.product-title', multi.name));
    await shot('CATEGORY');
    await respond({ ...fixture, paged: true });
    page = await mini.reLaunch('/pages/index/index');
    await wait('.load-more');
    assert.equal((await page.$$('.product-card')).length, 1);
    await respond({ ...fixture, paged: true, failCursor: true });
    await scrollTo(await wait('.load-more'));
    await (await wait('.load-more')).tap();
    await wait('.store-feedback', '合成追加失败');
    assert.equal((await page.$$('.product-card')).length, 1);
    await shot('PAGE-ERROR');
    await respond({ ...fixture, paged: true });
    await (await wait('.store-feedback button')).tap();
    for (let i = 0; i < 30 && (await page.$$('.product-card')).length !== 2; i++)
      await page.waitFor(150);
    assert.equal((await page.$$('.product-card')).length, 2);
    await (await page.$('input')).input('目标规格');
    await (await wait('.store-search button')).tap();
    await wait('.product-spec', bSku.spec);
    assert.equal((await page.$$('.product-card')).length, 1);
    await scrollTo(await wait('.product-title', multi.name));
    await shot('SEARCH');
    await respond({ ...fixture, all: real });
    page = await mini.reLaunch('/pages/index/index');
    await wait('.product-title', multi.name);
    const out = await wait('.product-card', multi.name);
    assert((await out.text()).includes('缺货参考价'));
    assert((await out.text()).includes('1.00'));
    await scrollTo(out);
    await shot('OUT-OF-STOCK');
    await respond({ ...fixture, empty: true });
    page = await mini.reLaunch('/pages/index/index');
    await scrollTo(await wait('.store-feedback', '还没找到'));
    await shot('EMPTY');
    assert.deepEqual(await call(stockPath), stockBefore);
    fs.writeFileSync(
      '.local/cards-live.json',
      JSON.stringify(
        {
          productIds: products,
          categoryIds: createdCategories,
          realGroupedCards: 2,
          legacySkuRows: 3,
          referencePrice: 100,
          searchPrice: 450,
          realNoStock: true,
          stockUnchanged: true,
          nativeHasStockFixture: true,
          detailEntry: bSku.id,
          paginationRetry: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Product cards: real API 2 cards/3 SKU rows, product cursor, matched SKU entry and reference price passed. Native URL-routed fixtures verify loading, merged/mixed-stock cards, detail entry, category/search, page retry, all-out-of-stock and empty. No stock writes or native HTTP/real-device acceptance.',
    );
  } finally {
    if (mini) {
      if (mocked) await mini.restoreWxMethod('request');
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
  console.error(e.message);
  process.exit(1);
});
