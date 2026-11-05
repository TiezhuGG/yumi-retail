import type { WorkspaceView } from './workspace.js';

// A consistent line-icon vocabulary for the atlas navigation.
const paths = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  bag: 'M5 8h14l1 13H4L5 8Zm3 0V6a4 4 0 0 1 8 0v2',
  list: 'M5 3h14v18H5V3Zm4 5h6M9 12h6M9 16h4',
  account: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-3a8 8 0 0 1 16 0v3',
  check: 'm5 12 4 4L19 6',
  box: 'm3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v10M8 5l9 4',
  grid: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z',
  pin: 'M19 9c0 6-7 12-7 12S5 15 5 9a7 7 0 1 1 14 0Zm-4 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  alert: 'M12 8v5m0 4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  truck:
    'M2 5h12v12H2V5Zm12 4h4l4 5v3h-8V9ZM8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm12 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  wallet: 'M3 5h17v15H3V5Zm0 0V3h15v2m-3 6h6v5h-6v-5Zm2 2h.01',
  history: 'M3 10a9 9 0 1 1 2 8M3 4v6h6m3-4v6l4 2',
  receive: 'M4 14v7h16v-7M12 3v13m-5-5 5 5 5-5',
  shield: 'm12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Zm-4 10 3 3 5-6',
};
const icons: Record<WorkspaceView, keyof typeof paths> = {
  overview: 'home',
  products: 'bag',
  categories: 'grid',
  stock: 'box',
  receipts: 'receive',
  locations: 'grid',
  counts: 'check',
  dispositions: 'alert',
  reversals: 'history',
  'service-area': 'pin',
  'checkout-policy': 'wallet',
  orders: 'list',
  points: 'account',
  'points-grants': 'check',
  'points-corrections': 'history',
  rewards: 'bag',
  redemptions: 'list',
  'redemption-after-sales': 'alert',
  'express-readiness': 'shield',
  'redemption-delivery': 'truck',
  'redemption-picking': 'box',
  'delivery-lab': 'truck',
  'picking-lab': 'box',
  'picking-readiness': 'check',
  'payment-readiness': 'shield',
  'notification-lab': 'shield',
  'notification-records': 'list',
  'payment-adapter-lab': 'wallet',
  'payment-close-lab': 'shield',
  'payment-attempt-lab': 'wallet',
  'payment-review-lab': 'history',
};
export function NavIcon({ view }: { view: WorkspaceView }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[icons[view]]} />
    </svg>
  );
}
