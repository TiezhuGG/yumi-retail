import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConsumerSession,
  parseSession,
  SessionRequestError,
} from '../apps/consumer-mini/src/consumer-session.ts';
import type { SessionState } from '../apps/consumer-mini/src/consumer-session.ts';
const token = 'a'.repeat(43),
  expiresAt = '2026-11-01T00:00:00.000Z';
const profile = {
  user: {
    id: '00000000-0000-4000-8000-000000000003',
    displayName: '开发顾客 A',
    provider: 'DEVELOPMENT' as const,
  },
  expiresAt,
};
function fixture() {
  let raw: unknown = '',
    state: SessionState | undefined,
    failWrite = false,
    failClear = false;
  const calls: Array<{ path: string; token?: string; body?: unknown }> = [];
  let response = async (path: string): Promise<unknown> =>
    path.endsWith('dev-session') ? { ...profile, token } : profile;
  const store = createConsumerSession(
    {
      read: () => raw,
      write: (value) => {
        if (failWrite) throw Error('保存失败');
        raw = value;
      },
      clear: () => {
        if (failClear) throw Error('清除失败');
        raw = '';
      },
      async request<T>(path: string, auth?: string, body?: unknown) {
        calls.push({ path, token: auth, body });
        return (await response(path)) as T;
      },
    },
    (value) => {
      state = value;
    },
  );
  return {
    store,
    calls,
    get raw() {
      return raw;
    },
    set raw(v) {
      raw = v;
    },
    get state() {
      return state!;
    },
    set response(v: (path: string) => Promise<unknown>) {
      response = v;
    },
    set failWrite(v: boolean) {
      failWrite = v;
    },
    set failClear(v: boolean) {
      failClear = v;
    },
  };
}
test('guest restores without API; login persists only opaque session and publishes no token', async () => {
  const f = fixture();
  await f.store.restore();
  assert.equal(f.state.phase, 'guest');
  assert.equal(f.calls.length, 0);
  await f.store.login('customer-a');
  assert.deepEqual(f.raw, { token, expiresAt });
  assert.equal(f.state.phase, 'authenticated');
  assert.equal(JSON.stringify(f.state).includes(token), false);
  await f.store.restore();
  assert.equal(f.calls.at(-1)?.path, '/consumer/me');
});
test('network uncertainty preserves stored token; authoritative 401 clears it, never guest cart', async () => {
  const f = fixture();
  f.raw = { token, expiresAt };
  f.response = async () => {
    throw Error('网络失败');
  };
  await f.store.restore();
  assert.equal(f.state.phase, 'error');
  assert.deepEqual(f.raw, { token, expiresAt });
  f.response = async () => {
    throw new SessionRequestError(401, 'expired');
  };
  await f.store.restore();
  assert.equal(f.state.phase, 'guest');
  assert.equal(f.raw, '');
});
test('logout failure keeps session for retry; success clears only local session', async () => {
  const f = fixture();
  f.raw = { token, expiresAt };
  f.response = async () => {
    throw Error('网络失败');
  };
  await f.store.logout();
  assert.deepEqual(f.raw, { token, expiresAt });
  f.response = async () => ({ loggedOut: true });
  await f.store.logout();
  assert.equal(f.raw, '');
  assert.equal(f.state.phase, 'guest');
});
test('write failure revokes unused issued token and does not falsely show authenticated', async () => {
  const f = fixture();
  f.failWrite = true;
  await f.store.login('customer-a');
  assert.equal(f.state.phase, 'error');
  assert.equal(f.raw, '');
  assert.equal(f.calls.at(-1)?.path, '/consumer/auth/logout');
  assert.equal(f.calls.at(-1)?.token, token);
});
test('corrupt storage is retained until explicit clear; clear failures remain visible', async () => {
  const f = fixture();
  f.raw = { token: 'bad', expiresAt };
  await f.store.restore();
  assert.equal(f.state.phase, 'error');
  assert.deepEqual(f.raw, { token: 'bad', expiresAt });
  assert.equal(f.calls.length, 0);
  f.failClear = true;
  f.store.clearLocal();
  assert.equal(f.state.phase, 'error');
  f.failClear = false;
  f.store.clearLocal();
  assert.equal(f.raw, '');
  assert.equal(f.state.phase, 'guest');
  assert.throws(() => parseSession([]));
});
test('navigation cancels late login, revokes unused token and prevents late state writes', async () => {
  const f = fixture();
  let resolve!: (v: unknown) => void;
  f.response = (path) =>
    path.endsWith('dev-session')
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve({});
  const pending = f.store.login('customer-a');
  f.store.cancel();
  resolve({ ...profile, token });
  await pending;
  assert.equal(f.raw, '');
  assert.equal(f.calls.at(-1)?.path, '/consumer/auth/logout');
});
test('duplicate taps do not create duplicate sessions; login refuses silently replacing a saved identity', async () => {
  const f = fixture();
  let resolve!: (v: unknown) => void;
  f.response = () =>
    new Promise((r) => {
      resolve = r;
    });
  const pending = f.store.login('customer-a');
  await f.store.login('customer-b');
  assert.equal(f.calls.length, 1);
  resolve({ ...profile, token });
  await pending;
  await f.store.login('customer-b');
  assert.equal(f.state.phase, 'error');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.raw, { token, expiresAt });
});
test('invalid API profiles are rejected and clear failures after 401 remain recoverable', async () => {
  const f = fixture();
  f.raw = { token, expiresAt };
  f.response = async () => ({ user: { ...profile.user, provider: 'WECHAT' }, expiresAt });
  await f.store.restore();
  assert.equal(f.state.phase, 'error');
  f.failClear = true;
  f.response = async () => {
    throw new SessionRequestError(401, 'expired');
  };
  await f.store.restore();
  assert.equal(f.state.phase, 'error');
  assert.deepEqual(f.raw, { token, expiresAt });
});
