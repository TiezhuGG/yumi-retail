export interface ConsumerProfile {
  user: { id: string; displayName: string; provider: 'DEVELOPMENT' };
  expiresAt: string;
}
interface SavedSession {
  token: string;
  expiresAt: string;
}
export class SessionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface SessionState {
  phase: 'guest' | 'loading' | 'authenticated' | 'error';
  profile: ConsumerProfile | null;
  error: string;
  busy: boolean;
}
export const initialSessionState: SessionState = {
  phase: 'guest',
  profile: null,
  error: '',
  busy: false,
};
export function parseSession(raw: unknown): SavedSession | null {
  if (raw === '' || raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw Error('本机登录记录无法读取，请确认后清除登录记录。');
  const value = raw as SavedSession;
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    throw Error('本机登录记录无法读取，请确认后清除登录记录。');
  return { token: value.token, expiresAt: value.expiresAt };
}
function validateProfile(value: ConsumerProfile) {
  if (
    !value?.user ||
    typeof value.user.id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(value.user.id) ||
    typeof value.user.displayName !== 'string' ||
    !value.user.displayName ||
    value.user.displayName.length > 80 ||
    value.user.provider !== 'DEVELOPMENT' ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    throw Error('身份资料暂时无法核验，请重试。');
  return {
    user: { id: value.user.id, displayName: value.user.displayName, provider: value.user.provider },
    expiresAt: value.expiresAt,
  };
}
export function createConsumerSession(
  io: {
    read(): unknown;
    write(value: SavedSession): void;
    clear(): void;
    request<T>(path: string, token?: string, body?: unknown): Promise<T>;
  },
  publish: (state: SessionState) => void,
) {
  let sequence = 0;
  let running = false;
  function cancel() {
    sequence++;
    running = false;
  }
  async function run(
    action: 'restore' | 'login' | 'logout',
    profile?: 'customer-a' | 'customer-b',
  ) {
    if (running) return;
    const current = ++sequence;
    running = true;
    const active = () => sequence === current;
    publish({ phase: 'loading', profile: null, error: '', busy: true });
    let saved: SavedSession | null = null;
    let issued: string | undefined;
    try {
      saved = parseSession(io.read());
      if (action === 'login') {
        // Do not silently replace an existing session on this device.
        if (saved) throw Error('请先恢复或清除当前设备的登录记录，再切换开发身份。');
        const result = await io.request<ConsumerProfile & { token: string }>(
          '/consumer/auth/dev-session',
          undefined,
          { profile },
        );
        issued = parseSession({ token: result.token, expiresAt: result.expiresAt })!.token;
        const verified = validateProfile(result);
        if (!active()) return;
        io.write({ token: issued, expiresAt: result.expiresAt });
        issued = undefined;
        publish({ phase: 'authenticated', profile: verified, error: '', busy: false });
      } else if (!saved) {
        publish({ ...initialSessionState });
      } else if (action === 'logout') {
        await io.request('/consumer/auth/logout', saved.token, {});
        if (!active()) return;
        if (parseSession(io.read())?.token === saved.token) io.clear();
        publish({ ...initialSessionState });
      } else {
        const verified = validateProfile(
          await io.request<ConsumerProfile>('/consumer/me', saved.token),
        );
        if (!active()) return;
        publish({ phase: 'authenticated', profile: verified, error: '', busy: false });
      }
    } catch (error) {
      if (!active()) return;
      let message = error instanceof Error ? error.message : '暂时无法连接，请重试。';
      if (error instanceof SessionRequestError && error.status === 401 && saved) {
        try {
          if (parseSession(io.read())?.token === saved.token) io.clear();
          publish({ ...initialSessionState, error: '登录已失效，请重新登录；购物车草稿已保留。' });
          return;
        } catch {
          message = '登录已失效，但本机记录清除失败，请重试或手动清除登录记录。';
        }
      }
      publish({ phase: 'error', profile: null, error: message, busy: false });
    } finally {
      // If saving failed or navigation cancelled a new login, revoke the unused session.
      if (issued) {
        try {
          await io.request('/consumer/auth/logout', issued, {});
        } catch {
          /* Bounded server expiry remains the fallback. */
        }
      }
      if (active()) running = false;
    }
  }
  return {
    restore: () => run('restore'),
    login: (p: 'customer-a' | 'customer-b') => run('login', p),
    logout: () => run('logout'),
    cancel,
    clearLocal() {
      if (running) return;
      try {
        io.clear();
        publish({ ...initialSessionState });
      } catch {
        publish({
          phase: 'error',
          profile: null,
          busy: false,
          error: '本机登录记录清除失败，请重试。',
        });
      }
    },
  };
}
