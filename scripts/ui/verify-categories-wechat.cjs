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
    const root = await call('/admin/categories', { name: `微信分类根-${stamp}` });
    createdCategories.push(root.id);
    const child = await call('/admin/categories', { name: '纸品与清洁', parentId: root.id });
    createdCategories.push(child.id);
    const empty = await call('/admin/categories', { name: `空分类-${stamp}` });
    createdCategories.push(empty.id);
    const warehouse = (await call('/warehouse/warehouses')).items[0];
    const stockPath = `/warehouse/warehouses/${warehouse.id}/stock?limit=50`,
      stockBefore = await call(stockPath);
    for (const [i, categoryId] of [root.id, child.id].entries()) {
      let p = await call('/admin/products', {
        categoryId,
        name: `微信分类合成-${i}-${stamp}`,
        description: '纯本地分类验收资料',
        skus: [
          {
            code: `WXCAT-${i}-${stamp}`,
            spec: '1包',
            unit: '包',
            priceCents: 450 + i * 100,
            expiryManaged: false,
          },
        ],
      });
      products.push(p.id);
      await call(`/admin/products/${p.id}/publish`, { version: p.version });
    }
    const getList = async (q) => call('/products?limit=1' + q);
    const rootFirst = await getList(`&categoryId=${root.id}`),
      rootNext = await getList(`&categoryId=${root.id}&cursor=${rootFirst.nextCursor}`);
    assert.equal(rootFirst.items.length, 1);
    assert(rootFirst.nextCursor);
    assert.equal(rootNext.items.length, 1);
    const childList = await call(`/products?categoryId=${child.id}`),
      emptyList = await call(`/products?categoryId=${empty.id}`);
    assert.equal(childList.items.length, 1);
    assert.equal(emptyList.items.length, 0);
    let allCategories = [],
      cursor = null;
    do {
      const p = await call(`/categories?limit=50${cursor ? `&cursor=${cursor}` : ''}`);
      allCategories.push(...p.items);
      cursor = p.nextCursor;
    } while (cursor);
    const publicRoot = allCategories.find((c) => c.id === root.id),
      publicChild = allCategories.find((c) => c.id === child.id),
      publicEmpty = allCategories.find((c) => c.id === empty.id);
    assert.equal(publicChild.parentName, root.name);
    assert(publicRoot && publicEmpty);
    mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    let page;
    const fixture = {
      rootId: root.id,
      childId: child.id,
      emptyId: empty.id,
      categories: { items: [publicRoot], hasMore: true, nextCursor: root.id },
      categoryNext: { items: [publicChild, publicEmpty], hasMore: false, nextCursor: null },
      all: { items: [...rootFirst.items, ...rootNext.items], hasMore: false, nextCursor: null },
      rootFirst,
      rootNext,
      child: childList,
      empty: emptyList,
      categoryDelay: 0,
    };
    const respond = async (f) => {
      await mini.mockWxMethod(
        'request',
        async function (options, fixture) {
          const path = options.url.split('/api/v1')[1] || '';
          if (path.startsWith('/categories')) {
            if (fixture.categoryDelay)
              await new Promise((r) => setTimeout(r, fixture.categoryDelay));
            if (fixture.categoryError)
              return { statusCode: 503, data: { error: { message: '合成分类加载失败' } } };
            return {
              statusCode: 200,
              data: { data: path.includes('cursor=') ? fixture.categoryNext : fixture.categories },
            };
          }
          if (fixture.productError)
            return { statusCode: 503, data: { error: { message: '合成商品加载失败' } } };
          let data = fixture.all;
          if (path.includes('categoryId=' + fixture.rootId))
            data = path.includes('cursor=') ? fixture.rootNext : fixture.rootFirst;
          if (path.includes('categoryId=' + fixture.childId)) data = fixture.child;
          if (path.includes('categoryId=' + fixture.emptyId)) data = fixture.empty;
          if (path.includes('keyword=')) data = fixture.empty;
          return { statusCode: 200, data: { data } };
        },
        f,
      );
      mocked = true;
    };
    async function wait(selector, text) {
      for (let i = 0; i < 65; i++) {
        const e = await page.$(selector);
        if (e && (text === undefined || (await e.text()).includes(text))) return e;
        await page.waitFor(150);
      }
      throw Error('Missing native category state ' + selector + ' ' + (text || ''));
    }
    const shot = async (name) => {
      await page.waitFor(250);
      await mini.screenshot({
        path: path.resolve(`docs/verification/WECHAT-CATEGORIES-${name}-2026-10-31.png`),
      });
    };
    const tapText = async (selector, text) => {
      if (selector === '.category-chip') await (await page.$('.category-scroll')).scrollTo(0, 0);
      for (const e of await page.$$(selector))
        if ((await e.text()) === text) {
          if (selector === '.category-chip') {
            const offset = await e.offset();
            await (await page.$('.category-scroll')).scrollTo(Math.max(0, offset.left - 30), 0);
            await page.waitFor(150);
          }
          await e.tap();
          return;
        }
      throw Error('Missing button ' + text);
    };
    await respond({ ...fixture, categoryDelay: 5000 });
    page = await mini.reLaunch('/pages/index/index');
    await wait('.category-status', '正在加载分类');
    await shot('LOADING');
    await wait('.category-chip', '全部商品');
    await page.waitFor(2200);
    await wait('.category-chip.selected');
    await respond(fixture);
    await (await wait('.category-more')).tap();
    await wait('.category-chips', publicChild.parentName + ' / ' + publicChild.name);
    assert.equal((await page.$$('.category-chip')).length, 4);
    await tapText('.category-chip', root.name);
    await wait('.category-context', root.name);
    await wait('.product-card');
    assert.equal((await page.$$('.product-card')).length, 1);
    await shot('PARENT');
    await (await wait('.load-more')).tap();
    for (let i = 0; i < 30 && (await page.$$('.product-card')).length !== 2; i++)
      await page.waitFor(100);
    assert.equal((await page.$$('.product-card')).length, 2);
    await tapText('.category-chip', root.name + ' / ' + child.name);
    await wait('.category-context', child.name);
    await wait('.product-card');
    assert.equal((await page.$$('.product-card')).length, 1);
    await shot('CHILD');
    await (await page.$('input')).input('不存在的合成搜索');
    await (await wait('.store-search button')).tap();
    await wait('.store-feedback', '还没找到');
    await wait('.category-context', child.name);
    await shot('SEARCH-EMPTY');
    await tapText('.section-link', '清除关键词');
    await wait('.product-card');
    await tapText('.category-chip', empty.name);
    await wait('.store-feedback', '还没找到');
    await shot('EMPTY');
    await respond({ ...fixture, categoryError: true });
    await (await wait('.category-refresh')).tap();
    await wait('.category-error');
    await shot('ERROR');
    await respond(fixture);
    await (await wait('.category-error button')).tap();
    await wait('.category-more');
    await respond({ ...fixture, productError: true });
    await tapText('.category-chip', root.name);
    await wait('.store-feedback', '暂时没能加载商品');
    await shot('PRODUCT-ERROR');
    await respond(fixture);
    await (await wait('.store-feedback button')).tap();
    await wait('.product-card');
    await (await wait('.category-context button')).tap();
    await wait('.product-card');
    assert.equal((await page.$$('.product-card')).length, 2);
    await respond({ ...fixture, categories: { items: [], hasMore: false, nextCursor: null } });
    await (await wait('.category-refresh')).tap();
    await wait('.category-status', '暂无可浏览分类');
    await shot('NO-CATEGORIES');
    assert.deepEqual(await call(stockPath), stockBefore);
    fs.writeFileSync(
      '.local/categories-live.json',
      JSON.stringify(
        {
          categoryIds: createdCategories,
          productIds: products,
          parentScope: true,
          childScope: true,
          realEmpty: true,
          actualPublicNames: true,
          stockUnchanged: true,
          nativeFixture: true,
          pagination: true,
          searchRetainsCategory: true,
          independentRetry: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Categories passed: real public parent/child names, scoped products and cursor, empty category, unchanged stock. Native URL-routed fixtures verified loading/paging/parent/child/search/empty/independent errors and retry. Not real-device or native HTTP domain acceptance.',
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
