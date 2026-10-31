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
  'pages/cart/index.js',
  'pages/cart/index.wxml',
]) {
  assert.ok(existsSync(`${root}/${name}`), `Missing mini-program artifact: ${name}`);
}
const config = JSON.parse(readFileSync(`${root}/app.json`, 'utf8'));
assert.deepEqual(config.pages, ['pages/index/index', 'pages/product/index', 'pages/cart/index']);
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
