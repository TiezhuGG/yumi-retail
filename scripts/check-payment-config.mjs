import {
  assertDisabledPaymentMode,
  paymentConfiguration,
} from '../apps/api/dist/payment-config.js';
try {
  assertDisabledPaymentMode(process.env);
  const checks = paymentConfiguration(process.env);
  console.log(JSON.stringify({ channel: 'DISABLED', canStartPayment: false, checks }, null, 2));
  if (checks.some((c) => c.status === 'INVALID')) process.exitCode = 1;
} catch {
  console.error('Only PAYMENT_MODE=disabled is supported. No configuration values were printed.');
  process.exitCode = 1;
}
