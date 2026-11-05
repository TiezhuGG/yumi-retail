-- CHECK expressions treat NULL as unknown; require every physical-receipt field explicitly.
ALTER TABLE redemption_return_events ADD CONSTRAINT redemption_return_receipt_fields
CHECK(kind<>'RECEIVE' OR (quantity IS NOT NULL AND quantity>0 AND condition IS NOT NULL AND condition IN ('UNOPENED','DAMAGED','WRONG_ITEM') AND location IS NOT NULL AND length(trim(location))>0));
