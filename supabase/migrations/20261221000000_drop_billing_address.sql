-- La dirección del facturador vive en la empresa (crm_companies.address) y es
-- solo lectura en la orden: la columna queda sin escritores ni GUI.
-- Blindaje por política DROP seguro: con dato → _backup, vacía → DROP.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
  FROM public.io_orders
  WHERE billing_address IS NOT NULL AND btrim(billing_address) <> '';
  IF n > 0 THEN
    ALTER TABLE public.io_orders RENAME COLUMN billing_address TO _backup_20261221_billing_address;
    RAISE NOTICE 'DROP diferido: billing_address tiene % filas → _backup', n;
  ELSE
    ALTER TABLE public.io_orders DROP COLUMN billing_address;
  END IF;
END $$;
