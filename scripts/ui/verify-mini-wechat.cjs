// WeChat simulator only. Real public API reads first; marked synthetic wx.request fixtures later.
// Requires an already authorized project automation session and compiled current source.
const automator = require(process.env.YUMI_MINI_AUTOMATOR_PATH || 'miniprogram-automator');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const endpoint = process.env.YUMI_MINI_WS || 'ws://127.0.0.1:9420';
  assert.equal(new URL(endpoint).hostname, '127.0.0.1', 'Only local automation is allowed');
  const mini = await automator.connect({ wsEndpoint: endpoint });
  let mocked = false;
  try {
    let page = await mini.reLaunch('/pages/index/index');
    assert(page);
    const waitSelector = async (selector) => {
      for (let i = 0; i < 40; i++) {
        const found = await page.$(selector);
        if (found) return found;
        await page.waitFor(200);
      }
      throw Error(`Expected selector: ${selector}`);
    };
    const revealResults = async () => {
      const heading = await page.$('.store-section-title');
      const offset = await heading.offset();
      await mini.pageScrollTo(Math.max(0, offset.top - 16));
    };
    await waitSelector('.store-page');
    const body = await page.$('.store-page');
    assert(
      (await body.text()).includes('完整商品分类待开放'),
      'Simulator runs old output; click Compile first',
    );
    const shot = (label) =>
      mini.screenshot({
        path: path.resolve('docs/verification', `WECHAT-BROWSE-${label}-2026-10-29.png`),
      });
    const waitCards = async (count) => {
      for (let i = 0; i < 40; i++) {
        if ((await page.$$('.product-card')).length === count) return;
        await page.waitFor(200);
      }
      throw Error(
        `Expected ${count} cards; current feedback: ${await (await page.$('.store-feedback'))?.text()}`,
      );
    };
    const real = await (await fetch('http://127.0.0.1:3000/api/v1/products?limit=20')).json();
    assert(real.data.items.length);
    await waitCards(real.data.items.length);
    for (const row of real.data.items) assert((await body.text()).includes(row.name));
    await shot('HOME');
    await revealResults();
    await shot('PRODUCTS');
    console.log('Real WeChat home and product data matched API');
    const waitRoute = async (expected) => {
      for (let i = 0; i < 40; i++) {
        const current = await mini.currentPage();
        if (current?.path === expected) return current;
        await page.waitFor(200);
      }
      throw Error(`Navigation did not reach ${expected}`);
    };
    const cards = await page.$$('.product-card');
    await cards[0].tap();
    page = await waitRoute('pages/product/index');
    await waitSelector('.detail-name');
    assert.equal(await (await page.$('.detail-name')).text(), real.data.items[0].name);
    assert.equal(String(await (await page.$('.detail-buy')).property('disabled')), 'true');
    assert(
      (await (await page.$('.detail-price')).text()).includes(
        (real.data.items[0].priceCents / 100).toFixed(2),
      ),
    );
    await shot('DETAIL');
    await (await page.$('.back-home')).tap();
    page = await waitRoute('pages/index/index');
    await waitSelector('.product-card');
    const search = async (keyword) => {
      await (await page.$('.store-search input')).input(keyword);
      await (await page.$('.store-search button')).tap();
    };
    await search('UI不存在商品_9d38c1');
    await waitSelector('.empty-symbol');
    await shot('EMPTY');
    await search(real.data.items[0].name);
    await waitSelector('.product-card');
    await shot('SEARCH');
    await mini.mockWxMethod('request', {
      statusCode: 503,
      data: { error: { message: 'UI合成网络失败' } },
    });
    mocked = true;
    await search(real.data.items[0].name);
    await waitSelector('.store-feedback');
    assert((await (await page.$('.store-feedback')).text()).includes('UI合成网络失败'));
    await shot('SYNTHETIC-ERROR');
    await (await page.$('.store-search input')).input('输入框已编辑但未搜索');
    await mini.restoreWxMethod('request');
    mocked = false;
    await (await page.$('.store-feedback button')).tap();
    await waitSelector('.product-card');
    assert((await (await page.$('.section-name')).text()).includes(real.data.items[0].name));
    await mini.mockWxMethod('request', {
      statusCode: 200,
      data: {
        data: {
          items: real.data.items.slice(0, 1).map((r) => ({ ...r, name: 'UI合成分页商品一' })),
          nextCursor: 'fixture-page-2',
          hasMore: true,
        },
      },
    });
    mocked = true;
    page = await mini.reLaunch('/pages/index/index');
    await waitCards(1);
    await mini.mockWxMethod('request', {
      statusCode: 503,
      data: { error: { message: 'UI合成下一页失败' } },
    });
    await (await page.$('.load-more')).tap();
    await waitSelector('.store-feedback');
    assert.equal((await page.$$('.product-card')).length, 1);
    await revealResults();
    await shot('SYNTHETIC-PAGING-ERROR');
    await mini.mockWxMethod('request', {
      statusCode: 200,
      data: {
        data: {
          items: [{ ...real.data.items[0], id: 'ui-next', name: 'UI合成分页商品二' }],
          nextCursor: null,
          hasMore: false,
        },
      },
    });
    await (await page.$('.store-feedback button')).tap();
    await waitCards(2);
    await mini.pageScrollTo(420);
    await shot('SYNTHETIC-PAGING-RECOVERED');
    await mini.restoreWxMethod('request');
    mocked = false;
    page = await mini.reLaunch('/pages/index/index');
    await waitCards(real.data.items.length);
    console.log(
      'WeChat simulator passed: real API list/detail/search/empty and disabled order entry; synthetic request failure/retry with edited input; failed append retains goods and retries next page. wx.request restored. Real-device/payment acceptance remains pending.',
    );
  } finally {
    if (mocked) await mini.restoreWxMethod('request');
    await mini.disconnect();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
