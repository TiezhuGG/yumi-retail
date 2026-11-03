import type { RedemptionOrderAddress } from '../../../packages/contracts/src/index';
export function formatRedemptionAddress(a: RedemptionOrderAddress): string {
  return 'province' in a
    ? [a.province, a.city, a.district, a.detailAddress].filter(Boolean).join(' ')
    : [a.areaName, a.buildingName, a.unit, a.room].filter(Boolean).join(' ');
}
