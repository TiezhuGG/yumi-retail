import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = 'apps/consumer-mini/dist';
for (const name of ['app.js', 'app.json', 'pages/index/index.js', 'pages/index/index.wxml']) {
  assert.ok(existsSync(`${root}/${name}`), `Missing mini-program artifact: ${name}`);
}
const config = JSON.parse(readFileSync(`${root}/app.json`, 'utf8'));
assert.deepEqual(config.pages, ['pages/index/index']);
console.log(
  'WeChat build artifacts verified. This does not replace developer-tool or real-device verification.',
);
