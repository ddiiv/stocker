-- Migración: SKU único por negocio (products) y por producto (product_variants).
-- Antes: sku era único GLOBAL → dos negocios no podían usar el mismo SKU.
-- Ahora: (businessId, sku) en products, (productId, sku) en product_variants.
--
-- Correr esto UNA VEZ contra la base existente. Es idempotente:
-- si el constraint viejo ya no existe, DROP tira warning pero sigue.

BEGIN;

-- ── PRODUCTS ──
ALTER TABLE products DROP CONSTRAINT IF EXISTS uq_products_sku;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sku_key;  -- por si postgres lo autogeneró con otro nombre

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_products_biz_sku'
    ) THEN
        ALTER TABLE products
        ADD CONSTRAINT uq_products_biz_sku UNIQUE ("businessId", sku);
    END IF;
END $$;

-- ── PRODUCT_VARIANTS ──
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS uq_variants_sku;
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_sku_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_variants_product_sku'
    ) THEN
        ALTER TABLE product_variants
        ADD CONSTRAINT uq_variants_product_sku UNIQUE ("productId", sku);
    END IF;
END $$;

COMMIT;
