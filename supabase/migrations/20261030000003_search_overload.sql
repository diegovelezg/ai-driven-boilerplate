-- Limpieza: la firma vieja de 3 args sobrevivió al create or replace
-- (PostgreSQL crea overload, no reemplaza) y PostgREST no desambigua.
-- Pareja de 20261030000002: aplicar inmediatamente después, misma ventana
-- de deploy (entre ambas, el rpc de 3 params falla por ambigüedad).
drop function if exists public.search_content_customers(uuid, text, int);
