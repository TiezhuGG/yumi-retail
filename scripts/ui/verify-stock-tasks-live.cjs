// Opt-in writes to local seeded yumi_dev only. Never use against a production database.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const base = 'http://127.0.0.1:5173';
const db = new URL(process.env.DATABASE_URL || '');
if (
  process.env.YUMI_LIVE_UI !== '1' ||
  process.env.NODE_ENV === 'production' ||
  !['127.0.0.1', 'localhost'].includes(db.hostname) ||
  db.pathname !== '/yumi_dev'
)
  throw Error('Requires YUMI_LIVE_UI=1 and local yumi_dev');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUMI_CHROMIUM_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  });
  const pages = [];
  for (const role of ['WAREHOUSE', 'ADMIN']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto(base);
    await page.getByLabel('员工账号').fill(process.env[`LOCAL_${role}_LOGIN`]);
    await page.getByLabel('登录密码').fill(process.env[`LOCAL_${role}_PASSWORD`]);
    await page.getByRole('button', { name: '登录工作空间 →' }).click();
    await page.getByRole('button', { name: '隔离与报损', exact: true }).waitFor();
    pages.push(page);
  }
  const [author, reviewer] = pages;
  const root = '/api/v1/warehouse/warehouses/00000000-0000-4000-8000-000000000002';
  const read = async (suffix) => {
    const r = await author.request.get(base + root + suffix);
    assert.equal(r.status(), 200);
    return (await r.json()).data;
  };
  const initial = (await read('/positions?limit=50')).items.find(
    (p) => p.onHand - p.reserved - p.blocked >= 3,
  );
  assert.ok(initial, 'Seed catalog with at least 3 free units first');
  const marker = `UI实链验收-${Date.now()}`;
  await author.getByRole('button', { name: '隔离与报损', exact: true }).click();
  await author.getByRole('button', { name: '新建隔离', exact: false }).click();
  await author.getByLabel('问题货品位置').selectOption(initial.id);
  await author.getByLabel('隔离数量', { exact: true }).fill('2');
  await author.getByLabel('问题说明').fill(marker);
  await author.getByRole('button', { name: '确认立即隔离' }).click();
  await author.getByLabel('处置数量').waitFor();
  await author.getByLabel('处置数量').fill('1');
  await author.getByLabel('申请原因').fill(marker);
  await author.getByRole('button', { name: '提交处置申请' }).click();
  await author.getByRole('dialog').getByText('请让另一位管理员或仓管登录后独立审批。').waitFor();
  assert.equal(await author.getByRole('button', { name: '确认独立审批', exact: true }).count(), 0);
  await reviewer.getByRole('button', { name: '隔离与报损', exact: true }).click();
  await reviewer.getByRole('button', { name: '处置申请', exact: true }).click();
  await reviewer
    .locator('article')
    .filter({ hasText: marker })
    .getByRole('button', { name: '查看处置单', exact: true })
    .click();
  await reviewer.getByLabel('审批说明', { exact: true }).fill('本地合成资料独立核验');
  await reviewer.getByRole('button', { name: '确认独立审批', exact: true }).click();
  await reviewer.getByLabel('已核验本次报损实物并完成处理').check();
  await reviewer
    .getByLabel('实物核验说明', { exact: false })
    .fill('仅为合成库存的UI验收，无真实货品处置');
  await reviewer.getByRole('button', { name: '确认报损过账' }).click();
  await reviewer.getByRole('dialog').getByText('已过账', { exact: false }).first().waitFor();
  const afterDamage = (await read('/positions?limit=50')).items.find((p) => p.id === initial.id);
  assert.equal(afterDamage.onHand, initial.onHand - 1);
  assert.equal(afterDamage.blocked, initial.blocked + 1);
  await reviewer.screenshot({
    path: path.resolve('docs/verification/UI-LIVE-DISPOSITION-POSTED-2026-10-28.png'),
    fullPage: true,
  });
  await author.getByRole('button', { name: '关闭表单' }).click();
  await author.getByRole('button', { name: '收货纠错', exact: true }).click();
  await author.getByRole('button', { name: '新建纠错申请', exact: false }).click();
  await author.getByLabel('纠错库存位置').selectOption(initial.id);
  await author.getByRole('button', { name: '核对原收货及额度' }).click();
  await author.getByLabel('误录纠错数量').fill('1');
  await author.getByLabel('误录原因').fill(marker);
  await author.getByRole('button', { name: '提交逆向申请' }).click();
  await author.getByRole('dialog').getByText('请另一位管理员或仓管独立核验并审批。').waitFor();
  await reviewer.getByRole('button', { name: '关闭表单' }).click();
  await reviewer.getByRole('button', { name: '收货纠错', exact: true }).click();
  await reviewer
    .locator('article')
    .filter({ hasText: marker })
    .getByRole('button', { name: '查看逆向单' })
    .click();
  await reviewer.getByLabel('逆向审批说明').fill('独立核对合成原入库单');
  await reviewer.getByRole('button', { name: '确认独立审批逆向单' }).click();
  await reviewer.getByLabel('已核验原收货记录和实物', { exact: false }).check();
  await reviewer.getByLabel('原单及实物核验说明').fill('仅为合成误录验收，无真实货品变动');
  await reviewer.getByRole('button', { name: '确认逆向纠错过账' }).click();
  await reviewer.getByRole('dialog').getByText('已过账', { exact: false }).first().waitFor();
  const afterReversal = (await read('/positions?limit=50')).items.find((p) => p.id === initial.id);
  assert.equal(afterReversal.onHand, initial.onHand - 2);
  assert.equal(afterReversal.blocked, initial.blocked + 1);
  await reviewer.setViewportSize({ width: 375, height: 812 });
  await reviewer.screenshot({
    path: path.resolve('docs/verification/UI-LIVE-REVERSAL-POSTED-2026-10-28.png'),
    fullPage: true,
  });
  const result = {
    fixture: true,
    before: { onHand: initial.onHand, blocked: initial.blocked },
    afterDamage: { onHand: afterDamage.onHand, blocked: afterDamage.blocked },
    afterReversal: { onHand: afterReversal.onHand, blocked: afterReversal.blocked },
  };
  fs.mkdirSync('.local', { recursive: true });
  fs.writeFileSync('.local/ui-live-results.json', JSON.stringify(result, null, 2));
  console.log('Live browser/API/PostgreSQL checks passed:', JSON.stringify(result));
  await browser.close();
})().catch((e) => {
  let message = String(e.message);
  for (const [key, value] of Object.entries(process.env))
    if (/PASSWORD|DATABASE_URL/.test(key) && value)
      message = message.split(value).join('[redacted]');
  console.error('Live UI check failed:', message);
  process.exit(1);
});
