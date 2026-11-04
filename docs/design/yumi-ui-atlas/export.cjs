const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const localPlaywright = path.resolve(__dirname, '../../../.local/tools/node_modules/playwright');
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH ||
  (fs.existsSync(localPlaywright) ? localPlaywright : 'playwright'));
const entry = pathToFileURL(path.join(__dirname, 'index.html')).href;
global.window = {};
require('./screens.js');
const screens = window.yumiGroups.flatMap(([group, , , items]) =>
  items.map(([id, title]) => ({
    key: group + ':' + id,
    group, id, title,
    desktop: ['express', 'admin', 'warehouse'].includes(group) || id.startsWith('admin-'),
  })),
);
const keys = new Set(screens.map(item => item.key));
assert.equal(keys.size, screens.length, 'Screen IDs must be unique');

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.YUMI_CHROME_PATH || undefined,
    headless: true,
  });
  try {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    for (const page of [desktop, mobile]) {
      page.on('pageerror', error => errors.push(error.message));
      page.on('requestfailed', request => errors.push(request.url()));
    }
    async function exportScreens(page, items) {
      for (const { key, group, id, title } of items) {
        await page.goto(entry + '?screen=' + key);
        assert.equal(await page.title(), title + ' · 玉米百货', key);
        const issues = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          targets: Array.from(document.querySelectorAll('a[href^="?screen="]'),
            element => new URL(element.href).searchParams.get('screen')),
        }));
        assert.equal(issues.overflow, false, key + ' has horizontal overflow');
        for (const target of issues.targets) assert(keys.has(target), key + ' links to ' + target);
        const folder = path.join(__dirname, 'png', group);
        fs.mkdirSync(folder, { recursive: true });
        await page.screenshot({ path: path.join(folder, id + '.png'), fullPage: true });
      }
    }
    await Promise.all([
      exportScreens(desktop, screens.filter(item => item.desktop)),
      exportScreens(mobile, screens.filter(item => !item.desktop)),
    ]);
    async function walk(page, initial, steps) {
      await page.goto(entry + '?screen=' + initial);
      for (const [name, expected] of steps) {
        await page.getByRole('link', { name, exact: true }).first().click();
        assert.equal(new URL(page.url()).searchParams.get('screen'), expected);
      }
    }
    await walk(mobile, 'points:store', [
      ['纯棉方巾 燕麦色 · 单件 480 积分 ↗','points:reward'],
      ['立即兑换','points:confirm'], ['确认兑换 · 480 积分','points:placed'],
      ['查看兑换订单','points:pending'], ['取消兑换','points:cancel'], ['确认取消','points:canceled'],
    ]);
    await walk(desktop, 'express:dispatch', [
      ['打印配货单','express:print'], ['返回发货工作台','express:dispatch'],
      ['确认发货','express:ship'], ['确认发货','express:ship-result'],
    ]);
    await walk(desktop, 'express:shipped', [['更正运单','express:tracking-edit']]);
    await desktop.goto(entry + '?screen=express:print');
    await desktop.evaluate(() => { window.print = () => { document.body.dataset.print = 'sample'; }; });
    await desktop.getByRole('button', { name: '打印样例' }).click();
    assert.equal(await desktop.locator('body').getAttribute('data-print'), 'sample');
    await desktop.emulateMedia({ media: 'print' });
    assert.equal(await desktop.locator('.paper').isVisible(), true);
    assert.equal(await desktop.locator('.sidebar').isVisible(), false);
    await desktop.emulateMedia({ media: 'screen' });
    await walk(mobile, 'points:shipped', [
      ['反馈问题','points:feedback'], ['提交反馈','points:feedback-log'], ['补充说明','points:feedback'],
    ]);
    await walk(mobile, 'rider:tasks', [
      ['社区仓交接区','rider:handoff'], ['确认接货','rider:start'],
      ['开始配送','rider:journey'], ['上报异常','rider:exception'], ['提交异常','rider:blocked'],
    ]);
    await mobile.goto(entry + '?screen=picker:pick');
    assert.equal(await mobile.getByRole('link', { name: '完成核对' }).count(), 0);
    for (const box of await mobile.getByRole('checkbox').all()) await box.check();
    assert.equal(await mobile.locator('#pick-label').textContent(), '3 / 3 件');
    await mobile.getByRole('link', { name: '完成核对' }).click();
    assert.equal(new URL(mobile.url()).searchParams.get('screen'), 'picker:pack');
    for (const page of [desktop, mobile]) {
      await page.goto(entry);
      assert.equal(await page.locator('.atlas-tile').count(), screens.length);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const images = await page.locator('.atlas-tile img').evaluateAll(elements => elements.map(image => image.src));
      for (const url of images) assert(fs.existsSync(require('node:url').fileURLToPath(url)), url);
    }
    await desktop.screenshot({ path: path.join(__dirname, 'cover.png') });
    await desktop.evaluate(() => {
      const slides = [
        ['积分商城', '首发 · 消费者', 'points/store'],
        ['确认兑换', '首发 · 消费者', 'points/confirm'],
        ['逐项核对', '后续 · 仓库', 'picker/pick'],
        ['配送详情', '后续 · 骑手', 'rider/journey'],
      ];
      document.body.innerHTML = `<section style="max-width:1440px;margin:auto;padding:26px 44px 36px;background:#eceee1"><div style="font-size:13px;letter-spacing:.18em;color:#4b5544">YUMI DAILY / 2026.11</div><h1 style="font-size:38px;margin:6px 0 18px">玉米百货 · 移动端选页</h1><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:26px">${slides.map(([title,role,file]) => `<div><div style="font-weight:700;font-size:16px;margin-bottom:8px">${title} <small style="font-weight:400;margin-left:4px">${role}</small></div><img src="png/${file}.png" alt="${title}" style="width:100%;display:block;border-radius:17px;box-shadow:0 6px 25px #27351d22"></div>`).join('')}</div></section>`;
    });
    await desktop.locator('img').evaluateAll(async images => Promise.all(images.map(image => image.decode())));
    await desktop.locator('body > section').screenshot({ path: path.join(__dirname, 'mobile-preview.png') });
    assert.deepEqual(errors, []);
    console.log('Exported and validated', screens.length, 'screens across', window.yumiGroups.length, 'groups.');
    console.log('Checked all internal links, desktop/mobile atlas, and six preview flows.');
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
