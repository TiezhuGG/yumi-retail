export interface OrderIntent {
  version: 1;
  userId: string;
  quoteId: string;
  key: string;
  orderId?: string;
}
const uuid = (v: unknown) =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export function parseOrderIntent(raw: unknown): OrderIntent | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw Error('下单记录无法读取，请保留记录并核实本人订单');
  const v = raw as OrderIntent;
  if (
    v.version !== 1 ||
    !uuid(v.userId) ||
    !uuid(v.quoteId) ||
    !uuid(v.key) ||
    (v.orderId !== undefined && !uuid(v.orderId))
  )
    throw Error('下单记录无法读取，请保留记录并核实本人订单');
  return { ...v };
}
export class OrderIntentRejection extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function orderSubmission(io: {
  read: () => unknown;
  write: (v: OrderIntent) => void;
  newKey: () => string;
  send: (v: OrderIntent) => Promise<{ id: string }>;
}) {
  let running = false;
  return {
    async submit(userId: string, quoteId: string) {
      if (running) throw Error('正在确认同一笔下单操作');
      running = true;
      try {
        let pending = parseOrderIntent(io.read());
        if (pending && pending.userId !== userId)
          throw Error('有其他账号的下单操作待确认，请恢复原账号核实');
        if (!pending) {
          pending = { version: 1, userId, quoteId, key: io.newKey() };
          io.write(pending);
        }
        if (pending.orderId) return pending.orderId;
        const result = await io.send(pending);
        if (!uuid(result.id)) throw Error('下单响应无法核验，请用原操作重试');
        io.write({ ...pending, orderId: result.id });
        return result.id;
      } finally {
        running = false;
      }
    },
  };
}
