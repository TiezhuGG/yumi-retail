import type { Prisma } from '@yumi/database';
import type { RedemptionExpressShipmentView } from '@yumi/contracts';
export const expressShipmentInclude = {
  include: { receipt: true, corrections: { orderBy: { version: 'desc' as const } } },
} as const;
export function expressShipmentView(
  s: Prisma.RedemptionExpressShipmentGetPayload<typeof expressShipmentInclude> | null,
): RedemptionExpressShipmentView | null {
  if (!s) return null;
  const latest = s.corrections[0] ?? s;
  return {
    carrierCode: latest.carrierCode,
    carrierName: latest.carrierName,
    trackingNo: latest.trackingNo,
    shippedAt: s.createdAt.toISOString(),
    receivedAt: s.receipt?.confirmedAt.toISOString() ?? null,
    correctionVersion: s.corrections[0]?.version ?? 0,
    correctedAt: s.corrections[0]?.createdAt.toISOString() ?? null,
  };
}
