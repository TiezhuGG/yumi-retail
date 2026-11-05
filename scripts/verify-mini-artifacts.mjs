import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
const root = 'apps/consumer-mini/dist';
for (const name of [
  'app.js',
  'app.json',
  'pages/index/index.js',
  'pages/index/index.wxml',
  'pages/product/index.js',
  'pages/product/index.wxml',
  'pages/points-cart/index.js',
  'pages/points-cart/index.wxml',
  'pages/points-checkout/index.js',
  'pages/points-checkout/index.wxml',
  'pages/cart/index.js',
  'pages/cart/index.wxml',
  'pages/account/index.js',
  'pages/account/index.wxml',
  'pages/login/index.js',
  'pages/login/index.wxml',
  'pages/points/index.js',
  'pages/points/index.wxml',
  'pages/rewards/index.js',
  'pages/rewards/index.wxml',
  'pages/reward/index.js',
  'pages/reward/index.wxml',
  'pages/redemption-checkout/index.js',
  'pages/redemption-checkout/index.wxml',
  'pages/redemptions/index.js',
  'pages/redemptions/index.wxml',
  'pages/redemption/index.js',
  'pages/redemption/index.wxml',
  'pages/returns/index.js',
  'pages/returns/index.wxml',
  'pages/return/index.js',
  'pages/return/index.wxml',
  'pages/service-area/index.js',
  'pages/service-area/index.wxml',
  'pages/addresses/index.js',
  'pages/addresses/index.wxml',
  'pages/express-addresses/index.js',
  'pages/express-addresses/index.wxml',
  'pages/checkout/index.js',
  'pages/checkout/index.wxml',
  'pages/orders/index.js',
  'pages/orders/index.wxml',
  'pages/order/index.js',
  'pages/order/index.wxml',
]) {
  assert.ok(existsSync(`${root}/${name}`), `Missing mini-program artifact: ${name}`);
}
const config = JSON.parse(readFileSync(`${root}/app.json`, 'utf8'));
assert.deepEqual(config.pages, [
  'pages/index/index',
  'pages/product/index',
  'pages/cart/index',
  'pages/points-cart/index',
  'pages/points-checkout/index',
  'pages/account/index',
  'pages/login/index',
  'pages/points/index',
  'pages/rewards/index',
  'pages/reward/index',
  'pages/redemption-checkout/index',
  'pages/redemptions/index',
  'pages/redemption/index',
  'pages/returns/index',
  'pages/return/index',
  'pages/service-area/index',
  'pages/addresses/index',
  'pages/express-addresses/index',
  'pages/checkout/index',
  'pages/orders/index',
  'pages/order/index',
]);
for (const file of [
  'project.config.json',
  'apps/consumer-mini/project.config.json',
  `${root}/project.config.json`,
]) {
  const project = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(project.compileType, 'miniprogram', `Wrong project type: ${file}`);
  assert.equal(typeof project.miniprogramRoot, 'string', `Missing miniprogramRoot: ${file}`);
  const miniRoot = resolve(dirname(file), project.miniprogramRoot);
  assert.equal(miniRoot, resolve(root), `Wrong mini-program root: ${file}`);
  assert.ok(existsSync(resolve(miniRoot, 'app.json')), `Cannot resolve app.json from ${file}`);
}
console.log(
  'WeChat build artifacts and all three import roots verified. This does not replace developer-tool or real-device verification.',
);
