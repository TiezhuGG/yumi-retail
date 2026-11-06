// Synthetic customers and receipt-backed stock inside the disposable schema only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CatalogService } from '../../apps/api/dist/catalog-service.js';
import type { ApiRequest } from '../../apps/api/dist/http.js';
import { expressShippingFixture } from './express-shipping-fixture.ts';

export async function consumerFeedbackFixture(count = 3) {
  const f = await expressShippingFixture();
  try {
    const db = f.runtime.db;
    const scope = await db.$queryRaw<Array<{ name: string }>>`SELECT current_schema() AS name`;
    assert.ok(scope[0]?.name.startsWith('address_ui_'));
    const actors = await Promise.all(
      [0, 1].map((i) => db.staff.findUniqueOrThrow({ where: { loginName: 'cart-fixture-' + i } })),
    );
    const request = (i: number): ApiRequest => ({
      method: 'POST',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      requestId: randomUUID(),
      staffContext: {
        sessionId: randomUUID(),
        staffId: actors[i]!.id,
        loginName: 'fixture',
        displayName: '合成员工',
        roles: ['SUPER_ADMIN'],
        permissions: [],
        warehouseIds: [f.warehouseId],
        csrfToken: '',
      },
    });
    const catalog = new CatalogService(db, f.warehouseId),
      sourceRef = randomUUID();
    await catalog.createReceipt(request(0), randomUUID(), f.warehouseId, {
      sourceRef,
      lines: [
        {
          skuId: f.catalog.skuIds[0]!,
          batchNo: 'FEEDBACK-SCALE',
          quantity: count,
          unitCostCents: 100,
          producedAt: null,
          expiresAt: null,
        },
      ],
    });
    const receipt = await db.inboundReceipt.findFirstOrThrow({ where: { sourceRef } });
    await catalog.receiptAction(request(1), randomUUID(), f.warehouseId, receipt.id, 0, false);
    await catalog.receiptAction(request(0), randomUUID(), f.warehouseId, receipt.id, 1, true);
    await f.credit(f.identity.user.id, count * 120);
    const cases: Array<{ orderId: string; id: string; status: string }> = [];
    for (let i = 0; i < count; i++) {
      // Keep the real quote throttle and immutable records enabled. Wait for expiry
      // when building more than one page rather than bypassing production guards.
      if (i > 0 && i % 20 === 0) {
        const latest = await db.redemptionQuote.findFirstOrThrow({
          where: { userId: f.identity.user.id },
          orderBy: { expiresAt: 'desc' },
        });
        await sleep(Math.max(0, latest.expiresAt.getTime() - Date.now() + 100));
      }
      const orderId = await f.createExpress();
      assert.equal(
        (
          await f.api('/admin/redemptions/' + orderId + '/ship', {
            version: 0,
            carrierCode: 'SF',
            trackingNo: 'SF-FEEDBACK-' + i,
            dispatchConfirmed: true,
          })
        ).status,
        200,
      );
      const path = '/consumer/redemptions/' + orderId + '/after-sales';
      assert.equal(
        (await f.call(path, { category: 'DAMAGED', message: '合成反馈原文 ' + i })).status,
        200,
      );
      if (i === 1 || i === 2)
        assert.equal(
          (
            await f.api('/admin/redemption-after-sales/' + orderId + '/reply', {
              version: 0,
              message: '合成门店公开回复',
            })
          ).status,
          200,
        );
      if (i === 2)
        assert.equal(
          (
            await f.api('/admin/redemption-after-sales/' + orderId + '/close', {
              version: 1,
              message: '合成本次沟通结束',
            })
          ).status,
          200,
        );
      const ticket = await db.redemptionAfterSales.findUniqueOrThrow({ where: { orderId } });
      cases.push({ orderId, id: ticket.id, status: ticket.status });
    }
    return { ...f, cases };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
