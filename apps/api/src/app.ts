import { DeliveryLabController, DeliveryLabService } from './delivery-lab.js';
import { PickingPackingController, PickingPackingService } from './picking-packing.js';
import { PickingShortageController, PickingShortageService } from './picking-shortage.js';
import { PickingLabController, PickingLabService } from './picking-lab.js';
import { PickingReadinessController, PickingReadinessService } from './picking-readiness.js';
import { PaymentAdapterLabController, PaymentAdapterLabService } from './payment-adapter-lab.js';
import 'reflect-metadata';
import { PaymentReviewLabController, PaymentReviewLabService } from './payment-review-lab.js';
import { PaymentAttemptLabController, PaymentAttemptLabService } from './payment-attempt-lab.js';
import { PaymentCloseLabController, PaymentCloseLabService } from './payment-close-lab.js';
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
import { ConsumerAuthService, validateConsumerEnvironment } from './consumer-auth.js';
import { ConsumerController } from './consumer-controller.js';
import { PaymentPreparationService, PaymentPreparationController } from './payment-preparation.js';
import { PaymentReadinessController, PaymentReadinessService } from './payment-readiness.js';
import { paymentConfiguration } from './payment-config.js';
import {
  NotificationRecordsController,
  NotificationRecordsService,
} from './notification-records.js';
import { NotificationLabController, NotificationLabService } from './notification-lab.js';
import { OrderService } from './orders.js';
import { AdminOrderController, AdminOrderService } from './admin-orders.js';
import { OrderController } from './order-controller.js';
import { CheckoutService } from './checkout.js';
import {
  CheckoutController,
  CheckoutPolicyController,
  StoreController,
} from './checkout-controller.js';
import { ConsumerAddressController } from './consumer-address-controller.js';
import { ConsumerAddressService } from './consumer-address.js';
import { ConsumerCartController } from './consumer-cart-controller.js';
import { ConsumerCartService } from './consumer-cart.js';
import { ServiceAreaService } from './service-area.js';
import {
  ServiceAreaAdminController,
  PublicServiceAreaController,
} from './service-area-controller.js';
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
  PublicProductCardController,
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
  const config = options.config ?? applicationConfig();
  validateConsumerEnvironment(databaseUrl, config);
  if (config.orderDevSubmit || config.notificationLabEnabled) {
    const url = new URL(databaseUrl);
    if (
      config.environment === 'production' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !['/yumi_dev', '/yumi_test'].includes(url.pathname)
    )
      throw new Error('Development order submission requires local isolated database.');
  }
  const db = createDatabase(databaseUrl);
  const auth = new StaffAuthService(db, config);
  const consumer = new ConsumerAuthService(db, config);
  const catalog = new CatalogService(db, config.publicWarehouseId);
  const checkout = new CheckoutService(catalog, config.orderDevSubmit);
  const addresses = new ConsumerAddressService(catalog, config.addressEncryptionKey);

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
      ConsumerController,
      ConsumerCartController,
      OrderController,
      PaymentReadinessController,
      NotificationLabController,
      PaymentAdapterLabController,
      PaymentCloseLabController,
      PaymentAttemptLabController,
      PaymentReviewLabController,
      NotificationRecordsController,
      PaymentPreparationController,
      AdminOrderController,
      PickingReadinessController,
      PickingLabController,
      PickingShortageController,
      PickingPackingController,
      DeliveryLabController,
      ConsumerAddressController,
      CheckoutController,
      CheckoutPolicyController,
      StoreController,
      ServiceAreaAdminController,
      PublicServiceAreaController,
      StaffController,
      WarehouseController,
      StaffAdminController,
      CatalogAdminController,
      ProductImageController,
      InboundController,
      PublicCatalogController,
      PublicCategoryController,
      PublicProductCardController,
      InventoryController,
      StockCountController,
      StockDispositionController,
      ReceiptReversalController,
    ],
    providers: [
      { provide: StaffAuthService, useValue: auth },
      { provide: ConsumerAuthService, useValue: consumer },
      {
        provide: ConsumerAddressService,
        useValue: addresses,
      },
      { provide: ConsumerCartService, useValue: new ConsumerCartService(catalog) },
      { provide: CheckoutService, useValue: checkout },
      {
        provide: OrderService,
        useValue: new OrderService(
          checkout,
          addresses,
          config.addressEncryptionKey,
          config.orderDevHoldSeconds,
        ),
      },
      {
        provide: PaymentReadinessService,
        useValue: new PaymentReadinessService(
          catalog,
          config.paymentConfiguration ?? paymentConfiguration({}),
        ),
      },
      {
        provide: NotificationLabService,
        useValue: new NotificationLabService(catalog, config.notificationLabEnabled),
      },
      {
        provide: NotificationRecordsService,
        useValue: new NotificationRecordsService(catalog, config.notificationLabEnabled),
      },
      {
        provide: PaymentAdapterLabService,
        useValue: new PaymentAdapterLabService(catalog, config.notificationLabEnabled),
      },
      {
        provide: PaymentCloseLabService,
        useValue: new PaymentCloseLabService(catalog, config.notificationLabEnabled),
      },
      {
        provide: PaymentAttemptLabService,
        useValue: new PaymentAttemptLabService(catalog, config.notificationLabEnabled),
      },
      {
        provide: PaymentReviewLabService,
        useValue: new PaymentReviewLabService(catalog, config.notificationLabEnabled),
      },
      { provide: PaymentPreparationService, useValue: new PaymentPreparationService(checkout) },
      {
        provide: PickingPackingService,
        useValue: new PickingPackingService(catalog, config.pickingLabEnabled),
      },
      {
        provide: PickingShortageService,
        useValue: new PickingShortageService(catalog, config.pickingLabEnabled),
      },
      {
        provide: DeliveryLabService,
        useValue: new DeliveryLabService(catalog, config.pickingLabEnabled),
      },
      {
        provide: PickingLabService,
        useValue: new PickingLabService(catalog, config.pickingLabEnabled),
      },
      { provide: PickingReadinessService, useValue: new PickingReadinessService(catalog) },
      { provide: AdminOrderService, useValue: new AdminOrderService(catalog) },
      { provide: CatalogService, useValue: catalog },
      { provide: ServiceAreaService, useValue: new ServiceAreaService(catalog) },
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
      { provide: APP_GUARD, useValue: new StaffGuard(auth, consumer) },
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
        '员工认证、本机开发消费者会话、账号购物车与游客幂等合并、服务范围与本人收货地址、结算核验及报价、商品收货、库位移位、库存核对、实物盘点、隔离报损及收货逆向纠错；本机开发订单与预占、后台订单只读查询已实现；微信登录与支付未实现。',
      )
      .setVersion('0.33.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'consumerSession')
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
