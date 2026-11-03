import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { wechatExchange } from '../apps/api/src/wechat-login.ts';
import type { ApplicationConfig } from '../apps/api/src/config.ts';
import {
  createConsumerSession,
  type SessionState,
} from '../apps/consumer-mini/src/consumer-session.ts';
const appId = 'wx' + '0'.repeat(16),
  secret = randomBytes(16).toString('hex');
const config = { wechatAppId: appId, wechatAppSecret: secret } as ApplicationConfig;
test('WeChat adapter pins endpoint, bounds request, discards upstream keys and maps errors without leaking contents', async () => {
  let calls = 0;
  const adapter = wechatExchange(config, (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls++;
    const u = new URL(String(input));
    assert.equal(u.origin, 'https://api.weixin.qq.com');
    assert.equal(u.pathname, '/sns/jscode2session');
    assert.equal(u.searchParams.get('appid'), appId);
    assert.equal(u.searchParams.get('secret'), secret);
    assert.equal(u.searchParams.get('js_code'), 'synthetic_code');
    assert.equal(init!.redirect, 'error');
    assert.ok(init!.signal);
    return new Response(
      JSON.stringify({
        openid: 'synthetic-openid-adapter-001',
        session_key: randomBytes(16).toString('base64'),
        unionid: 'discarded',
        errcode: 0,
      }),
    );
  }) as typeof fetch);
  assert.deepEqual(await adapter('synthetic_code'), { openid: 'synthetic-openid-adapter-001' });
  assert.equal(calls, 1);
  for (const [body, status] of [
    [{ errcode: 40029, errmsg: secret }, 401],
    [{ errcode: 40163 }, 401],
    [{ errcode: 45011 }, 429],
    [{ errcode: -1, errmsg: secret }, 503],
    [{ openid: 'short', session_key: 'bad' }, 503],
    [{ openid: 'synthetic-openid-adapter-001' }, 503],
  ] as const) {
    const exchange = wechatExchange(
      config,
      (async () => new Response(JSON.stringify(body))) as typeof fetch,
    );
    await assert.rejects(exchange('test'), (e: unknown) => {
      const err = e as { getStatus(): number; getResponse(): unknown };
      assert.equal(err.getStatus(), status);
      assert.equal(JSON.stringify(err.getResponse()).includes(secret), false);
      return true;
    });
  }
  for (const transport of [
    (async () => {
      throw Error('secret:' + secret);
    }) as typeof fetch,
    (async () => new Response('x'.repeat(17000))) as typeof fetch,
    (async () => new Response('not json', { status: 502 })) as typeof fetch,
  ])
    await assert.rejects(wechatExchange(config, transport)('test'), (e: unknown) => {
      assert.equal((e as { getStatus(): number }).getStatus(), 503);
      assert.equal(String(e).includes(secret), false);
      return true;
    });
});
test('mini WeChat login obtains fresh code, stores only opaque token and cleans cancelled issuance', async () => {
  let state: SessionState | undefined,
    raw: unknown = null,
    codes = 0;
  const calls: Array<{ path: string; body: unknown }> = [],
    token = 'a'.repeat(43),
    expiresAt = new Date(Date.now() + 3600000).toISOString();
  const session = createConsumerSession(
    {
      read: () => raw,
      write: (v) => {
        raw = v;
      },
      clear: () => {
        raw = null;
      },
      loginCode: async () => {
        codes++;
        return 'synthetic_' + codes;
      },
      request: async <T>(path: string, _token?: string, body?: unknown) => {
        calls.push({ path, body });
        return {
          token,
          expiresAt,
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            displayName: '微信顾客',
            provider: 'WECHAT',
          },
        } as T;
      },
    },
    (s) => {
      state = s;
    },
  );
  await session.wechatLogin();
  assert.equal(state!.phase, 'authenticated');
  assert.equal(state!.profile!.user.provider, 'WECHAT');
  assert.equal(calls[0]!.path, '/consumer/auth/wechat-session');
  assert.deepEqual(calls[0]!.body, { code: 'synthetic_1' });
  assert.equal(JSON.stringify(raw).includes('synthetic'), false);
  assert.equal(JSON.stringify(state).includes(token), false);
  await session.wechatLogin();
  assert.equal(codes, 1);
  await session.logout();
  await session.wechatLogin();
  assert.equal(codes, 2);
  let finish: (s: string) => void = () => {};
  const waiting = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let requests = 0;
  const canceled = createConsumerSession(
    {
      read: () => null,
      write: () => {
        throw Error('should not save');
      },
      clear: () => {},
      loginCode: () => waiting,
      request: async <T>() => {
        requests++;
        return {} as T;
      },
    },
    () => {},
  );
  const pending = canceled.wechatLogin();
  canceled.cancel();
  finish('cancelled_code');
  await pending;
  assert.equal(requests, 0);
});
