-- Fuente: supabase/supabase (docker/volumes/db/roles.sql), Apache-2.0,
-- adaptado: tolerante a roles inexistentes según imagen (17.11.0.004 no trae
-- supabase_functions_admin). Un ALTER fallido aquí ABORTA todo el init del
-- volumen fresco y la DB nunca levanta: por eso los DO con EXCEPTION.
-- Se ejecuta SOLO en la primera inicialización del volumen pgdata.
-- Sin esto, authenticator/supabase_auth_admin no tienen password y
-- postgrest/gotrue mueren con "password authentication failed".
-- NOTE: change to your own passwords for production environments
\set pgpass `echo "$POSTGRES_PASSWORD"`
-- :'pgpass' NO se sustituye dentro de bloques $$: se pasa vía setting.
SELECT set_config('app.init_pgpass', :'pgpass', false);

DO $$
BEGIN
  EXECUTE format('ALTER USER authenticator WITH PASSWORD %L', current_setting('app.init_pgpass'));
EXCEPTION WHEN undefined_object THEN
  RAISE WARNING 'role authenticator no existe, skip';
END $$;
DO $$
BEGIN
  EXECUTE format('ALTER USER pgbouncer WITH PASSWORD %L', current_setting('app.init_pgpass'));
EXCEPTION WHEN undefined_object THEN
  RAISE WARNING 'role pgbouncer no existe, skip';
END $$;
DO $$
BEGIN
  EXECUTE format('ALTER USER supabase_auth_admin WITH PASSWORD %L', current_setting('app.init_pgpass'));
EXCEPTION WHEN undefined_object THEN
  RAISE WARNING 'role supabase_auth_admin no existe, skip';
END $$;
DO $$
BEGIN
  EXECUTE format('ALTER USER supabase_functions_admin WITH PASSWORD %L', current_setting('app.init_pgpass'));
EXCEPTION WHEN undefined_object THEN
  RAISE WARNING 'role supabase_functions_admin no existe, skip';
END $$;
DO $$
BEGIN
  EXECUTE format('ALTER USER supabase_storage_admin WITH PASSWORD %L', current_setting('app.init_pgpass'));
EXCEPTION WHEN undefined_object THEN
  RAISE WARNING 'role supabase_storage_admin no existe, skip';
END $$;
