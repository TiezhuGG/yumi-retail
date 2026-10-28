// Opt-in local development writes: creates a location, moves one synthetic unit, saves a check.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const { randomUUID, randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const url = new URL(process.env.DATABASE_URL || '');
if (
  process.env.YUMI_LIVE_UI !== '1' ||
  process.env.NODE_ENV === 'production' ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/yumi_dev'
)
  throw Error('Requires YUMI_LIVE_UI=1 and local yumi_dev');
const secrets = [process.env.LOCAL_WAREHOUSE_PASSWORD, url.toString()];
(async () => {
  const { createDatabase, hashPassword } = await import('../../packages/database/dist/index.js');
  const db = createDatabase(url.toString());
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUMI_CHROMIUM_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  });
  let pickerId;
  const w = '00000000-0000-4000-8000-000000000002';
  const base = 'http://127.0.0.1:5174',
    root = `/api/v1/warehouse/warehouses/${w}`;
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    async function login(p, name, password) {
      await p.goto(base);
      await p.getByLabel('员工账号').fill(name);
      await p.getByLabel('登录密码').fill(password);
      await p.getByRole('button', { name: '登录工作空间 →' }).click();
      await p.getByRole('button', { name: '库位与核对', exact: true }).waitFor();
    }
    await login(page, process.env.LOCAL_WAREHOUSE_LOGIN, process.env.LOCAL_WAREHOUSE_PASSWORD);
    const read = async (suffix) => {
      const r = await page.request.get(base + root + suffix);
      assert.equal(r.status(), 200);
      return (await r.json()).data;
    };
    const before = (await read('/positions?limit=50')).items.find(
      (p) => p.reserved === 0 && p.onHand - p.blocked > 0,
    );
    assert.ok(before, 'Seed synthetic catalog first');
    const summaryBefore = (await read(`/stock?limit=1&skuId=${before.skuId}`)).items[0];
    const marker = `UI库位-${Date.now()}`,
      code = `UI-${Date.now().toString(36).toUpperCase()}`;
    await page.getByRole('button', { name: '库位与核对', exact: true }).click();
    await page.getByRole('button', { name: '存储库位', exact: true }).click();
    await page.getByRole('button', { name: '新增库位', exact: false }).click();
    await page.getByLabel('库位编码', { exact: true }).fill(code);
    await page.getByLabel('库位名称', { exact: true }).fill(marker);
    await page.getByRole('button', { name: '保存库位', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const target = (await read('/locations?limit=50')).items.find((l) => l.code === code);
    assert.ok(target);
    await page.getByRole('button', { name: '移位记录', exact: true }).click();
    await page.getByRole('button', { name: '新建移位', exact: false }).click();
    await page.getByLabel('源库存位置').selectOption(before.id);
    await page.getByLabel('目标库位').selectOption(target.id);
    await page.getByLabel('移位数量（件）').fill('1');
    await page.getByLabel('移位原因').fill(marker);
    await page.getByRole('button', { name: '确认同仓移位', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const after = (await read(`/positions?limit=50&skuId=${before.skuId}`)).items;
    const sourceAfter = after.find((p) => p.id === before.id),
      targetAfter = after.find((p) => p.locationId === target.id && p.lotId === before.lotId);
    const summaryAfter = (await read(`/stock?limit=1&skuId=${before.skuId}`)).items[0];
    assert.equal(sourceAfter.onHand, before.onHand - 1);
    assert.equal(sourceAfter.blocked, before.blocked);
    assert.equal(targetAfter.onHand, 1);
    for (const k of ['onHand', 'reserved', 'blocked'])
      assert.equal(summaryAfter[k], summaryBefore[k]);
    const entries = (await read(`/positions/${before.id}/ledger?limit=50`)).items;
    assert.ok(
      entries.some(
        (e) => e.actionKey.startsWith('TRANSFER:') && e.reason === marker && e.deltaOnHand === -1,
      ),
    );
    await page
      .locator('article')
      .filter({ hasText: marker })
      .getByRole('button', { name: '查看移位详情' })
      .click();
    await page.screenshot({
      path: path.resolve('docs/verification/UI-LIVE-LOCATIONS-TRANSFER-2026-10-28.png'),
      fullPage: false,
    });
    await page.getByRole('button', { name: '关闭表单' }).click();
    await page.getByRole('button', { name: '核对报告', exact: true }).click();
    await page.getByRole('button', { name: '执行库存核对', exact: true }).click();
    await page.getByLabel('核对商品规格').selectOption(before.skuId);
    await page.getByRole('button', { name: '确认执行账本核对' }).click();
    await page
      .getByRole('dialog')
      .getByRole('heading', { name: '账本一致', exact: true })
      .waitFor();
    await page.screenshot({
      path: path.resolve('docs/verification/UI-LIVE-LOCATIONS-CHECK-2026-10-28.png'),
      fullPage: false,
    });
    assert.equal(
      (await read(`/stock?limit=1&skuId=${before.skuId}`)).items[0].inventoryHold,
      false,
    );
    // A temporary local-only picker proves the real read-only UI and server rejection. Retain disabled audit identity.
    const password = randomBytes(24).toString('hex');
    secrets.push(password);
    pickerId = randomUUID();
    const loginName = `ui.picker.${randomBytes(5).toString('hex')}`;
    await db.staff.create({
      data: {
        id: pickerId,
        loginName,
        displayName: '本地UI验收拣货员',
        passwordHash: await hashPassword(password),
        roles: { create: { roleCode: 'PICKER' } },
        warehouses: { create: { warehouseId: w } },
      },
    });
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const picker = await ctx.newPage();
    await login(picker, loginName, password);
    assert.equal(await picker.getByRole('button', { name: '商品管理', exact: true }).count(), 0);
    await picker.getByRole('button', { name: '库位与核对', exact: true }).click();
    await picker.getByRole('button', { name: '查看位置与流水' }).first().click();
    await picker.getByRole('heading', { name: '位置流水', exact: true }).waitFor();
    assert.equal(await picker.getByRole('button', { name: '从此位置移位' }).count(), 0);
    await picker.screenshot({
      path: path.resolve('docs/verification/UI-LIVE-LOCATIONS-PICKER-2026-10-28.png'),
      fullPage: false,
    });
    const me = (await (await picker.request.get(base + '/api/v1/staff/me')).json()).data;
    const denied = await picker.request.post(base + root + '/locations', {
      headers: { Origin: base, 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': randomUUID() },
      data: { code: `${code}-DENY`, name: '不应创建' },
    });
    assert.equal(denied.status(), 403);
    const result = {
      synthetic: true,
      source: { before: before.onHand, after: sourceAfter.onHand, blocked: sourceAfter.blocked },
      target: targetAfter.onHand,
      warehouse: { before: summaryBefore.onHand, after: summaryAfter.onHand },
      check: 'CONSISTENT',
      pickerWrite: 403,
    };
    fs.writeFileSync('.local/locations-live-results.json', JSON.stringify(result, null, 2));
    console.log('Live ops UI/API/PostgreSQL passed:', JSON.stringify(result));
  } finally {
    if (pickerId) {
      await db.staff.update({
        where: { id: pickerId },
        data: { enabled: false, authVersion: { increment: 1 } },
      });
      await db.staffSession.updateMany({
        where: { staffId: pickerId },
        data: { revokedAt: new Date() },
      });
    }
    await browser.close();
    await db.$disconnect();
  }
})().catch((e) => {
  let message = String(e.message);
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join('[redacted]');
  console.error('Live locations UI failed:', message);
  process.exit(1);
});
