-- Fuente: supabase/supabase (docker/volumes/db/jwt.sql), Apache-2.0.
-- Se ejecuta SOLO en la primera inicialización del volumen pgdata.
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
