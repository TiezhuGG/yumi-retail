// Native component rendering from real isolated-API snapshots; request-domain layer is bypassed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const automator = require(process.env.YUMI_MINI_AUTOMATOR_PATH || 'miniprogram-automator');
const fixture = JSON.parse(fs.readFileSync('.local/area-mini-fixture.json', 'utf8'));
const mode = process.env.YUMI_RANGE_STATE || 'ready';
(async () => {
  const mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  try {
    await mini.mockWxMethod(
      'request',
      function (options, values) {
        if (values.mode === 'error')
          return { statusCode: 503, data: { error: { message: 'Synthetic failure' } } };
        if (options.url.endsWith('/service-areas'))
          return values.mode === 'empty'
            ? { statusCode: 200, data: { data: { items: [] } } }
            : { statusCode: 200, data: values.fixture.areas };
        return { statusCode: 200, data: values.fixture.buildings };
      },
      { fixture, mode },
    );
    const page = await mini.reLaunch('/pages/service-area/index');
    await page.waitFor(1200);
    const root = await page.$('.range-page'),
      text = await root.text();
    if (mode === 'ready') {
      assert.ok(text.includes('合成验收小区'));
      assert.equal((await page.$$('.range-building')).length, 3);
      const search = await page.$('.range-search');
      await search.input('东区');
      await page.waitFor(200);
      assert.equal((await page.$$('.range-building')).length, 1);
      await search.input('找不到');
      await page.waitFor(200);
      assert.ok((await root.text()).includes('没有匹配楼栋'));
      await search.input('');
      await page.waitFor(200);
    } else if (mode === 'empty') assert.ok(text.includes('配送范围暂未开放'));
    else {
      assert.ok(text.includes('暂时无法读取配送范围'));
      await (await page.$('.account-primary')).trigger('tap');
      await page.waitFor(300);
      assert.ok((await root.text()).includes('暂时无法读取配送范围'));
    }
    console.log('Native range component state verified:', mode);
  } finally {
    await mini.restoreWxMethod('request');
    await mini.disconnect();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
