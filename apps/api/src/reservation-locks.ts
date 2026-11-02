import { inventoryLocks, metadataLocks as lockMetadata } from '@yumi/database';
import type { Prisma } from '@yumi/database';
import { failure } from './http.js';
export { inventoryLocks };
export async function metadataLocks(tx: Prisma.TransactionClient, ids: string[]) {
  if (!(await lockMetadata(tx, ids))) throw failure(409, 'QUOTE_CHANGED', '商品已失效，请重新报价');
}
