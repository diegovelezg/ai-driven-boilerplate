# Deploy en Coolify v4: 3 recursos separados (Supabase + SearXNG + web)

Modelo "by the book". Nada de compose monolítico: cada pieza es un recurso
Coolify con su propio ciclo de deploy. Proyecto Coolify: `retention-ai-engine`
(environment `production`, servidor localhost, DNS `*.papelitosdecolor.com` → VPS).

| Recurso | Tipo Coolify | Dominio | Puerto interno |
|---|---|---|---|
| Supabase | Service (plantilla one-click `supabase`) | API: `https://retention-api.papelitosdecolor.com` (Kong) | 8000 |
| Supabase | mismo service | Studio: `https://studio.papelitosdecolor.com` | 3000 (+ Basic Auth del dominio) |
| SearXNG | Service (plantilla one-click `searxng`) | autogenerado `https://<id>.papelitosdecolor.com` (wildcard, sin pedir DNS) | 8080 |
| web | Application (repo git, build pack Dockerfile) | `https://retention.papelitosdecolor.com` | 3000 |

Postgres NO expone puerto público (la plantilla no publica 5432).

## 1. Service Supabase (one-click)

Coolify → proyecto `retention-ai-engine` → New → Service → `Supabase` → Deploy.

1. Sub-app `supabase-kong`, puerto 8000 → dominio
   `https://retention-api.papelitosdecolor.com`.
2. Sub-app `supabase-studio`, puerto 3000 → dominio
   `https://studio.papelitosdecolor.com` + **Basic Auth del dominio**
   (Domains → tu dominio → protección por contraseña). El Studio self-hosted
   no tiene login propio: sin esto queda abierto a internet.
3. Environment del service (valores con esquema `https://` incluido):
   - `API_EXTERNAL_URL=https://retention-api.papelitosdecolor.com`
   - `SUPABASE_PUBLIC_URL=https://retention-api.papelitosdecolor.com`
     (sin esquema, Studio devuelve 500 "You do not have access to this project")
   - `SITE_URL=https://retention.papelitosdecolor.com`
   - `GOTRUE_SITE_URL=https://retention.papelitosdecolor.com`
   - `ADDITIONAL_REDIRECT_URLS=https://retention.papelitosdecolor.com/**`
   - `DISABLE_SIGNUP=false`, `ENABLE_EMAIL_AUTOCONFIRM=true`
   - `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` (credencial del Basic Auth de Studio)
   - El resto (POSTGRES_PASSWORD, JWT_SECRET, ANON/SERVICE keys…) lo autogenera
     la plantilla. Redeploy para aplicar.
4. Anotar del environment del service (se usan en la web, paso 3):
   `SUPABASE_ANON_KEY` (o `SERVICE_SUPABASEANON_KEY`), `SUPABASE_SERVICE_KEY` /
   `SUPABASE_SERVICE_ROLE_KEY` y `JWT_SECRET`.

## 2. Service SearXNG (one-click)

Coolify → New → Service → `SearXNG` → Deploy. Verificar `/healthz` (la plantilla
ya trae `json` habilitado en `formats`).

La web lo consume por **URL HTTPS pública** (dominio autogenerado del service,
resuelve por wildcard sin pedir DNS):

- `SEARXNG_URL=https://<id>.papelitosdecolor.com` (sin `/` final; ver `web/lib/retrieval.ts`)
- Los services de Coolify viven en redes Docker distintas, así que no se asume
  resolución por hostname interno entre recursos.

## 3. Application web (Git + Dockerfile)

Coolify → New → Application → Public Repository:
`https://github.com/diegovelezg/retention-ai-engine`, rama `main`.

- Build Pack: `Dockerfile`. Base Directory: `/web`. Dockerfile Location: `/Dockerfile`. Port: `3000`.
- Dominio: `https://retention.papelitosdecolor.com`.
- Environment (runtime):

  ```
  SUPABASE_URL=https://retention-api.papelitosdecolor.com
  SUPABASE_ANON_KEY=<ANON del service, paso 1.4>
  SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE del service>
  NEXT_PUBLIC_SUPABASE_URL=https://retention-api.papelitosdecolor.com
  NEXT_PUBLIC_SUPABASE_ANON_KEY=<ANON del service>
  SECRETS_ENCRYPTION_KEY=<base64 32B: openssl rand -base64 32>
  SEARXNG_URL=<dominio https del service, paso 2>
  DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY (opcionales)
  ```

- `NEXT_PUBLIC_*` van **también como build-time** (Coolify: "Available at build
  time"): se inlinan en el bundle en `npm run build`. Todo cambio de URL o de
  ANON_KEY exige **rebuild sin caché** de la web.
- No tocar `web/Dockerfile` (standalone, ya ignora tracking con `web/.dockerignore`).

## 4. Esquema + datos (sin bind mounts)

La plantilla no corre `supabase/migrations/*.sql`: se aplican por stdin contra
el contenedor `supabase-db-<uuid>` (`docker exec -i -u postgres … psql`,
peer-auth, sin password y sin copiar archivos al VPS). Script local:
`/tmp/opencode/retain-apply.sh` (fuente versionada de esta sección):

```bash
export SSHPASS='<root VPS>' VPS_IP=46.225.73.40
DB_CONTAINER=supabase-db-<uuid> ./retain-apply.sh schema  # 42 migraciones en orden + tracking public.schema_migrations
DB_CONTAINER=supabase-db-<uuid> ./retain-apply.sh data    # public data-only (sin schema_migrations) + auth.users + auth.identities
DB_CONTAINER=supabase-db-<uuid> ./retain-apply.sh verify  # esperado: stores=1 customers=952 orders=699 merchant_users=0 auth.users=1 auth.identities=1
```

Notas:

- Cada migración corre con `SET search_path = public, extensions;` antepuesto
  (pgcrypto vive en `extensions`; el trigger de customers ya fija su search_path
  en `20261028000000_fix_input_hash_search_path.sql`).
- `--single-transaction -v ON_ERROR_STOP=1`: si una migración falla, rollback
  completo y se reintenta en la próxima pasada (tracking en `public.schema_migrations`).
- `public` no tiene secuencias (PKs UUID): no hace falta `setval`.
- No se migran sesiones (`auth.refresh_tokens`): solo users + identities.
- Dumps fuente (generados del CLI local, puerto 54322):
  `pg_dump --data-only --schema=public --exclude-table-data=public.schema_migrations`
  (1.2 MB, 24 tablas) + `--schema=auth --table=auth.users --table=auth.identities`.

## 5. Usuario login

`merchant_users` local está vacío: recrear el usuario y linkearlo.

Opción A (UI): Studio → Authentication → Users → Create user
(`diegovelezg@gmail.com` + clave), luego SQL editor:

```sql
insert into merchant_users (store_id, user_id)
values ('<store_id de public.stores>', '<auth_user_id>');
```

Opción B (reset de clave del usuario migrado, sin dejarla en git):

```sql
SET search_path = public, extensions;
UPDATE auth.users
   SET encrypted_password = crypt('<clave>', gen_salt('bf')), updated_at = now()
 WHERE email = 'diegovelezg@gmail.com';
```

## 6. Verificación (criterios de aceptación)

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://retention.papelitosdecolor.com/login   # 200
curl -sk https://retention-api.papelitosdecolor.com/auth/v1/health                       # GoTrue {"version":...}
curl -sk -o /dev/null -w '%{http_code}\n' https://studio.papelitosdecolor.com/           # 401 sin credencial, 200 con ella
curl -sk https://<searxng>/healthz
docker ps --format '{{.Names}} {{.Ports}}' | grep -i 5432   # Postgres sin puerto público
```

En la app: login con `diegovelezg@gmail.com` → `/customers` muestra **952**.
Probar una acción de enriquecimiento (usa `SEARXNG_URL`, `web/lib/retrieval.ts`).

Local sigue igual: `npx supabase start` → `http://127.0.0.1:54323`.

## 7. Si algo falla

- Login "Credenciales inválidas (…)" con detalle: el mensaje incluye el error
  real de GoTrue (`web/lib/auth-actions.ts`). Causas típicas: `NEXT_PUBLIC_*`
  horneadas con valores viejos (rebuild sin caché), `SUPABASE_PUBLIC_URL` sin
  `https://`, o usuario inexistente en la DB nueva (paso 5).
- Login redirige en loop: `SITE_URL` / `API_EXTERNAL_URL` /
  `ADDITIONAL_REDIRECT_URLS` deben ser los dominios públicos con `https`.
- `/customers` vacío: verificar conteos (paso 4 `verify`) y `merchant_users` linkeado.
- SearXNG 403/5xx: revisar `SEARXNG_SECRET` del service y `SEARXNG_URL` de la web.
- No tocar contenedores, volúmenes, redes ni proxy de otros proyectos; no correr
  `docker builder prune` global.
