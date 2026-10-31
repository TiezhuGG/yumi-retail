ALTER TABLE product_images ADD COLUMN sort_order INTEGER CHECK (sort_order BETWEEN 0 AND 5);
CREATE UNIQUE INDEX product_images_product_id_sort_order_key ON product_images(product_id,sort_order);
-- Preserve the existing current cover, without reactivating historical objects.
UPDATE product_images i SET sort_order=0 FROM products p WHERE p.image_id=i.id AND p.id=i.product_id;
