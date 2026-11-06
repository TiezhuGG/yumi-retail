import { createHash, randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@yumi/database';
import type { CustomerNotesPage } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { PointsGrantService } from './points-grants.js';
import { OrderPrivateData } from './order-private.js';
import { fields, key, str, uuid } from './catalog-input.js';
import { failure, success, type ApiRequest } from './http.js';
import { Permissions } from './staff-guard.js';
import { ApiResult, object, text } from './api-result.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export class CustomerNotesService {
  readonly auth: PointsGrantService;
  readonly privateData: OrderPrivateData;
  constructor(
    readonly catalog: CatalogService,
    readonly encryptionKey?: string,
  ) {
    this.auth = new PointsGrantService(catalog);
    this.privateData = new OrderPrivateData(encryptionKey);
  }
  private storage() {
    if (!this.encryptionKey)
      throw failure(503, 'CUSTOMER_NOTES_UNAVAILABLE', '内部备注加密存储尚未配置');
  }
  async create(r: ApiRequest, id: string, requestKey: string, body: unknown) {
    const b = fields(body, ['message', 'scopeId']),
      message = str(b.message, 500),
      expectedScope = uuid(b.scopeId);
    if (
      Array.from(message).some(
        (c) => (c.charCodeAt(0) < 32 && c !== '\n') || c.charCodeAt(0) === 127,
      )
    )
      throw failure(400, 'VALIDATION_ERROR', '备注包含无效字符');
    try {
      return await this.catalog.db.$transaction(
        async (tx) => {
          const warehouseId = await this.auth.authorize(r, tx);
          if (warehouseId !== expectedScope)
            throw failure(409, 'SCOPE_CHANGED', '经营仓范围已变化，请核对原备注后重新读取');
          const scope = r.staffContext!.staffId + ':CUSTOMER_NOTE:' + warehouseId + ':' + id,
            keyHash = hash(requestKey),
            requestHash = hash(JSON.stringify({ message, scopeId: expectedScope }));
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope + ':' + keyHash},0))::text`;
          const previous = await tx.idempotencyRecord.findUnique({
            where: { scope_keyHash: { scope, keyHash } },
          });
          if (previous) {
            if (previous.requestHash !== requestHash)
              throw failure(409, 'IDEMPOTENCY_CONFLICT', '原备注内容已改变，请使用原请求核实');
            await this.auth.authorize(r, tx);
            return previous.result;
          }
          const users = await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM consumer_users WHERE id=${id}::uuid FOR KEY SHARE`;
          if (!users.length) throw failure(404, 'CUSTOMER_NOT_FOUND', '顾客不存在');
          this.storage();
          const noteId = randomUUID(),
            payload = this.privateData.encrypt(id, 'customer-note:' + warehouseId + ':' + noteId, {
              message,
            });
          const actor = await tx.staff.findUniqueOrThrow({
              where: { id: r.staffContext!.staffId },
              select: { displayName: true },
            }),
            now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!
              .now;
          await tx.businessAudit.create({
            data: {
              id: noteId,
              actorId: r.staffContext!.staffId,
              resourceId: id,
              warehouseId,
              action: 'CUSTOMER_NOTE_ADDED',
              reason: '新增顾客内部备注',
              details: { payload, actorName: actor.displayName },
              createdAt: now,
              requestId: r.requestId,
            },
          });
          await this.auth.authorize(r, tx);
          const result = { id: noteId };
          await tx.idempotencyRecord.create({ data: { scope, keyHash, requestHash, result } });
          return result;
        },
        { timeout: 15000, maxWait: 10000 },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(e.code))
        throw failure(503, 'RETRYABLE_CONFLICT', '并发变化，请使用原备注请求重试');
      throw e;
    }
  }
  async list(r: ApiRequest, id: string, query: unknown): Promise<CustomerNotesPage> {
    const q = fields(query, ['cursor']),
      cursor = q.cursor === undefined ? null : uuid(q.cursor);
    return this.catalog.db.$transaction(
      async (tx) => {
        const warehouseId = await this.auth.authorize(r, tx);
        if (!(await tx.consumerUser.findUnique({ where: { id }, select: { id: true } })))
          throw failure(404, 'CUSTOMER_NOT_FOUND', '顾客不存在');
        const where = { resourceId: id, warehouseId, action: 'CUSTOMER_NOTE_ADDED' };
        const anchor = cursor
          ? await tx.businessAudit.findFirst({ where: { ...where, id: cursor } })
          : null;
        if (cursor && !anchor) throw failure(409, 'CURSOR_INVALID', '备注分页位置无效，请刷新记录');
        const rows = await tx.businessAudit.findMany({
          where: {
            ...where,
            ...(anchor
              ? {
                  OR: [
                    { createdAt: { lt: anchor.createdAt } },
                    { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                  ],
                }
              : {}),
          },
          include: { actor: { select: { displayName: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 21,
        });
        const items = rows.slice(0, 20).map((row) => {
          this.storage();
          const details = row.details as { payload?: string; actorName?: string } | null;
          try {
            if (typeof details?.payload !== 'string') throw Error('Invalid note');
            const value = this.privateData.decrypt<{ message: string }>(
              id,
              'customer-note:' + warehouseId + ':' + row.id,
              details.payload,
            );
            if (typeof value.message !== 'string') throw Error('Invalid note');
            return {
              id: row.id,
              message: value.message,
              actorName: details.actorName ?? row.actor.displayName,
              createdAt: row.createdAt.toISOString(),
            };
          } catch {
            throw failure(
              503,
              'CUSTOMER_NOTES_UNREADABLE',
              '内部备注暂时无法读取，请核对服务端加密配置后重试',
            );
          }
        });
        await this.auth.authorize(r, tx);
        return { scopeId: warehouseId, items, nextCursor: rows.length > 20 ? rows[19]!.id : null };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
  }
}
@ApiTags('顾客内部备注')
@ApiCookieAuth('staffSession')
@Controller('admin/customers/:id/notes')
export class CustomerNotesController {
  constructor(@Inject(CustomerNotesService) readonly service: CustomerNotesService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Permissions('points.read')
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      scopeId: text,
      items: {
        type: 'array',
        maxItems: 20,
        items: object({ id: text, message: text, actorName: text, createdAt: text }),
      },
      nextCursor: { ...text, nullable: true },
    }),
    [400, 401, 403, 404, 409, 500, 503],
  )
  async list(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    return success(r, await this.service.list(r, uuid(id), q));
  }
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Permissions('points.write')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({ scopeId: text, message: { ...text, minLength: 1, maxLength: 500 } }),
  })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async create(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Query() q: unknown,
    @Body() b: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.create(r, uuid(id), key(r), b));
  }
}
