// Opt-in local synthetic writes: creates, reviews and posts one two-line receipt.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const dbUrl = new URL(process.env.DATABASE_URL || '');
if (
  process.env.YUMI_LIVE_UI !== '1' ||
  process.env.NODE_ENV === 'production' ||
  !['127.0.0.1', 'localhost'].includes(dbUrl.hostname) ||
  dbUrl.pathname !== '/yumi_dev' ||
  dbUrl.searchParams.has('schema')
)
  throw Error('Requires YUMI_LIVE_UI=1 and local yumi_dev/public');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUMI_CHROMIUM_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  });
  try {
    const base = 'http://127.0.0.1:5174',
      warehouseId = '00000000-0000-4000-8000-000000000002',
      root = `/api/v1/warehouse/warehouses/${warehouseId}`;
    const page = await browser.newPage({
      viewport: { width: 375, height: 812 },
      timezoneId: 'Asia/Shanghai',
    });
    await page.goto(base);
    await page.getByLabel('员工账号').fill(process.env.LOCAL_WAREHOUSE_LOGIN);
    await page.getByLabel('登录密码').fill(process.env.LOCAL_WAREHOUSE_PASSWORD);
    await page.getByRole('button', { name: '登录工作空间 →' }).click();
    await page.getByRole('button', { name: '收货入库', exact: true }).first().waitFor();
    async function read(suffix, absolute = false) {
      const response = await page.request.get(base + (absolute ? '/api/v1' : root) + suffix);
      assert.equal(response.status(), 200);
      return (await response.json()).data;
    }
    const products = (await read('/admin/products?limit=50', true)).items;
    const skus = products
      .flatMap((p) =>
        p.skus.filter((s) => s.enabled && !s.expiryManaged).map((s) => ({ ...s, name: p.name })),
      )
      .slice(0, 2);
    assert.equal(skus.length, 2, 'Seed two non-expiry synthetic SKUs first');
    const before = await Promise.all(
      skus.map(
        async (s) =>
          (await read(`/stock?limit=1&skuId=${s.id}`)).items[0] ?? {
            onHand: 0,
            reserved: 0,
            blocked: 0,
          },
      ),
    );
    const marker = `UI收货实链-${Date.now()}`;
    await page.getByRole('button', { name: '收货入库', exact: true }).first().click();
    await page.getByRole('button', { name: '新建收货单', exact: false }).click();
    await page.getByLabel('来源单号 / 说明').fill(marker);
    for (let i = 0; i < 2; i++) {
      if (i) await page.getByRole('button', { name: '添加收货明细', exact: false }).click();
      const region = page.getByRole('region', { name: `收货明细${i + 1}`, exact: true });
      await region.getByLabel('收货商品').selectOption(skus[i].id);
      await region.getByLabel('供应批次').fill(`${marker}-${i + 1}`);
      await region.getByLabel('收货数量（件）').fill(String(i + 2));
      await region.getByLabel('单件成本（元）').fill(i === 0 ? '0.29' : '7.19');
    }
    await page.screenshot({
      path: path.resolve('docs/verification/UI-LIVE-RECEIPTS-CREATE-2026-10-29.png'),
    });
    const saving = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/receipts'),
    );
    await page.getByRole('button', { name: '保存收货草稿' }).click();
    const savedResponse = await saving;
    assert.equal(savedResponse.status(), 200);
    const saved = (await savedResponse.json()).data;
    await page.getByRole('dialog').getByRole('heading', { name: marker, exact: true }).waitFor();
    const detail = await read(`/receipts/${saved.id}`);
    assert.equal(detail.status, 'DRAFT');
    assert.equal(
      detail.lines.reduce((n, l) => n + l.quantity * l.unitCostCents, 0),
      2215,
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await read(`/stock?limit=1&skuId=${skus[i].id}`)).items[0]?.onHand ?? 0,
        before[i].onHand,
      );
    assert.equal(await page.getByRole('button', { name: '确认审核收货单' }).isDisabled(), true);
    await page.getByLabel('已逐行核对商品、批次、数量、成本和效期').check();
    await page.getByRole('button', { name: '确认审核收货单' }).click();
    await page.getByRole('button', { name: '确认入库并记录库存' }).waitFor();
    assert.equal((await read(`/receipts/${saved.id}`)).status, 'APPROVED');
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await read(`/stock?limit=1&skuId=${skus[i].id}`)).items[0]?.onHand ?? 0,
        before[i].onHand,
      );
    await page.screenshot({
      path: path.resolve('docs/verification/UI-LIVE-RECEIPTS-APPROVED-2026-10-29.png'),
    });
    await page.getByLabel('已核验实收货品与上述批次、数量、成本和效期').check();
    await page.getByRole('button', { name: '确认入库并记录库存' }).click();
    await page.getByRole('dialog').getByText('此单已入库', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认入库并记录库存' }).count(), 0);
    const posted = await read(`/receipts/${saved.id}`);
    assert.equal(posted.status, 'POSTED');
    const after = [];
    for (let i = 0; i < 2; i++) {
      const balance = (await read(`/stock?limit=1&skuId=${skus[i].id}`)).items[0];
      assert.equal(balance.onHand, before[i].onHand + i + 2);
      assert.equal(balance.reserved, before[i].reserved);
      assert.equal(balance.blocked, before[i].blocked);
      const p = (await read(`/positions?limit=50&skuId=${skus[i].id}`)).items.find(
        (p) => p.batchNo === `${marker}-${i + 1}`,
      );
      assert.equal(p.locationCode, 'DEFAULT');
      assert.equal(p.onHand, i + 2);
      const ledger = (await read(`/positions/${p.id}/ledger?limit=50`)).items;
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].deltaOnHand, i + 2);
      assert.ok(ledger[0].actionKey.includes(saved.id));
      after.push({
        before: before[i].onHand,
        after: balance.onHand,
        received: i + 2,
        unitCostCents: i === 0 ? 29 : 719,
        blocked: balance.blocked,
      });
    }
    await page.getByRole('button', { name: '刷新当前收货单' }).click();
    await page.getByRole('dialog').getByText('此单已入库', { exact: false }).waitFor();
    await page.screenshot({
      path: path.resolve('docs/verification/UI-LIVE-RECEIPTS-POSTED-MOBILE-2026-10-29.png'),
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: path.resolve('docs/verification/UI-LIVE-RECEIPTS-POSTED-DESKTOP-2026-10-29.png'),
    });
    const result = {
      synthetic: true,
      receiptId: saved.id,
      state: posted.status,
      lines: after,
      totalQuantity: 5,
      totalCostCents: 2215,
      draftAndReviewDidNotChangeStock: true,
      defaultPositionsAndLedgers: 2,
    };
    fs.writeFileSync('.local/receipts-live-results.json', JSON.stringify(result, null, 2));
    console.log('Live receipt ops/API/PostgreSQL passed:', JSON.stringify(result));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  let message = String(e.message);
  for (const [key, value] of Object.entries(process.env))
    if (/PASSWORD|DATABASE_URL/.test(key) && value)
      message = message.split(value).join('[redacted]');
  console.error('Live receipt UI failed:', message);
  process.exit(1);
});
