import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { PrismaClient };
export function createDatabase(connectionString: string) {
  const adapter = new PrismaPg({ connectionString, max: 60, connectionTimeoutMillis: 5000 });
  return new PrismaClient({ adapter, log: ['warn'] });
}
