-- Limpieza NP: los textos libres de personas/intermediario quedan sin GUI
-- (todo sale de Empresas/Contactos vinculados) y sin escritores. Se eliminan
-- con blindaje por columna (política DROP seguro): vacía → DROP directo;
-- con dato → RENAME a _backup (el código ya no las referencia en ningún caso).
DO $$
DECLARE
  n int;
  col text;
  cols text[] := ARRAY[
    'contact_name', 'contact_phone', 'contact_email',
    'signer_name', 'signer_role', 'signer_email',
    'manager_name', 'manager_role', 'manager_email',
    'payment_contact',
    'intermediary_name', 'intermediary_tax_id'
  ];
BEGIN
  FOREACH col IN ARRAY cols LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.io_orders WHERE %I IS NOT NULL AND btrim(%I) <> ''''',
      col, col
    ) INTO n;
    IF n > 0 THEN
      EXECUTE format(
        'ALTER TABLE public.io_orders RENAME COLUMN %I TO %I',
        col, '_backup_20261219_' || col
      );
      RAISE NOTICE 'DROP diferido: % tiene % filas → _backup_20261219_%', col, n, col;
    ELSE
      EXECUTE format('ALTER TABLE public.io_orders DROP COLUMN %I', col);
    END IF;
  END LOOP;
END $$;
