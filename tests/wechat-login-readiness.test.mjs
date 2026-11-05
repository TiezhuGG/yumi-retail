import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWechatLogin } from '../scripts/check-wechat-login.mjs';
const appid = 'wx1234567890abcdef',
  secret = 's'.repeat(32),
  api = 'https://api.fixture-site.net/api/v1';
const env = {
  WECHAT_LOGIN_ENABLED: '1',
  WECHAT_APP_ID: appid,
  WECHAT_APP_SECRET: secret,
  PAYMENT_MODE: 'disabled',
  TARO_APP_API_BASE_URL: api,
};
const options = {
  projects: [{ appid }, { appid }],
  buildVerified: true,
  build: { target: 'device', apiBase: api, wechatAppId: appid, consumerDevelopmentLogin: false },
};
test('missing registration and local build produce an explicit report, not a false real-login success', () => {
  const r = inspectWechatLogin(
    {},
    { projects: [{ appid: 'touristappid' }], build: { target: 'local' }, buildVerified: false },
  );
  assert.equal(r.configurationReady, false);
  assert.equal(r.networkChecked, false);
  assert.equal(r.realWechatVerified, false);
  assert.equal(r.canLaunch, false);
  assert.ok(r.checks.some((c) => c.code === 'PROJECT_MATCH' && !c.ok));
});
test('matching configuration is only statically ready; AppID/API/development mismatches still fail', () => {
  const r = inspectWechatLogin(env, options);
  assert.equal(r.configurationReady, true);
  assert.equal(r.canLaunch, false);
  assert.equal(r.realWechatVerified, false);
  for (const patch of [
    { buildVerified: false },
    { projects: [{ appid: 'wxabcdef1234567890' }] },
    { build: { ...options.build, consumerDevelopmentLogin: true } },
    { build: { ...options.build, apiBase: api + '/changed' } },
  ])
    assert.equal(inspectWechatLogin(env, { ...options, ...patch }).configurationReady, false);
  assert.equal(
    inspectWechatLogin({ ...env, CONSUMER_DEV_LOGIN_ENABLED: '1' }, options).configurationReady,
    false,
  );
});
test('reports do not echo secrets, malformed credential-bearing URLs or project values', () => {
  const r = inspectWechatLogin(
    {
      ...env,
      TARO_APP_API_BASE_URL: 'https://account:private-url-secret@api.fixture-site.net/api/v1',
    },
    { ...options, projects: [{ appid: 'private-project-value' }] },
  );
  const text = JSON.stringify(r);
  for (const value of [secret, 'private-url-secret', 'private-project-value', appid, api])
    assert.equal(text.includes(value), false);
  assert.equal(r.configurationReady, false);
});
