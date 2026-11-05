import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Get, Header, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@yumi/database';
import type { RewardCart, RewardCartLine } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { CheckoutService } from './checkout.js';
import { Consumer } from './staff-guard.js';
import { fields, integer, key, uuid } from './catalog-input.js';
import { failure, success, type ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
type Tx = Prisma.TransactionClient;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function lines(value: unknown): RewardCartLine[] {
  if (!Array.isArray(value) || value.length > 20)
    throw failure(400, 'VALIDATION_ERROR', '购物车最多20种商品');
  const items = value
    .map((v) => {
      const b = fields(v, ['rewardId', 'quantity']);
      return { rewardId: uuid(b.rewardId), quantity: integer(b.quantity, 1, 100000) };
    })
    .sort((a, b) => a.rewardId.localeCompare(b.rewardId));
  if (new Set(items.map((i) => i.rewardId)).size !== items.length)
    throw failure(400, 'VALIDATION_ERROR', '商品不能重复');
  return items;
}
export class RewardCartService {
  readonly checkout: CheckoutService;
  constructor(readonly catalog: CatalogService) {
    this.checkout = new CheckoutService(catalog);
  }
  async identity(tx: Tx, r: ApiRequest) {
    const user = await this.checkout.session(tx, r);
    const valid = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT s.id FROM consumer_sessions s JOIN consumer_users u ON u.id=s.user_id WHERE s.id=${r.consumerContext!.sessionId}::uuid AND u.id=${user}::uuid AND u.enabled AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version`;
    if (!valid.length) throw failure(401, 'SESSION_EXPIRED', '登录已失效，请重新登录核实');
    return user;
  }
  async lock(tx: Tx, user: string): Promise<RewardCart> {
    await tx.$executeRaw`INSERT INTO reward_carts(user_id) VALUES(${user}::uuid) ON CONFLICT DO NOTHING`;
    await tx.$queryRaw`SELECT user_id FROM reward_carts WHERE user_id=${user}::uuid FOR UPDATE`;
    const cart = await tx.rewardCart.findUniqueOrThrow({ where: { userId: user } });
    return { version: cart.version, items: lines(cart.items) };
  }
  async save(
    tx: Tx,
    r: ApiRequest,
    user: string,
    cart: RewardCart,
    items: RewardCartLine[],
    action: string,
  ) {
    if (cart.version >= 2147483646)
      throw failure(409, 'CART_VERSION_EXHAUSTED', '购物车版本需要维护');
    const result = { version: cart.version + 1, items: lines(items) };
    await tx.rewardCart.update({
      where: { userId: user },
      data: {
        version: result.version,
        items: result.items.map((i) => ({ rewardId: i.rewardId, quantity: i.quantity })),
      },
    });
    await tx.rewardCartAudit.create({
      data: {
        id: randomUUID(),
        userId: user,
        version: result.version,
        action,
        requestId: r.requestId,
      },
    });
    return result;
  }
  async read(r: ApiRequest) {
    return this.catalog.db.$transaction(async (tx) => {
      const user = await this.identity(tx, r),
        cart = await tx.rewardCart.findUnique({ where: { userId: user } });
      await this.identity(tx, r);
      return cart ? { version: cart.version, items: lines(cart.items) } : { version: 0, items: [] };
    });
  }
  async write(r: ApiRequest, k: string, body: unknown) {
    const b = fields(body, ['action', 'version', 'items']);
    if (b.action !== 'REPLACE' && b.action !== 'MERGE')
      throw failure(400, 'VALIDATION_ERROR', '购物车操作无效');
    const action = b.action,
      version = integer(b.version, 0, 2147483646),
      items = lines(b.items);
    return this.catalog.db.$transaction(
      async (tx) => {
        const user = await this.identity(tx, r),
          cart = await this.lock(tx, user),
          scope = user + ':REWARD_CART',
          keyHash = hash(k),
          requestHash = hash({ action, version, items });
        const prior = await tx.idempotencyRecord.findUnique({
          where: { scope_keyHash: { scope, keyHash } },
        });
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw failure(409, 'IDEMPOTENCY_CONFLICT', '原购物车请求已变化，请保留原记录核实');
          await this.identity(tx, r);
          return prior.result as unknown as RewardCart;
        }
        if (cart.version !== version)
          throw failure(409, 'CART_VERSION_CONFLICT', '购物车已在其他设备更新，请重新读取后操作');
        const next = action === 'REPLACE' ? items : cart.items.map((i) => ({ ...i }));
        if (action === 'MERGE')
          for (const i of items) {
            const old = next.find((x) => x.rewardId === i.rewardId);
            if (old) old.quantity += i.quantity;
            else next.push(i);
          }
        // Unavailable references remain removable; saving never reserves inventory or points.
        if (next.length > 20 || next.some((i) => i.quantity > 100000))
          throw failure(409, 'CART_LIMIT_EXCEEDED', '导入后超过购物车技术容量，请先调整商品');
        const result = await this.save(tx, r, user, cart, next, action);
        await this.identity(tx, r);
        await tx.idempotencyRecord.create({
          data: { scope, keyHash, requestHash, result: JSON.parse(JSON.stringify(result)) },
        });
        return result;
      },
      { timeout: 15000 },
    );
  }
  async consume(tx: Tx, r: ApiRequest, user: string, purchased: RewardCartLine[]) {
    const cart = await this.lock(tx, user);
    const items = cart.items
      .map((i) => ({
        ...i,
        quantity: i.quantity - (purchased.find((x) => x.rewardId === i.rewardId)?.quantity ?? 0),
      }))
      .filter((i) => i.quantity > 0);
    if (JSON.stringify(items) !== JSON.stringify(cart.items))
      await this.save(tx, r, user, cart, items, 'CHECKOUT');
  }
}
const number = { type: 'integer' as const, minimum: 0, maximum: 2147483646 };
const items = {
  type: 'array' as const,
  maxItems: 20,
  items: object({ rewardId: text, quantity: { type: 'integer', minimum: 1, maximum: 100000 } }),
};
@ApiTags('积分账号购物车')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer/points-cart')
export class RewardCartController {
  constructor(@Inject(RewardCartService) readonly service: RewardCartService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiResult(object({ version: number, items }), [400, 401, 500])
  async read(@Req() r: ApiRequest, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.read(r));
  }
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiBody({
    schema: object({
      action: { type: 'string', enum: ['REPLACE', 'MERGE'] },
      version: number,
      items,
    }),
  })
  @ApiResult(object({ version: number, items }), [400, 401, 409, 500])
  async write(@Req() r: ApiRequest, @Query() q: unknown, @Body() b: unknown) {
    fields(q, []);
    return success(r, await this.service.write(r, key(r), b));
  }
}
