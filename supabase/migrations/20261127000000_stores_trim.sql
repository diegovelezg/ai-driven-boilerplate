-- sys_stores: poda de columnas legacy del ecommerce (Medusa).
-- platform ('medusa') y merchant_id: 0 lecturas en web/ (solo se mapeaban
-- al objeto TenantStore, nadie las consumía). shop_url: solo vivía como
-- fallback de display porque name venía vacío; el nombre propio pasa a ser
-- la única fuente (displayStoreName → name o "Mi tienda").
-- El UNIQUE(platform, shop_url) cae con las columnas (dependencia directa).
alter table sys_stores drop column if exists platform;
alter table sys_stores drop column if exists shop_url;
alter table sys_stores drop column if exists merchant_id;
