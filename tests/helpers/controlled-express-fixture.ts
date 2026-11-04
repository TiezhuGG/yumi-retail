import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { expressShippingFixture } from './express-shipping-fixture.ts';
import { ExpressReadinessService } from '../../apps/api/dist/express-readiness.js';
import { createApplication } from '../../apps/api/dist/app.js';
import { tokenHash } from '../../apps/api/dist/staff-auth.js';
export async function controlledExpressFixture(options: { browserLogin?: boolean } = {}) {
  const f = await expressShippingFixture();
  let runtime: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const d = f.runtime.db,
      schema = (await d.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`)[0]!
        .schema;
    assert.match(schema, /^address_ui_[a-f0-9]{32}$/);
    const appId = 'wx' + '0'.repeat(16),
      staff = await d.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    async function user(label: string) {
      const id = randomUUID(),
        token = randomBytes(32).toString('base64url');
      await d.$transaction(async (tx) => {
        await tx.consumerUser.create({
          data: {
            id,
            provider: 'WECHAT',
            wechatAppId: appId,
            subject: tokenHash(appId + ':synthetic-controlled-browser-' + label),
            displayName: '合成受控顾客 ' + label,
          },
        });
        await tx.consumerSession.create({
          data: {
            id: randomUUID(),
            userId: id,
            authVersion: 0,
            tokenHash: tokenHash(token),
            expiresAt: new Date(Date.now() + 3600000),
          },
        });
        await tx.pointsAccount.create({ data: { userId: id, balance: 1000n } });
        await tx.pointsEntry.create({
          data: {
            id: randomUUID(),
            userId: id,
            delta: 1000n,
            reason: '隔离受控门禁合成额度',
            actionKey: 'SYNTHETIC-CONTROLLED:' + id,
            actorId: staff.id,
          },
        });
      });
      return { id, token, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    }
    const a = await user('A'),
      b = await user('B');
    const config = {
      ...f.runtime.app.get(ExpressReadinessService).config,
      consumerDevLogin: false,
      orderDevSubmit: false,
      redemptionDevSubmit: false,
      redemptionPickingDev: false,
      wechatLogin: true,
      wechatAppId: appId,
      wechatAppSecret: randomBytes(16).toString('hex'),
      pointsExpress: {
        mode: 'controlled' as 'off' | 'controlled' | 'production',
        submit: true,
        operations: true,
        allowedUsers: [a.id],
        apiOrigin: 'https://api.synthetic.invalid',
      },
    };
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.searchParams.set('schema', schema);
    runtime = await createApplication(u.toString(), {
      config,
      accessLog: () => {},
      ...(options.browserLogin
        ? { wechatExchange: async () => ({ openid: 'synthetic-controlled-browser-A' }) }
        : {}),
    });
    await runtime.app.listen(0, '127.0.0.1');
    const base = await runtime.app.getUrl();
    async function call(
      path: string,
      body?: unknown,
      key = randomUUID(),
      token = a.token,
      staffCall = false,
    ) {
      const r = await fetch(base + '/api/v1' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...(staffCall
            ? {
                Cookie: f.cookie,
                Origin: 'http://127.0.0.1:5188',
                'X-CSRF-Token': f.profile.csrfToken,
              }
            : { Authorization: 'Bearer ' + token }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, ...(await r.json()) };
    }
    const addr = await call('/consumer/express-addresses', {
      version: 0,
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detailAddress: '合成受控快递路1号',
      contactName: '合成受控收件人',
      phone: '00000000000',
      note: '',
      isDefault: true,
    });
    assert.equal(addr.status, 200);
    const input = {
      ...f.input,
      deliveryMode: 'EXPRESS',
      addressId: addr.data.id,
      addressVersion: 1,
    };
    async function order() {
      const q = await call('/consumer/redemption-quotes', input);
      assert.equal(q.status, 200);
      const k = randomUUID(),
        r = await call('/consumer/redemptions', { quoteId: q.data.id }, k);
      assert.equal(r.status, 200);
      return { id: r.data.id, quote: q.data, key: k };
    }
    return {
      ...f,
      controlled: runtime,
      controlledBase: base,
      config,
      a,
      b,
      call,
      quoteInput: input,
      controlledOrder: order,
      cleanup: async () => {
        await runtime?.close();
        await f.cleanup();
      },
    };
  } catch (e) {
    await runtime?.close();
    await f.cleanup();
    throw e;
  }
}
