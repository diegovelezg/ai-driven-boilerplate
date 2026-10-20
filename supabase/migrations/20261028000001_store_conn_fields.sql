-- Amplía store_secrets a campos de conexión no-secretos (issue #20, fase 2).
-- medusa_url/email viven cifrados en DB en prod: el JSON local es efímero en
-- contenedores (se pierde en cada redeploy) y puede no ser escribible (EACCES).
alter table public.store_secrets
  drop constraint store_secrets_key_name_check;

alter table public.store_secrets
  add constraint store_secrets_key_name_check
  check (key_name in (
    'medusa_token', 'shopify_token', 'email_api_key',
    'medusa_url', 'medusa_email'
  ));
