/* global global, yumiConsumerBridge */
// Opt-in native rendering with an explicit Node HTTP bridge to a disposable PostgreSQL schema.
// The bridge bypasses WeChat's request-domain layer; it is not real-device/network acceptance.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApplication } from '../../apps/api/dist/app.js';
import { applicationConfig } from '../../apps/api/dist/config.js';
import { tokenHash } from '../../apps/api/dist/staff-auth.js';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const url = new URL(process.env.TEST_DATABASE_URL || '');
if (url.hostname !== '127.0.0.1' || url.pathname !== '/yumi_test' || url.searchParams.has('schema'))
  throw Error('Isolated local test database only');
const require = createRequire(import.meta.url),
  { Client } = require('pg');
const automator = require(process.env.YUMI_MINI_AUTOMATOR_PATH || 'miniprogram-automator');
const schema = 'consumer_ui_' + randomUUID().replaceAll('-', '');
const admin = new Client({ connectionString: url.toString() });
const sessionKey = 'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1';
const cartKey = 'yumi.guest-cart.v1:http://127.0.0.1:3000/api/v1';
let runtime,
  mini,
  page,
  mocked = false,
  storageMocked = false,
  modalMocked = false,
  touched = false;
let backup,
  hadSession = false,
  cartBackup,
  hadCart = false,
  failMe = false,
  failLogout = false,
  delay = 0,
  bridgeError;
let restored = false,
  apiCalls = 0;
try {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  const directory = 'packages/database/prisma/migrations';
  for (const name of (await readdir(directory)).filter((n) => /^\d/.test(n)).sort())
    await admin.query(await readFile(`${directory}/${name}/migration.sql`, 'utf8'));
  url.searchParams.set('schema', schema);
  runtime = await createApplication(url.toString(), {
    config: applicationConfig({ NODE_ENV: 'test', CONSUMER_DEV_LOGIN_ENABLED: '1' }),
    accessLog: () => {},
  });
  await runtime.app.listen(0, '127.0.0.1');
  const base = await runtime.app.getUrl();
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const keys = (await mini.callWxMethod('getStorageInfoSync')).keys;
  hadSession = keys.includes(sessionKey);
  if (hadSession) backup = await mini.callWxMethod('getStorageSync', sessionKey);
  hadCart = keys.includes(cartKey);
  if (hadCart) cartBackup = await mini.callWxMethod('getStorageSync', cartKey);
  await mini.callWxMethod('removeStorageSync', sessionKey);
  touched = true;
  await mini.evaluate(() => {
    global.__yumiConsumerResponses = {};
    global.__yumiConsumerSequence = 0;
  });
  await mini.exposeFunction('yumiConsumerBridge', (id, options) => {
    void (async () => {
      let result;
      const route = options.url.split('/api/v1')[1] || '';
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if ((failMe && route === '/consumer/me') || (failLogout && route === '/consumer/auth/logout'))
        result = { statusCode: 503, data: { error: { message: '合成断网：请重试' } } };
      else if (
        ['/consumer/me', '/consumer/auth/dev-session', '/consumer/auth/logout'].includes(route)
      ) {
        apiCalls++;
        const response = await fetch(base + '/api/v1' + route, {
          method: options.method,
          headers: options.header,
          body: options.method === 'POST' ? JSON.stringify(options.data) : undefined,
        });
        result = { statusCode: response.status, data: await response.json() };
      } else
        result = {
          statusCode: 200,
          data: { data: { items: [], hasMore: false, nextCursor: null } },
        };
      await mini.evaluate(
        (requestId, value) => {
          const callback = global.__yumiConsumerResponses[requestId];
          delete global.__yumiConsumerResponses[requestId];
          if (callback) callback(value);
        },
        id,
        result,
      );
    })().catch((e) => {
      bridgeError = e;
    });
  });
  await mini.mockWxMethod('request', function (options) {
    return new Promise((resolve) => {
      const id = ++global.__yumiConsumerSequence;
      global.__yumiConsumerResponses[id] = resolve;
      yumiConsumerBridge(id, {
        url: options.url,
        method: options.method,
        header: options.header,
        data: options.data,
      });
    });
  });
  mocked = true;
  async function wait(selector, text) {
    for (let i = 0; i < 90; i++) {
      if (bridgeError) throw bridgeError;
      for (const element of await page.$$(selector))
        if (text === undefined || (await element.text()).includes(text)) return element;
      await page.waitFor(100);
    }
    throw Error('Missing account UI ' + selector + ' ' + text);
  }
  async function tap(selector, text) {
    await (await wait(selector, text)).tap();
  }
  async function shot(name) {
    await mini.pageScrollTo(0);
    await page.waitFor(250);
    await mini.screenshot({
      path: resolve(`docs/verification/WECHAT-CONSUMER-SESSION-${name}-2026-10-31.png`),
    });
  }
  async function saved() {
    return mini.callWxMethod('getStorageSync', sessionKey);
  }
  async function waitSaved(test) {
    for (let i = 0; i < 60; i++) {
      const value = await saved();
      if (test(value)) return value;
      await page.waitFor(100);
    }
    throw Error('Session storage did not settle');
  }
  page = await mini.reLaunch('/pages/account/index');
  await wait('.account-dev-actions button', '开发顾客 A');
  await shot('GUEST');
  await tap('.account-dev-actions button', '开发顾客 A');
  await wait('.account-name', '开发顾客 A');
  const a = await waitSaved((v) => v?.token);
  assert.equal(
    (await runtime.db.consumerSession.findUnique({ where: { tokenHash: tokenHash(a.token) } }))
      .revokedAt,
    null,
  );
  await shot('SIGNED-IN');
  page = await mini.reLaunch('/pages/account/index');
  await wait('.account-name', '开发顾客 A');
  failLogout = true;
  await tap('.account-primary', '退出当前登录');
  await wait('.account-error', '合成断网');
  assert.equal((await saved()).token, a.token);
  failLogout = false;
  await tap('.account-error button');
  await wait('.account-name', '开发顾客 A');
  delay = 4500;
  page = await mini.reLaunch('/pages/account/index');
  await wait('.account-name', '正在核验');
  await shot('LOADING');
  delay = 0;
  await wait('.account-name', '开发顾客 A');
  failMe = true;
  page = await mini.reLaunch('/pages/account/index');
  await wait('.account-error', '合成断网');
  await shot('ERROR');
  assert.equal((await saved()).token, a.token);
  failMe = false;
  await tap('.account-error button');
  await wait('.account-name', '开发顾客 A');
  await tap('.account-primary', '退出当前登录');
  await wait('.account-card-title', '先随意逛逛');
  await waitSaved((v) => !v);
  assert.ok(
    (await runtime.db.consumerSession.findUnique({ where: { tokenHash: tokenHash(a.token) } }))
      .revokedAt,
  );
  await tap('.account-dev-actions button', '开发顾客 B');
  await wait('.account-name', '开发顾客 B');
  const b = await waitSaved((v) => v?.token);
  const storedB = await runtime.db.consumerSession.findUnique({
    where: { tokenHash: tokenHash(b.token) },
  });
  assert.notEqual(
    storedB.userId,
    (await runtime.db.consumerSession.findUnique({ where: { tokenHash: tokenHash(a.token) } }))
      .userId,
  );
  await runtime.db.consumerUser.update({
    where: { id: storedB.userId },
    data: { authVersion: { increment: 1 } },
  });
  page = await mini.reLaunch('/pages/account/index');
  await wait('.account-error', '登录已失效');
  await waitSaved((v) => !v);
  await shot('EXPIRED');
  await mini.mockWxMethod('setStorageSync', function () {
    throw Error('合成保存失败');
  });
  storageMocked = true;
  await tap('.account-dev-actions button', '开发顾客 A');
  await wait('.account-error', '保存失败');
  await page.waitFor(300);
  assert.equal(
    await runtime.db.consumerSession.count({
      where: { revokedAt: null, authVersion: 0, user: { subject: 'customer-a' } },
    }),
    0,
  );
  await mini.restoreWxMethod('setStorageSync');
  storageMocked = false;
  await mini.callWxMethod('setStorageSync', sessionKey, { token: 'corrupt', expiresAt: 'unknown' });
  page = await mini.reLaunch('/pages/account/index');
  await wait('.account-error', '无法读取');
  await shot('CORRUPT');
  await mini.mockWxMethod('showModal', { confirm: false, cancel: true });
  modalMocked = true;
  await tap('.account-clear');
  await page.waitFor(200);
  assert.equal((await saved()).token, 'corrupt');
  await mini.mockWxMethod('showModal', { confirm: true, cancel: false });
  await tap('.account-clear');
  await waitSaved((v) => !v);
  await mini.restoreWxMethod('showModal');
  modalMocked = false;
  console.log(
    'Consumer UI passed through isolated real API bridge: A/B identity, reopen, logout retry/revocation, loading, network uncertainty, auth version expiry, save failure compensation and corrupt-record reset fixtures.',
  );
} finally {
  try {
    if (mini) {
      try {
        if (storageMocked) await mini.restoreWxMethod('setStorageSync');
        if (modalMocked) await mini.restoreWxMethod('showModal');
        if (mocked) await mini.restoreWxMethod('request');
        if (touched) {
          if (hadSession) await mini.callWxMethod('setStorageSync', sessionKey, backup);
          else await mini.callWxMethod('removeStorageSync', sessionKey);
          const keys = (await mini.callWxMethod('getStorageInfoSync')).keys;
          assert.equal(keys.includes(sessionKey), hadSession);
          if (hadSession)
            assert.deepEqual(await mini.callWxMethod('getStorageSync', sessionKey), backup);
          assert.equal(keys.includes(cartKey), hadCart);
          if (hadCart)
            assert.deepEqual(await mini.callWxMethod('getStorageSync', cartKey), cartBackup);
          restored = true;
        }
        await mini.evaluate(() => {
          delete global.__yumiConsumerResponses;
          delete global.__yumiConsumerSequence;
        });
      } finally {
        await mini.disconnect();
      }
    }
  } finally {
    try {
      if (runtime) await runtime.close();
    } finally {
      try {
        assert.match(schema, /^consumer_ui_[a-f0-9]{32}$/);
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await writeFile(
          '.local/consumer-ui-cleanup.json',
          JSON.stringify({ restored, schemaRemoved: true, apiCalls }) + '\n',
        );
      } finally {
        await admin.end();
      }
    }
  }
}
