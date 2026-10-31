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
    product = await call('/admin/products', {
      categoryId: category.id,
      name: `微信多图合成验收-${stamp}`,
      description: '纯色测试图，不是真实商品照片',
      skus: [
        {
          code: `WXGALLERY-${stamp}`,
          spec: '合成规格',
          unit: '包',
          priceCents: 719,
          expiryManaged: false,
        },
      ],
    });
    for (const name of ['image-red.png', 'image-blue.jpg']) {
      const gallery = await call(`/admin/products/${product.id}/add-image`, {
        version: product.version,
        image: {
          fileName: name,
          mime: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
          base64: fs.readFileSync(`tests/fixtures/${name}`).toString('base64'),
        },
      });
      product = gallery.product;
    }
    product = await call(`/admin/products/${product.id}/publish`, { version: product.version });
    const sale = await call(`/products/${product.skus[0].id}`);
    mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
    await mini.mockWxMethod('request', {
      statusCode: 200,
      data: { data: { items: [sale], hasMore: false, nextCursor: null } },
    });
    mocked = true;
    let page = await mini.reLaunch('/pages/index/index');
    async function wait(selector) {
      for (let i = 0; i < 40; i++) {
        const el = await page.$(selector);
        if (el) return el;
        await page.waitFor(200);
      }
      throw Error('Missing simulator element: ' + selector);
    }
    await wait('.product-card image');
    await mini.mockWxMethod('request', { statusCode: 200, data: { data: sale } });
    page = await mini.reLaunch(`/pages/product/index?id=${sale.id}`);
    await wait('.detail-gallery image');
    const waitCount = async (expected) => {
      for (let i = 0; i < 30; i++) {
        const count = await page.$('.detail-image-count');
        if (count && (await count.text()).replace(/\s+/g, '') === expected.replace(/\s+/g, ''))
          return;
        await page.waitFor(200);
      }
      throw Error('Unexpected gallery counter: ' + expected);
    };
    await waitCount('1 / 2');
    await page.waitFor(700);
    const shot = (name) =>
      mini.screenshot({
        path: path.resolve(`docs/verification/WECHAT-PRODUCT-GALLERY-${name}-2026-10-31.png`),
      });
    await shot('FIRST');
    let buttons = await page.$$('.detail-gallery-controls button');
    await buttons[1].tap();
    await waitCount('2 / 2');
    await page.waitFor(400);
    await shot('SECOND');
    buttons = await page.$$('.detail-gallery-controls button');
    await buttons[0].tap();
    await waitCount('1 / 2');
    assert.equal((await page.$$('.detail-gallery swiper-item')).length, 2);
    const broken = {
      ...sale,
      imageUrl: `/api/v1/product-images/${product.id}/${randomUUID()}`,
      imageUrls: [],
    };
    await mini.mockWxMethod('request', { statusCode: 200, data: { data: broken } });
    page = await mini.reLaunch(`/pages/product/index?id=${sale.id}`);
    await wait('.visual-caption');
    await shot('FALLBACK');
    const empty = { ...sale, imageUrl: null, imageUrls: [] };
    await mini.mockWxMethod('request', { statusCode: 200, data: { data: empty } });
    page = await mini.reLaunch(`/pages/product/index?id=${sale.id}`);
    await wait('.visual-caption');
    assert.equal(await page.$('.detail-gallery'), null);
    await shot('EMPTY');
    console.log(
      'WeChat gallery component fixture passed: 2 real backend PNGs, native next/previous and counter, missing and empty fallback. Catalog wx.request mocked; legal-domain download and real device remain unverified.',
    );
  } finally {
    if (mini) {
      if (mocked) await mini.restoreWxMethod('request');
      await mini.disconnect();
    }
    if (product && profile) {
      let current = await call(`/admin/products/${product.id}`);
      const gallery = await call(`/admin/products/${product.id}/images`);
      if (gallery.images.length)
        current = (
          await call(`/admin/products/${product.id}/set-images`, {
            version: current.version,
            imageIds: [],
          })
        ).product;
      if (current.status === 'PUBLISHED')
        await call(`/admin/products/${product.id}/unpublish`, { version: current.version });
    }
    if (profile) await call('/staff/auth/logout', {});
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
