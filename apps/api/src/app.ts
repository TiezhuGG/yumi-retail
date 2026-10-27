import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Controller, Get, HttpException, HttpStatus, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { HealthResponse } from '@yumi/contracts';
import { createDatabase } from '@yumi/database';

export async function createApplication(databaseUrl: string): Promise<{
  app: INestApplication;
  db: ReturnType<typeof createDatabase>;
  close(): Promise<void>;
}> {
  const db = createDatabase(databaseUrl);

  @Controller('health')
  class HealthController {
    @Get('live')
    live(): HealthResponse {
      return { data: { status: 'ok', service: 'api' }, requestId: randomUUID() };
    }

    @Get('ready')
    async ready(): Promise<HealthResponse> {
      try { await db.$queryRaw`SELECT 1`; }
      catch { throw new HttpException({ error: { code: 'DATABASE_UNAVAILABLE', message: 'Service is not ready' }, requestId: randomUUID() }, HttpStatus.SERVICE_UNAVAILABLE); }
      return { data: { status: 'ok', service: 'api', database: 'connected' }, requestId: randomUUID() };
    }
  }
  @Module({ controllers: [HealthController] })
  class ApplicationModule {}

  const app = await NestFactory.create(ApplicationModule, { logger: ['error', 'warn'] });
  app.setGlobalPrefix('api/v1');
  return { app, db, async close() { await app.close(); await db.$disconnect(); } };
}
