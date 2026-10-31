import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Controller, Get, Module, Req } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { HealthResponse } from '@yumi/contracts';
import { createDatabase } from '@yumi/database';
import { applicationConfig } from './config.js';
import type { ApplicationConfig } from './config.js';
import { ApiExceptionFilter, failure, success } from './http.js';
import type { ApiRequest, ApiResponse } from './http.js';
import { StaffAuthService } from './staff-auth.js';
import { Public, StaffGuard } from './staff-guard.js';
import { StaffAdminController, StaffController, WarehouseController } from './staff-controller.js';
import { ApiResult, object, text } from './api-result.js';
import { InventoryController } from './inventory-controller.js';
import { InventoryService } from './inventory-service.js';
import { StockCountController } from './stock-count-controller.js';
import { StockCountService } from './stock-count-service.js';
import { StockDispositionService } from './stock-disposition-service.js';
import { StockDispositionController } from './stock-disposition-controller.js';
import { ReceiptReversalService } from './receipt-reversal-service.js';
import { ReceiptReversalController } from './receipt-reversal-controller.js';
import {
  ProductImageController,
  ProductImageService,
  LocalProductImageStore,
} from './product-images.js';
import { CatalogService } from './catalog-service.js';
import {
  CatalogAdminController,
  InboundController,
  PublicCatalogController,
  PublicCategoryController,
} from './catalog-controller.js';

export interface AccessEvent {
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
}

export async function createApplication(
  databaseUrl: string,
  options: { config?: ApplicationConfig; accessLog?: (event: AccessEvent) => void } = {},
): Promise<{
  app: INestApplication;
  db: ReturnType<typeof createDatabase>;
  openApi: OpenAPIObject;
  close(): Promise<void>;
}> {
  const db = createDatabase(databaseUrl);
  const config = options.config ?? applicationConfig();
  const auth = new StaffAuthService(db, config);
  const catalog = new CatalogService(db, config.publicWarehouseId);

  @Controller('health')
  class HealthController {
    @Public()
    @Get('live')
    @ApiResult(object({ status: text, service: text }), [500])
    live(@Req() request: ApiRequest): HealthResponse {
      return success(request, { status: 'ok', service: 'api' });
    }

    @Public()
    @Get('ready')
    @ApiResult(object({ status: text, service: text, database: text }), [500, 503])
    async ready(@Req() request: ApiRequest): Promise<HealthResponse> {
      try {
        await db.$queryRaw`SELECT 1`;
      } catch {
        throw failure(503, 'DATABASE_UNAVAILABLE', '数据库暂不可用');
      }
      return success(request, { status: 'ok', service: 'api', database: 'connected' });
    }
  }
  @Module({
    controllers: [
      HealthController,
      StaffController,
      WarehouseController,
      StaffAdminController,
      CatalogAdminController,
      ProductImageController,
      InboundController,
      PublicCatalogController,
      PublicCategoryController,
      InventoryController,
      StockCountController,
      StockDispositionController,
      ReceiptReversalController,
    ],
    providers: [
      { provide: StaffAuthService, useValue: auth },
      { provide: CatalogService, useValue: catalog },
      {
        provide: ProductImageService,
        useValue: new ProductImageService(
          catalog,
          new LocalProductImageStore(config.productImageRoot),
        ),
      },
      { provide: InventoryService, useValue: new InventoryService(catalog) },
      {
        provide: StockCountService,
        useValue: new StockCountService(new InventoryService(catalog)),
      },
      { provide: APP_GUARD, useValue: new StaffGuard(auth) },
      {
        provide: ReceiptReversalService,
        useValue: new ReceiptReversalService(new InventoryService(catalog)),
      },
      {
        provide: StockDispositionService,
        useValue: new StockDispositionService(new InventoryService(catalog)),
      },
    ],
  })
  class ApplicationModule {}

  const app = await NestFactory.create<NestExpressApplication>(ApplicationModule, {
    logger: ['error', 'warn'],
    bodyParser: false,
  });
  app.setGlobalPrefix('api/v1');
  app.use((request: ApiRequest, response: ApiResponse, next: () => void) => {
    const start = Date.now();
    request.requestId = randomUUID();
    response.setHeader('X-Request-ID', request.requestId);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.on('finish', () => {
      const event = {
        requestId: request.requestId,
        method: request.method,
        route: request.route?.path ?? 'unmatched',
        status: response.statusCode,
        durationMs: Date.now() - start,
      };
      if (options.accessLog) options.accessLog(event);
      else console.log(JSON.stringify(event));
    });
    next();
  });
  app.useBodyParser('json', { limit: config.environment === 'production' ? '100kb' : '3mb' });
  app.useGlobalFilters(new ApiExceptionFilter());
  const openApi = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('玉米百货 API')
      .setDescription(
        '员工认证、商品收货、库位移位、库存核对、实物盘点、隔离报损及收货逆向纠错；交易接口尚未实现。',
      )
      .setVersion('0.6.0')
      .addCookieAuth('yumi_staff_session', { type: 'apiKey', in: 'cookie' }, 'staffSession')
      .build(),
  );
  if (config.docsEnabled)
    SwaggerModule.setup('docs', app, openApi, {
      useGlobalPrefix: true,
      jsonDocumentUrl: '/openapi.json',
      swaggerOptions: { persistAuthorization: false },
    });
  return {
    app,
    db,
    openApi,
    async close() {
      await app.close();
      await db.$disconnect();
    },
  };
}
