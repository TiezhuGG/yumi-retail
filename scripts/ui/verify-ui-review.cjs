// Read-only local UI review. Login/logout change sessions; no business write is sent.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const db = new URL(process.env.DATABASE_URL || '');
if (
  process.env.NODE_ENV === 'production' ||
  !['127.0.0.1', 'localhost'].includes(db.hostname) ||
  db.pathname !== '/yumi_dev'
)
  throw Error('Local yumi_dev required');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const results = [];
    for (const role of ['ADMIN', 'WAREHOUSE', 'RIDER']) {
      const mobile = role !== 'ADMIN';
      const context = await browser.newContext({
        viewport: { width: mobile ? 375 : 1440, height: mobile ? 812 : 1000 },
        timezoneId: 'Asia/Shanghai',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const failures = [],
        errors = [];
      const pending = new Set();
      let lastApiChange = Date.now();
      page.on('request', (request) => {
        if (request.url().includes('/api/v1/')) {
          pending.add(request);
          lastApiChange = Date.now();
        }
      });
      const finished = (request) => {
        if (pending.delete(request)) lastApiChange = Date.now();
      };
      page.on('requestfinished', finished);
      page.on('requestfailed', finished);
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('response', (r) => {
        if (r.url().includes('/api/v1/') && !r.ok() && !r.url().endsWith('/staff/me'))
          failures.push(r.status());
      });
      await page.goto(mobile ? 'http://127.0.0.1:5174/' : 'http://127.0.0.1:5173/');
      await page.getByRole('heading', { name: '登录工作空间', exact: true }).waitFor();
      if (role !== 'RIDER')
        await page.screenshot({
          path: path.resolve(`docs/verification/UI-REVIEW-${role}-LOGIN-2026-10-30.png`),
          fullPage: true,
          animations: 'disabled',
        });
      await page.getByLabel('员工账号').fill(process.env[`LOCAL_${role}_LOGIN`]);
      await page.getByLabel('登录密码').fill(process.env[`LOCAL_${role}_PASSWORD`]);
      await page.getByRole('button', { name: '登录工作空间 →' }).click();
      await page.locator('.workspace').waitFor();
      const nav = page.getByRole('navigation', { name: '主导航' });
      const views = role === 'RIDER' ? [] : await nav.getByRole('button').allTextContents();
      for (let i = 0; i < views.length; i++) {
        const button = nav.getByRole('button').nth(i);
        await button.click();
        await page
          .locator('.page-heading h1')
          .filter({ hasText: views[i].slice(1) })
          .waitFor();
        for (let attempt = 0; ; attempt++) {
          const loading = await page
            .getByRole('status')
            .filter({ hasText: /正在加载|加载中/ })
            .count();
          if (!loading && pending.size === 0 && Date.now() - lastApiChange >= 600) break;
          assert(attempt < 100, `Page did not finish loading: ${role}/${views[i]}`);
          await page.waitForTimeout(100);
        }
        assert.equal(await page.getByRole('alert').count(), 0, `${role}/${views[i]} alerts`);
        assert(
          await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1,
          ),
        );
        await page.screenshot({
          path: path.resolve(`docs/verification/UI-REVIEW-${role}-PAGE-${i + 1}-2026-10-30.png`),
          fullPage: true,
          animations: 'disabled',
        });
      }
      if (role === 'RIDER') {
        assert.equal(await nav.getByRole('button').count(), 0);
        await page
          .getByText('当前账号暂未开放仓库管理。配送任务开放后会在此显示。', { exact: true })
          .waitFor();
        await page.screenshot({
          path: path.resolve('docs/verification/UI-REVIEW-RIDER-2026-10-30.png'),
          fullPage: true,
          animations: 'disabled',
        });
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(failures, []);
      results.push({ role, views, errors: 0, failedResponses: 0 });
      await page.getByRole('button', { name: '退出登录', exact: true }).click();
      await page.getByRole('heading', { name: '登录工作空间', exact: true }).waitFor();
      await context.close();
    }
    fs.writeFileSync(
      'docs/verification/UI-REVIEW-RESULTS-2026-10-30.json',
      JSON.stringify(
        {
          date: '2026-10-30',
          source: 'local real API; synthetic development data',
          businessWrites: false,
          results,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'UI review passed: real local admin/warehouse navigation and rider placeholder, login/logout, no page errors/API failures or document overflow; screenshots saved. No business writes.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
