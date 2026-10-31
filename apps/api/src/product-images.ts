import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiProduces,
  ApiResponse as SwaggerResponse,
  ApiTags,
} from '@nestjs/swagger';
import { productSchema } from './catalog-controller.js';
import { CatalogService, jsonValue } from './catalog-service.js';
import { fields, integer, key, uuid } from './catalog-input.js';
import { failure, success } from './http.js';
import type { ApiRequest, ApiResponse } from './http.js';
import { Permissions, Public } from './staff-guard.js';
import { ApiResult, object } from './api-result.js';

export interface ImageInput {
  version: number;
  image: { fileName: string; mime: string; base64: string } | null;
}
export function imageInput(value: unknown): ImageInput {
  const b = fields(value, ['version', 'image']);
  const version = integer(b.version, 0, 2147483646);
  if (b.image === null) return { version, image: null };
  const file = fields(b.image, ['fileName', 'mime', 'base64']);
  if (
    typeof file.fileName !== 'string' ||
    file.fileName.length > 120 ||
    /[\\/]/.test(file.fileName) ||
    Array.from(file.fileName).some((ch) => ch.charCodeAt(0) < 32) ||
    typeof file.base64 !== 'string' ||
    file.base64.length > 2796204 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)
  )
    throw failure(400, 'INVALID_IMAGE', '图片名称或内容无效，限2MB');
  if (
    !(
      (file.mime === 'image/png' && /\.png$/i.test(file.fileName)) ||
      (file.mime === 'image/jpeg' && /\.jpe?g$/i.test(file.fileName))
    )
  )
    throw failure(400, 'INVALID_IMAGE', '仅支持PNG/JPEG，扩展名须与类型一致');
  return {
    version,
    image: { fileName: file.fileName, mime: file.mime as string, base64: file.base64 },
  };
}

export function imageOrderInput(value: unknown) {
  const b = fields(value, ['version', 'imageIds']);
  const version = integer(b.version, 0, 2147483646);
  if (!Array.isArray(b.imageIds) || b.imageIds.length > 6)
    throw failure(400, 'INVALID_INPUT', '商品图片最多6张');
  const imageIds = b.imageIds.map(uuid);
  if (new Set(imageIds).size !== imageIds.length)
    throw failure(400, 'INVALID_INPUT', '图片不能重复');
  return { version, imageIds };
}
const gallerySchema = object({
  product: productSchema,
  images: {
    type: 'array',
    maxItems: 6,
    items: object({ id: { type: 'string' }, url: { type: 'string' } }),
  },
});

export interface ProductImageStore {
  ready(): void;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}
// Object keys are generated internally; this local adapter is disabled in production.
export class LocalProductImageStore implements ProductImageStore {
  constructor(readonly root?: string) {}
  ready() {
    if (!this.root) throw failure(503, 'IMAGE_STORAGE_UNAVAILABLE', '图片存储尚未配置');
  }
  path(key: string) {
    this.ready();
    if (!/^[a-f0-9-]{36}\.png$/.test(key)) throw Error('Invalid internal image key');
    return join(resolve(this.root!), key);
  }
  async put(key: string, data: Buffer) {
    this.ready();
    await mkdir(resolve(this.root!), { recursive: true });
    await writeFile(this.path(key), data, { flag: 'wx', mode: 0o600 });
  }
  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')
        throw failure(404, 'IMAGE_NOT_FOUND', '图片暂不可用');
      throw e;
    }
  }
  async remove(key: string) {
    await unlink(this.path(key));
  }
}
export class ProductImageService {
  private processing = 0;
  constructor(
    readonly catalog: CatalogService,
    readonly store: ProductImageStore,
  ) {}
  async normalize(file: NonNullable<ImageInput['image']>) {
    if (this.processing >= 2) throw failure(503, 'IMAGE_BUSY', '图片处理中，请用原操作重试');
    this.processing++;
    try {
      const bytes = Buffer.from(file.base64, 'base64');
      if (!bytes.length || bytes.length > 2097152 || bytes.toString('base64') !== file.base64)
        throw Error('invalid bytes');
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!(file.mime === 'image/png' ? png : jpeg)) throw Error('invalid header');
      const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 9000000 });
      const meta = await image.metadata();
      if (
        !['png', 'jpeg'].includes(meta.format ?? '') ||
        !meta.width ||
        !meta.height ||
        meta.width < 16 ||
        meta.height < 16 ||
        meta.width > 4096 ||
        meta.height > 4096 ||
        (meta.pages ?? 1) !== 1
      )
        throw Error('invalid dimensions/animation');
      const output = await image
        .rotate()
        .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      if (output.data.length > 4194304) throw Error('output too large');
      return output;
    } catch {
      throw failure(
        400,
        'INVALID_IMAGE',
        '图片无法解码；限PNG/JPEG、2MB、16–4096像素及900万像素以内的静态图片',
      );
    } finally {
      this.processing--;
    }
  }
  async gallery(id: string) {
    const product = await this.catalog.db.product.findUnique({
      where: { id },
      include: {
        skus: true,
        images: { where: { sortOrder: { not: null } }, orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!product) throw failure(404, 'RESOURCE_NOT_FOUND', '商品不存在');
    return jsonValue(this.galleryResult(product));
  }
  private galleryResult<T extends { id: string; images: { id: string }[] }>(product: T) {
    const { images, ...rest } = product;
    return {
      product: rest,
      images: images.map((i) => ({
        id: i.id,
        url: `/api/v1/admin/products/${product.id}/image/${i.id}`,
      })),
    };
  }
  async update(request: ApiRequest, id: string, operationKey: string, input: ImageInput) {
    return this.mutate(request, id, operationKey, input, 'PRODUCT_SET_IMAGE');
  }
  async add(request: ApiRequest, id: string, operationKey: string, input: ImageInput) {
    if (!input.image) throw failure(400, 'INVALID_IMAGE', '请选择图片');
    return this.mutate(request, id, operationKey, input, 'PRODUCT_ADD_IMAGE');
  }
  async arrange(
    request: ApiRequest,
    id: string,
    operationKey: string,
    input: ReturnType<typeof imageOrderInput>,
  ) {
    return this.mutate(request, id, operationKey, input, 'PRODUCT_SET_IMAGES');
  }
  private async mutate(
    request: ApiRequest,
    id: string,
    operationKey: string,
    input: ImageInput | ReturnType<typeof imageOrderInput>,
    action: string,
  ) {
    this.store.ready();
    let written: string | undefined;
    try {
      return await this.catalog.write(request, action, id, operationKey, input, async (tx) => {
        await tx.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR UPDATE`;
        const current = await tx.product.findUnique({
          where: { id },
          include: {
            images: { where: { sortOrder: { not: null } }, orderBy: { sortOrder: 'asc' } },
          },
        });
        if (!current) throw failure(404, 'RESOURCE_NOT_FOUND', '商品不存在');
        if (current.version !== input.version)
          throw failure(409, 'VERSION_CONFLICT', '商品已更新，请载入最新资料后重试');
        let ids = current.images.map((i) => i.id);
        if ('imageIds' in input) {
          if (input.imageIds.some((imageId) => !ids.includes(imageId)))
            throw failure(
              400,
              'INVALID_IMAGE_REFERENCE',
              '只能保留当前商品图片，不能恢复已移除或其他商品图片',
            );
          ids = input.imageIds;
        } else {
          if (action === 'PRODUCT_ADD_IMAGE' && ids.length >= 6)
            throw failure(409, 'IMAGE_LIMIT', '最多6张图片，请先移除再添加');
          // Legacy cover operations replace/remove only the first image, preserving the rest.
          if (action === 'PRODUCT_SET_IMAGE') ids = ids.slice(1);
          if (input.image) {
            const output = await this.normalize(input.image);
            const imageId = randomUUID(),
              objectKey = `${imageId}.png`;
            await this.store.put(objectKey, output.data);
            written = objectKey;
            await tx.productImage.create({
              data: {
                id: imageId,
                productId: id,
                objectKey,
                mime: 'image/png',
                bytes: output.data.length,
                width: output.info.width,
                height: output.info.height,
              },
            });
            if (action === 'PRODUCT_SET_IMAGE') ids.unshift(imageId);
            else ids.push(imageId);
          }
        }
        await tx.productImage.updateMany({
          where: { productId: id, sortOrder: { not: null } },
          data: { sortOrder: null },
        });
        for (const [sortOrder, imageId] of ids.entries())
          await tx.productImage.update({ where: { id: imageId }, data: { sortOrder } });
        const result = await tx.product.update({
          where: { id },
          data: { imageId: ids[0] ?? null, version: { increment: 1 } },
          include: {
            skus: true,
            images: { where: { sortOrder: { not: null } }, orderBy: { sortOrder: 'asc' } },
          },
        });
        await this.catalog.audit(
          tx,
          request,
          action,
          id,
          null,
          `version ${current.version}->${result.version}; images ${current.images.length}->${ids.length}`,
          { before: current.images.map((i) => i.id), after: ids },
        );
        const gallery = this.galleryResult(result);
        return action === 'PRODUCT_SET_IMAGE' ? gallery.product : gallery;
      });
    } catch (error) {
      if (written) {
        const key = written;
        try {
          if (!(await this.catalog.db.productImage.findUnique({ where: { objectKey: key } })))
            await this.store.remove(key);
        } catch {
          /* Preserve on unknown DB/cleanup outcome; reconcile local orphans later. */
        }
      }
      throw error;
    }
  }
  async read(id: string, imageId: string, publicRead: boolean) {
    this.store.ready();
    const product = await this.catalog.db.product.findUnique({
      where: { id },
      include: { category: { include: { parent: true } }, skus: true },
    });
    if (
      !product ||
      !(await this.catalog.db.productImage.findFirst({
        where: { id: imageId, productId: id, sortOrder: { not: null } },
      }))
    )
      throw failure(404, 'IMAGE_NOT_FOUND', '图片不存在或已移除');
    if (
      publicRead &&
      (product.status !== 'PUBLISHED' ||
        !product.category.enabled ||
        product.category.parent?.enabled === false ||
        !product.skus.some((s) => s.enabled) ||
        !this.catalog.publicWarehouseId ||
        !(await this.catalog.db.warehouse.findFirst({
          where: { id: this.catalog.publicWarehouseId, enabled: true },
        })))
    )
      throw failure(404, 'IMAGE_NOT_FOUND', '图片暂不可见');
    const image = await this.catalog.db.productImage.findUnique({ where: { id: imageId } });
    if (!image || image.productId !== id) throw failure(404, 'IMAGE_NOT_FOUND', '图片不存在');
    return this.store.get(image.objectKey);
  }
}
interface BinaryResponse extends ApiResponse {
  send(data: Buffer): void;
}
@ApiTags('商品图片')
@ApiCookieAuth('staffSession')
@Controller()
export class ProductImageController {
  constructor(@Inject(ProductImageService) private readonly service: ProductImageService) {}
  @Post('admin/products/:id/set-image')
  @HttpCode(200)
  @Permissions('catalog.write')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ summary: '本地开发首图替换/移除：其余图片保留，移除后下一张递补' })
  @ApiBody({
    schema: object({
      version: { type: 'integer', minimum: 0 },
      image: {
        ...object({
          fileName: { type: 'string' },
          mime: { type: 'string' },
          base64: { type: 'string' },
        }),
        nullable: true,
      },
    }),
  })
  @ApiResult(productSchema, [400, 401, 403, 404, 409, 413, 503, 500])
  async update(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return success(
      request,
      await this.service.update(request, uuid(id), key(request), imageInput(body)),
    );
  }
  @Get('admin/products/:id/images')
  @Permissions('catalog.read')
  @ApiOperation({ summary: '读取商品当前有序图片集及商品版本' })
  @ApiResult(gallerySchema, [400, 401, 403, 404, 500])
  async gallery(@Req() request: ApiRequest, @Param('id') id: string) {
    return success(request, await this.service.gallery(uuid(id)));
  }
  @Post('admin/products/:id/add-image')
  @HttpCode(200)
  @Permissions('catalog.write')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ summary: '添加一张商品图片，最多6张，按末尾追加' })
  @ApiBody({
    schema: object({
      version: { type: 'integer', minimum: 0 },
      image: object({
        fileName: { type: 'string' },
        mime: { type: 'string' },
        base64: { type: 'string' },
      }),
    }),
  })
  @ApiResult(gallerySchema, [400, 401, 403, 404, 409, 413, 503, 500])
  async add(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return success(
      request,
      await this.service.add(request, uuid(id), key(request), imageInput(body)),
    );
  }
  @Post('admin/products/:id/set-images')
  @HttpCode(200)
  @Permissions('catalog.write')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiOperation({ summary: '按当前图片子集保存顺序/移除，第一张成为主图；空数组全部移除' })
  @ApiBody({
    schema: object({
      version: { type: 'integer', minimum: 0 },
      imageIds: {
        type: 'array',
        maxItems: 6,
        uniqueItems: true,
        items: { type: 'string', format: 'uuid' },
      },
    }),
  })
  @ApiResult(gallerySchema, [400, 401, 403, 404, 409, 503, 500])
  async arrange(@Req() request: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    return success(
      request,
      await this.service.arrange(request, uuid(id), key(request), imageOrderInput(body)),
    );
  }
  @Get('admin/products/:id/image/:imageId')
  @ApiProduces('image/png')
  @SwaggerResponse({
    status: 200,
    description: 'PNG二进制，no-store及nosniff',
    content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
  })
  @Permissions('catalog.read')
  @ApiOperation({ summary: '读取当前图片集图片，草稿图片限员工读取' })
  async admin(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Res() response: BinaryResponse,
  ) {
    const data = await this.service.read(uuid(id), uuid(imageId), false);
    response.setHeader('Content-Type', 'image/png');
    response.send(data);
  }
  @Get('product-images/:id/:imageId')
  @ApiProduces('image/png')
  @SwaggerResponse({
    status: 200,
    description: 'PNG二进制，no-store及nosniff',
    content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
  })
  @Public()
  @ApiOperation({ summary: '仅公开当前公开商品图片集内的图片，移除后旧地址404' })
  async public(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Res() response: BinaryResponse,
  ) {
    const data = await this.service.read(uuid(id), uuid(imageId), true);
    response.setHeader('Content-Type', 'image/png');
    response.send(data);
  }
}
