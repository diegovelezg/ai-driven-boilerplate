-- Fuente: supabase/supabase (docker/volumes/db/roles.sql), Apache-2.0.
-- Se ejecuta SOLO en la primera inicialización del volumen pgdata.
-- Sin esto, authenticator/supabase_auth_admin no tienen password y
-- postgrest/gotrue mueren con "password authentication failed".
-- NOTE: change to your own passwords for production environments
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_functions_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
