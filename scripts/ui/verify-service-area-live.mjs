/* global document, innerWidth */
// Opt-in: all business writes are confined to a disposable local yumi_test schema.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createApplication } from '../../apps/api/dist/app.js';
import { applicationConfig } from '../../apps/api/dist/config.js';
import { hashPassword } from '../../packages/database/dist/index.js';
const require = createRequire(import.meta.url),
  { Client } = require('pg');
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const url = new URL(process.env.TEST_DATABASE_URL || '');
if (
  process.env.YUMI_LIVE_UI !== '1' ||
  process.env.NODE_ENV === 'production' ||
  url.hostname !== '127.0.0.1' ||
  url.pathname !== '/yumi_test' ||
  url.searchParams.has('schema')
)
  throw Error('Disposable local test schema only');
const schema = 'area_ui_' + randomUUID().replaceAll('-', ''),
  admin = new Client({ connectionString: url.toString() });
let runtime, browser;
const warehouseId = randomUUID(),
  password = randomBytes(20).toString('hex');
try {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  for (const dir of (await readdir('packages/database/prisma/migrations'))
    .filter((n) => /^\d/.test(n))
    .sort())
    await admin.query(
      await readFile(`packages/database/prisma/migrations/${dir}/migration.sql`, 'utf8'),
    );
  url.searchParams.set('schema', schema);
  runtime = await createApplication(url.toString(), {
    config: applicationConfig({ NODE_ENV: 'test', PUBLIC_WAREHOUSE_ID: warehouseId }),
    accessLog: () => {},
  });
  await runtime.app.listen(0, '127.0.0.1');
  const base = await runtime.app.getUrl();
  await runtime.db.warehouse.create({
    data: { id: warehouseId, code: 'AREA-UI', name: '隔离验收仓（非真实范围）' },
  });
  await runtime.db.staff.create({
    data: {
      id: randomUUID(),
      loginName: 'area-ui',
      displayName: '隔离验收运营',
      passwordHash: await hashPassword(password),
      roles: { create: { roleCode: 'OPERATIONS' } },
      warehouses: { create: { warehouseId } },
    },
  });
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let failure = false,
    loseOnce = false,
    lostKey,
    gate;
  await page.route('**/api/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/v1/admin/service-area' && route.request().method() === 'GET') {
      if (failure)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'SYNTHETIC', message: '隔离验收：模拟读取失败' } }),
        });
      if (gate) await gate;
    }
    const response = await route.fetch({
      url: base + pathname + new URL(route.request().url()).search,
    });
    if (pathname === '/api/v1/admin/service-area/buildings' && loseOnce) {
      loseOnce = false;
      assert.equal(response.status(), 200);
      lostKey = route.request().headers()['idempotency-key'];
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'SYNTHETIC', message: 'Committed response lost' } }),
      });
    }
    if (lostKey && pathname === '/api/v1/admin/service-area/buildings') {
      assert.equal(route.request().headers()['idempotency-key'], lostKey);
      lostKey = undefined;
    }
    await route.fulfill({ response });
  });
  await page.goto('http://127.0.0.1:5173');
  await page.getByLabel('员工账号').fill('area-ui');
  await page.getByLabel('登录密码').fill(password);
  await page.getByRole('button', { name: '登录工作空间 →' }).click();
  await page.locator('.workspace').waitFor();
  await page.getByRole('navigation').getByRole('button', { name: '配送范围', exact: true }).click();
  await page.getByText('尚未配置服务小区', { exact: true }).waitFor();
  const shot = async (name) =>
    page.screenshot({
      path: `docs/verification/UI-SERVICE-AREA-${name}-2026-10-31.png`,
      fullPage: true,
    });
  await shot('EMPTY');
  let release;
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '刷新范围', exact: true }).click();
  await page.getByText('正在读取小区与楼栋…').waitFor();
  await shot('LOADING');
  release();
  gate = undefined;
  await page.getByText('尚未配置服务小区', { exact: true }).waitFor();
  failure = true;
  await page.getByRole('button', { name: '刷新范围', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await shot('ERROR');
  failure = false;
  await page.getByRole('button', { name: '重试读取' }).click();
  await page.getByText('尚未配置服务小区', { exact: true }).waitFor();
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: '建立服务小区', exact: true }).click();
  await dialog.getByLabel('小区名称').fill('合成验收小区（非真实范围）');
  await dialog.getByRole('button', { name: '保存配置' }).click();
  await page.getByText('小区已停用', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑小区与启停' }).click();
  await dialog.getByLabel('启用小区').check();
  await dialog.getByRole('button', { name: '保存配置' }).click();
  await page.getByText('小区已启用', { exact: true }).waitFor();
  for (const name of ['1栋', '2栋', '东区A座']) {
    await page.getByRole('button', { name: '新增楼栋', exact: true }).click();
    await dialog.getByLabel('楼栋名称').fill(name);
    await dialog.getByRole('button', { name: '保存配置' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const row = page
      .locator('.service-building-list article')
      .filter({ has: page.getByRole('heading', { name, exact: true }) });
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    await dialog.getByLabel('启用楼栋').check();
    await dialog.getByRole('button', { name: '保存配置' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await row.getByText('当前有效服务楼栋').waitFor();
  }
  await shot('DESKTOP');
  await page.getByRole('button', { name: '新增楼栋', exact: true }).click();
  await dialog.getByLabel('楼栋名称').fill('1栋');
  await dialog.getByRole('button', { name: '保存配置' }).click();
  await dialog.getByRole('alert').filter({ hasText: '当前小区已有同名楼栋' }).waitFor();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  loseOnce = true;
  await page.getByRole('button', { name: '新增楼栋', exact: true }).click();
  await dialog.getByLabel('楼栋名称').fill('待启用验收楼栋');
  await dialog.getByRole('button', { name: '保存配置' }).click();
  await dialog.getByText('保存结果尚未确认，原内容已冻结。请使用原操作重试确认。').waitFor();
  assert.equal(await dialog.getByLabel('楼栋名称').isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
  await shot('UNKNOWN');
  await dialog.getByRole('button', { name: '原操作重试确认' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByLabel('查找楼栋').fill('东区');
  assert.equal(await page.locator('.service-building-list article').count(), 1);
  await page.getByLabel('查找楼栋').fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('MOBILE');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: '新增楼栋', exact: true }).click();
  await shot('MOBILE-FORM');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const areas = await (await fetch(base + '/api/v1/service-areas')).json(),
    buildings = await (
      await fetch(base + `/api/v1/service-areas/${areas.data.items[0].id}/buildings`)
    ).json();
  await writeFile('.local/area-mini-fixture.json', JSON.stringify({ areas, buildings }));
  assert.equal(await runtime.db.serviceBuilding.count(), 4);
  assert.equal(await runtime.db.businessAudit.count(), 9);
  console.log(
    'Real isolated API: create, enable, building edits, duplicate recovery, search, empty/loading/error/retry, desktop/mobile and form, committed response loss and same-key retry verified; 9 audits.',
  );
} finally {
  if (browser) await browser.close();
  if (runtime) await runtime.close();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
