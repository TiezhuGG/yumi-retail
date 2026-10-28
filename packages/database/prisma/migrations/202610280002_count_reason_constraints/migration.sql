BEGIN;
-- SQL CHECK accepts NULL; require explicit evidence for nullable reason columns.
ALTER TABLE stock_counts ADD CONSTRAINT count_review_reason_required CHECK (
  status NOT IN ('APPROVED','POSTED') OR (review_reason IS NOT NULL AND length(trim(review_reason))>0)
);
ALTER TABLE stock_counts ADD CONSTRAINT count_cancel_reason_required CHECK (
  status<>'CANCELLED' OR (cancel_reason IS NOT NULL AND length(trim(cancel_reason))>0)
);
COMMIT;
