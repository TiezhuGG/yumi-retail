-- Existing SKUs remain unbound; nullable unique index permits multiple NULLs.
ALTER TABLE skus ADD COLUMN barcode VARCHAR(64);
ALTER TABLE skus ADD CONSTRAINT skus_barcode_format CHECK (barcode IS NULL OR barcode ~ '^[0-9]{1,64}$');
CREATE UNIQUE INDEX skus_barcode_key ON skus(barcode);
