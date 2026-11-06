import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressFixture } from './helpers/address-fixture.ts';

type F = Awaited<ReturnType<typeof addressFixture>>;
async function call(
  f: F,
  input?: unknown,
  token = f.identity.token,
  path = '/consumer/profile/nickname',
) {
  const response = await fetch(f.base + '/api/v1' + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: response.status, headers: response.headers, ...(await response.json()) } as {
    status: number;
    headers: Headers;
    data: { user: { id: string; displayName: string; provider: string }; expiresAt: string };
    error?: { code: string };
  };
}
test('nickname normalizes Unicode, saves only the owner name, and repeating the same target preserves identity and sessions', async () => {
  const f = await addressFixture();
  try {
    const before = await f.runtime.db.consumerUser.findUniqueOrThrow({
      where: { id: f.identity.user.id },
    });
    const body = { displayName: '  玉米e\u0301🙂  ', expectedDisplayName: before.displayName };
    const first = await call(f, body);
    assert.equal(first.status, 200);
    assert.equal(first.data.user.displayName, '玉米é🙂');
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await call(f, body)).data, first.data);
    assert.equal(
      (await call(f, undefined, undefined, '/consumer/me')).data.user.displayName,
      '玉米é🙂',
    );
    const user = await f.runtime.db.consumerUser.findUniqueOrThrow({ where: { id: before.id } });
    assert.deepEqual({ ...user, displayName: before.displayName }, before);
    assert.equal(await f.runtime.db.consumerSession.count(), 1);
    const result = await call(f, { displayName: '🙂'.repeat(20), expectedDisplayName: '玉米é🙂' });
    assert.equal(result.status, 200);
    assert.equal(result.data.user.displayName, '🙂'.repeat(20));
  } finally {
    await f.cleanup();
  }
});

test('strict nickname input, concurrent names, stale snapshots and caller-selected identities cannot overwrite another profile', async () => {
  const f = await addressFixture();
  try {
    const original = f.identity.user.displayName;
    for (const input of [
      null,
      [],
      {},
      { displayName: '新昵称' },
      { displayName: '新昵称', expectedDisplayName: original, userId: f.identity.user.id },
      { displayName: '新昵称', expectedDisplayName: original, provider: 'WECHAT' },
      ...[
        '',
        '   ',
        '甲'.repeat(21),
        '🙂'.repeat(21),
        '换\n行',
        '\u0000',
        '隐\u200b藏',
        '\u0301',
      ].map((displayName) => ({ displayName, expectedDisplayName: original })),
    ])
      assert.equal((await call(f, input)).status, 400);
    assert.equal(
      (
        await call(
          f,
          { displayName: '新昵称', expectedDisplayName: original },
          undefined,
          '/consumer/profile/nickname?userId=anything',
        )
      ).status,
      400,
    );
    const results = await Promise.all(
      ['并发昵称甲', '并发昵称乙'].map((displayName) =>
        call(f, { displayName, expectedDisplayName: original }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const winner = results.find((r) => r.status === 200)!.data.user.displayName;
    assert.equal(
      (await call(f, { displayName: '旧快照覆盖', expectedDisplayName: original })).error?.code,
      'PROFILE_CHANGED',
    );
    assert.equal(
      (await call(f, undefined, undefined, '/consumer/me')).data.user.displayName,
      winner,
    );
    const second = await fetch(f.base + '/api/v1/consumer/auth/dev-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Yumi-Dev-Login': '1' },
      body: JSON.stringify({ profile: 'customer-b' }),
    });
    const identityB = (await second.json()).data;
    assert.equal(
      (
        await call(
          f,
          { displayName: '仅修改乙', expectedDisplayName: identityB.user.displayName },
          identityB.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call(f, undefined, undefined, '/consumer/me')).data.user.displayName,
      winner,
    );
    assert.equal(
      (
        await fetch(f.base + '/api/v1/consumer/profile/nickname', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
  } finally {
    await f.cleanup();
  }
});

test('session expiry during the write rolls back the name, and revoked or disabled identities cannot edit', async () => {
  const f = await addressFixture();
  try {
    await f.runtime.db.$executeRawUnsafe(
      `CREATE FUNCTION nickname_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$`,
    );
    await f.runtime.db.$executeRawUnsafe(
      'CREATE TRIGGER nickname_slow BEFORE UPDATE ON consumer_users FOR EACH ROW EXECUTE FUNCTION nickname_slow()',
    );
    await f.runtime.db
      .$executeRaw`UPDATE consumer_sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE user_id=${f.identity.user.id}::uuid`;
    const started = Date.now();
    const body = { displayName: '不应保存', expectedDisplayName: f.identity.user.displayName };
    assert.equal((await call(f, body)).status, 401);
    assert.ok(Date.now() - started >= 900, 'request must reach the delayed write before expiring');
    assert.equal(
      (await f.runtime.db.consumerUser.findUniqueOrThrow({ where: { id: f.identity.user.id } }))
        .displayName,
      f.identity.user.displayName,
    );
    await f.runtime.db.$executeRawUnsafe('DROP TRIGGER nickname_slow ON consumer_users');
    const loginAgain = async () => {
      const r = await fetch(f.base + '/api/v1/consumer/auth/dev-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Yumi-Dev-Login': '1' },
        body: JSON.stringify({ profile: 'customer-a' }),
      });
      assert.equal(r.status, 200);
      return (await r.json()).data.token as string;
    };
    const revokedToken = await loginAgain();
    await f.runtime.db.consumerSession.updateMany({ data: { revokedAt: new Date() } });
    assert.equal((await call(f, body, revokedToken)).status, 401);
    const disabledToken = await loginAgain();
    await f.runtime.db.consumerUser.update({
      where: { id: f.identity.user.id },
      data: { enabled: false },
    });
    assert.equal((await call(f, body, disabledToken)).status, 401);
  } finally {
    await f.cleanup();
  }
});

test('an isolated WeChat identity keeps its edited nickname across new login sessions without altering provider or receiving points', async () => {
  const f = await addressFixture({
    wechatExchange: async () => ({ openid: 'synthetic_openid_for_nickname_test' }),
  });
  try {
    const login = async (code: string) => {
      const r = await fetch(f.base + '/api/v1/consumer/auth/wechat-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      assert.equal(r.status, 200);
      return (await r.json()).data;
    };
    const a = await login('nickname_code_1');
    const r = await call(
      f,
      { displayName: '微信昵称已修改', expectedDisplayName: '微信顾客' },
      a.token,
    );
    assert.equal(r.status, 200);
    assert.equal(r.data.user.provider, 'WECHAT');
    const b = await login('nickname_code_2');
    assert.equal(b.user.id, a.user.id);
    assert.equal(b.user.displayName, '微信昵称已修改');
    assert.equal(await f.runtime.db.pointsEntry.count(), 0);
  } finally {
    await f.cleanup();
  }
});
