import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { PrismaClient };
export { Prisma } from './generated/prisma/client.js';
export { hashPassword, verifyPassword } from './password.js';
export function createDatabase(connectionString: string) {
  const parsed = new URL(connectionString);
  const schema = parsed.searchParams.get('schema') ?? 'public';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid PostgreSQL schema.');
  parsed.searchParams.delete('schema');
  const adapter = new PrismaPg(
    {
      connectionString: parsed.toString(),
      max: 60,
      connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema}`,
    },
    { schema },
  );
  return new PrismaClient({ adapter, log: ['warn'] });
}
