-- The owner removed per-person and total redemption quotas.
-- Keep legacy columns and historical values for API/data compatibility.
-- All money, stock, idempotency, source and order consistency triggers stay active.
DROP TRIGGER redemption_quota_check ON redemption_orders;
DROP TRIGGER reward_quota_check ON reward_products;
DROP FUNCTION verify_redemption_quota();
