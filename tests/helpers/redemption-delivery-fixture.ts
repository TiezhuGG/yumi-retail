// Actual redemption->claim->check->pack->ship APIs; disposable schema and synthetic identities only.
import { randomUUID } from 'node:crypto';
import { redemptionPickingFixture } from './redemption-picking-fixture.ts';
import { runRedemptionPickingOnce } from '../../packages/database/dist/index.js';
import type { RedemptionDeliveryPage } from '../../packages/contracts/src/index.ts';
export async function redemptionDeliveryFixture() {
  const f = await redemptionPickingFixture();
  const deliveryPrefix = '/warehouse/warehouses/' + f.warehouseId + '/redemption-delivery';
  async function shipment(existingOrderId?: string) {
    const orderId = existingOrderId ?? (await f.order()),
      p = f.prefix + '/' + orderId;
    await runRedemptionPickingOnce(f.runtime.db);
    if ((await f.api(p + '/claim', { version: 0 })).status !== 200)
      throw Error('Delivery fixture claim failed');
    let v = (await f.read(orderId)).data.items[0]!;
    for (const a of v.lines) {
      if (
        (
          await f.api(p + '/check', {
            version: v.task!.version,
            allocationId: a.id,
            quantity: a.quantity,
          })
        ).status !== 200
      )
        throw Error('Delivery fixture check failed');
      v = (await f.read(orderId)).data.items[0]!;
    }
    if ((await f.api(p + '/complete', { version: v.task!.version })).status !== 200)
      throw Error('Delivery fixture completion failed');
    v = (await f.read(orderId)).data.items[0]!;
    if (
      (
        await f.api(p + '/pack', {
          version: v.task!.version,
          packageCount: 2,
          lines: v.lines.map((a) => ({ allocationId: a.id, quantity: a.quantity })),
        })
      ).status !== 200
    )
      throw Error('Delivery fixture pack failed');
    v = (await f.read(orderId)).data.items[0]!;
    if (
      (
        await f.api(p + '/ship', {
          version: v.task!.version,
          packId: v.packing.pack!.id,
          physicalConfirmed: true,
        })
      ).status !== 200
    )
      throw Error('Delivery fixture shipment failed');
    v = (await f.read(orderId)).data.items[0]!;
    return { id: v.packing.shipment!.id, orderId };
  }
  async function deliveryRead(id?: string, cookie = f.cookie, query = '') {
    const r = await fetch(f.base + '/api/v1' + deliveryPrefix + (id ? '/' + id : query), {
      headers: { Cookie: cookie },
    });
    return { status: r.status, ...(await r.json()) } as {
      status: number;
      data: RedemptionDeliveryPage;
      error?: { code: string };
    };
  }
  async function assign(id: string, riderId: string, k = randomUUID()) {
    return f.api(deliveryPrefix + '/' + id + '/assign', { riderId }, k);
  }
  return { ...f, deliveryPrefix, shipment, deliveryRead, assign };
}
