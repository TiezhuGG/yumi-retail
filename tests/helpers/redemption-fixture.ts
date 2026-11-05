// Synthetic identities and grants inside a disposable schema only. Stock comes from real receipt service.
import { randomUUID } from 'node:crypto';
import type {
  RedemptionQuoteView,
  RedemptionOrderView,
} from '../../packages/contracts/src/index.ts';
import { rewardsFixture } from './rewards-fixture.ts';
export async function redemptionFixture(
  options: {
    enabled?: boolean;
    balance?: number;
    limit?: number;
    quota?: number;
    picking?: boolean;
  } = {},
) {
  const f = await rewardsFixture({
    redemptions: options.enabled !== false,
    orders: true,
    redemptionPicking: options.picking,
  });
  try {
    const created = await f.api('/admin/rewards/store/create', {
      ...f.input,
      perUserLimit: options.limit ?? 3,
      totalQuota: options.quota ?? 20,
    });
    if (created.status !== 200) throw Error('Reward fixture failed');
    const rewardId = created.data.id;
    if (
      (await f.api('/admin/rewards/' + rewardId + '/publish', { version: 0, reason: '合成上架' }))
        .status !== 200
    )
      throw Error('Reward publish fixture failed');
    type Data = RedemptionQuoteView &
      RedemptionOrderView & {
        items: RedemptionOrderView[];
        nextCursor: string | null;
        balance: string;
      };
    async function call<T = Data>(
      path: string,
      body?: unknown,
      key = randomUUID(),
      token = f.identity.token,
    ) {
      const r = await fetch(f.base + '/api/v1' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, ...(await r.json()) } as {
        status: number;
        data: T;
        error?: { code: string; message: string };
      };
    }
    const addressInput = {
      version: 0,
      areaId: f.areaId,
      buildingId: f.buildingId,
      unit: '',
      room: '合成101',
      contactName: '合成验证联系人',
      phone: '00000000000',
      note: '',
      isDefault: true,
    };
    const a = await call('/consumer/addresses', addressInput),
      b = await call('/consumer/addresses', addressInput, randomUUID(), f.identityB.token);
    if (a.status !== 200 || b.status !== 200) throw Error('Address fixture failed');
    const staff = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    async function credit(userId: string, amount = options.balance ?? 1000) {
      await f.runtime.db.$transaction(async (tx) => {
        await tx.pointsAccount.upsert({
          where: { userId },
          create: { userId, balance: BigInt(amount) },
          update: { balance: { increment: BigInt(amount) }, version: { increment: 1 } },
        });
        await tx.pointsEntry.create({
          data: {
            id: randomUUID(),
            userId,
            delta: BigInt(amount),
            actionKey: 'SYNTHETIC:' + randomUUID(),
            reason: '隔离验证合成额度',
            actorId: staff.id,
          },
        });
      });
    }
    await credit(f.identity.user.id);
    await credit(f.identityB.user.id);
    const input = {
      rewardId,
      rewardVersion: 1,
      quantity: 1,
      addressId: a.data.id,
      addressVersion: 1,
    };
    const inputB = { ...input, addressId: b.data.id };
    return { ...f, rewardId, call, input, inputB, addressInput, credit };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}

// Scale-only synthetic historical cancellations, with all production DB constraints left enabled.
// Reuses real validated snapshots, encrypts each new address under its own ID, and balances both stock ledgers.
export async function seedCancelledRedemptions(
  f: Awaited<ReturnType<typeof redemptionFixture>>,
  count = 23,
) {
  const db = f.runtime.db;
  const schema = await db.$queryRaw<Array<{ name: string }>>`SELECT current_schema() AS name`;
  if (!schema[0]?.name.startsWith('address_ui_')) throw Error('Disposable UI schema required');
  const original = await db.redemptionOrder.findFirstOrThrow({
    where: { status: 'CANCELED' },
    include: { allocations: true, quote: true },
  });
  const { RedemptionService } = await import('../../apps/api/dist/redemptions.js');
  const { orderReservationDelta } = await import('../../packages/database/dist/index.js');
  const privacy = f.runtime.app.get(RedemptionService).privateData;
  const address = privacy.decrypt(original.userId, original.id, original.addressPayload);
  for (let i = 0; i < count; i++)
    await db.$transaction(async (tx) => {
      const id = randomUUID(),
        qid = randomUUID(),
        aid = randomUUID(),
        a = original.allocations[0]!;
      await tx.redemptionQuote.create({
        data: {
          id: qid,
          userId: original.userId,
          rewardId: original.rewardId,
          snapshot: original.quote
            .snapshot as import('../../packages/database/src/index.ts').Prisma.InputJsonValue,
          createdAt: original.quote.createdAt,
          expiresAt: original.quote.expiresAt,
        },
      });
      await tx.redemptionOrder.create({
        data: {
          id,
          userId: original.userId,
          quoteId: qid,
          rewardId: original.rewardId,
          warehouseId: original.warehouseId,
          skuId: original.skuId,
          orderNo: 'R' + id.replaceAll('-', '').toUpperCase(),
          deliveryMode: original.deliveryMode,
          executionMode: original.executionMode,
          status: 'CANCELED',
          title: original.title,
          name: original.name,
          spec: original.spec,
          unit: original.unit,
          quantity: original.quantity,
          pointsPrice: original.pointsPrice,
          totalPoints: original.totalPoints,
          rewardVersion: original.rewardVersion,
          addressPayload: privacy.encrypt(original.userId, id, address),
          createdAt: original.createdAt,
          canceledAt: new Date(),
          version: 1,
        },
      });
      const allocation = {
        id: aid,
        orderId: id,
        positionId: a.positionId,
        warehouseId: a.warehouseId,
        skuId: a.skuId,
        lotId: a.lotId,
        quantity: original.quantity,
      };
      const reserveLedgerId = await orderReservationDelta(
        tx,
        allocation,
        false,
        randomUUID(),
        original.userId,
        'REDEMPTION',
      );
      const releaseLedgerId = await orderReservationDelta(
        tx,
        allocation,
        true,
        randomUUID(),
        original.userId,
        'REDEMPTION',
      );
      await tx.redemptionAllocation.create({
        data: { ...allocation, reserveLedgerId, releaseLedgerId },
      });
      await tx.pointsEntry.createMany({
        data: [
          {
            id: randomUUID(),
            userId: original.userId,
            delta: -original.totalPoints,
            actionKey: 'REDEMPTION:' + id,
            reason: '合成分页兑换扣除',
            consumerActorId: original.userId,
            redemptionId: id,
            redemptionAction: 'REDEEM',
          },
          {
            id: randomUUID(),
            userId: original.userId,
            delta: original.totalPoints,
            actionKey: 'REDEMPTION_CANCEL:' + id,
            reason: '合成分页取消退还',
            consumerActorId: original.userId,
            redemptionId: id,
            redemptionAction: 'CANCEL',
          },
        ],
      });
      await tx.redemptionOutbox.create({ data: { orderId: id, state: 'CANCELED' } });
      await tx.redemptionEvent.createMany({
        data: ['REDEMPTION_CREATED', 'REDEMPTION_CANCELED'].map((type) => ({
          id: randomUUID(),
          orderId: id,
          type,
          consumerActorId: original.userId,
          requestId: randomUUID(),
        })),
      });
    });
}
