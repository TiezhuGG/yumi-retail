// Real receipt-backed inventory and API, disposable PostgreSQL schema only.
import { randomUUID } from 'node:crypto';
import { pointsFixture } from './points-fixture.ts';
import { seedCartCatalog } from './cart-catalog.ts';
export async function rewardsFixture() {
  const f = await pointsFixture();
  try {
    const catalog = await seedCartCatalog(f.runtime, f.warehouseId, true);
    const me = await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: f.cookie } });
    const { data: profile } = (await me.json()) as { data: { csrfToken: string } };
    const input = {
      skuId: catalog.skuIds[0]!,
      title: '日常柔软纸巾',
      pointsPrice: '120',
      sortOrder: 10,
      perUserLimit: 3,
      totalQuota: 20,
      startsAt: null,
      endsAt: null,
      reason: '合成商品验收',
    };
    async function api(
      path: string,
      body?: unknown,
      k = randomUUID(),
      cookie = f.cookie,
      csrf = profile.csrfToken,
    ) {
      const r = await fetch(f.base + '/api/v1' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'http://127.0.0.1:5188',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': k,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, ...(await r.json()) } as {
        status: number;
        data: {
          id: string;
          items: Array<Record<string, unknown>>;
          nextCursor: string | null;
          pointsPrice: string;
          available: number;
          version: number;
          redemptionEnabled: boolean;
        };
        error?: { code: string };
      };
    }
    return { ...f, catalog, input, profile, api };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
