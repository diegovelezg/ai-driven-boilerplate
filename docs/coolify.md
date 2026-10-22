# Deploy en Coolify v4: 3 recursos separados (Supabase + SearXNG + web) + 1 Scheduled Task
#
# Sin recurso worker: el cron corre one-shot dentro del contenedor web
# (la imagen ya trae `worker.ts` + `lib/` + `node_modules`, ver `web/Dockerfile`).
# El daemon interno (`WORKER_SCHEDULE=1`) queda como modo alterno en código,
# apagado por default; prod usa cron externo.

Modelo "by the book". Nada de compose monolítico: cada pieza es un recurso
Coolify con su propio ciclo de deploy. Proyecto Coolify: `retention-ai-engine`
(environment `production`, servidor localhost, DNS `*.papelitosdecolor.com` → VPS).

| Recurso | Tipo Coolify | Dominio | Puerto interno |
|---|---|---|---|
| Supabase lean (§1b: 7 sub-apps) | Service (plantilla one-click `supabase`) | API: `https://retention-api.papelitosdecolor.com` (Kong) | 8000 |
| Supabase | mismo service | Studio: `https://retention-studio.papelitosdecolor.com` | 3000 (activar Basic Auth del dominio, pendiente §1.2) |
| SearXNG | Service (plantilla one-click `searxng`) | autogenerado `https://<id>.papelitosdecolor.com` (wildcard, sin pedir DNS) | 8080 |
| web | Application (repo git, build pack Dockerfile) | `https://retention.papelitosdecolor.com` | 3000 |
| cron diario | Scheduled Task sobre `web` (ver 3b) | — | — |

Postgres NO expone puerto público (la plantilla no publica 5432).

¿Por qué dos dominios? No basta con Studio. Son piezas distintas:

- `retention-api` (Kong) = el **backend**: la app `web` y cualquier cliente
  leen/escriben ahí (`/rest/v1/`, `/auth/v1/`, `/realtime/v1/`). Sin este
  dominio la app no tiene datos.
- `retention-studio` = **panel visual solo para humanos** (mirar/editar
  tablas a mano). La app jamás lo usa.

Cada dominio va en su sub-app (Kong→8000, Studio→3000). Si ambos apuntan a
Kong, el dominio de Studio solo duplica la API y el panel queda inaccesible
(eso pasó el 2026-10-21 y se corrigió moviendo el dominio en Domains).

## 1. Service Supabase (one-click)

Coolify → proyecto `retention-ai-engine` → New → Service → `Supabase` → Deploy.

1. Sub-app `supabase-kong`, puerto 8000 → dominio
   `https://retention-api.papelitosdecolor.com`.
2. Sub-app `supabase-studio`, puerto 3000 → dominio
   `https://retention-studio.papelitosdecolor.com` + **Basic Auth del dominio**
   (Domains → tu dominio → protección por contraseña). El Studio self-hosted
   no tiene login propio: sin esto queda abierto a internet.
   **Pendiente (2026-10-21): hoy NO tiene Basic Auth** (responde 307 sin
   credencial). Activarlo y anotar usuario/clave fuera de git.
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

## 1b. Supabase lean (7 de 15 sub-apps, aplicado 2026-10-21)

El stack one-click trae 15 sub-apps y ~1.5 GB solo para existir. Para el MVP
bastan 7 (**~740 MB** medidos: kong 187 + studio 186 + realtime 142 + db 109
+ meta 65 + rest 33 + auth 19):

- Se quedan: `db`, `rest`, `auth`, `realtime-dev`, `meta`, `kong`, `studio`.
- Fuera: `storage` + `minio` + `minio-createbucket` (sin uploads S3),
  `edge-functions` (lógica en la web/worker, no Deno), `analytics` + `vector`
  (logs vía `docker logs`), `supavisor` (Postgres directo aguanta ~100
  conexiones; picos reales <20), `imgproxy` (sin transforms por URL).

Ajustes que acompañan al recorte (ya aplicados):

- `PGRST_DB_SCHEMAS=public,graphql_public` (sin `storage`) en `rest` y `studio`.
- `NEXT_PUBLIC_ENABLE_LOGS=false` en `studio` + fuera `LOGFLARE_*`,
  `EDGE_FUNCTIONS_MANAGEMENT_FOLDER` y su volumen.
- Kong responde `503` en `/storage/v1/*` y `/functions/v1/*` (rutas huérfanas
  en `kong.yml`, inofensivas). Queda pendiente limpiar esos bloques y las
  env huérfanas (`MINIO_*`, `STORAGE_*`, `IMGPROXY_*`, `FUNCTIONS_*`,
  `POOLER_*`).

**Fuente de verdad: `docker_compose_raw`, NO el archivo en disco.**
Coolify regenera `/data/coolify/services/<uuid>/docker-compose.yml` desde
`docker_compose_raw` (columna `services.docker_compose_raw`) en cada deploy:
editar solo el archivo se pierde en el próximo redeploy (verificado: un
restart resucitó los 8 servicios). Para recortar de forma durable hay que
quitar los bloques del raw (vía `php artisan tinker` en el contenedor
`coolify` + `Yaml::parse`, unset de los 8 servicios, `save()`) y redeplegar.
Las filas huérfanas en `service_applications` (sin `fqdn`) no afectan.

## 2. Service SearXNG (one-click)

Coolify → New → Service → `SearXNG` → Deploy. Verificar `/healthz` (la plantilla
ya trae `json` habilitado en `formats`).

La web lo consume por **URL HTTPS pública** (dominio autogenerado del service,
resuelve por wildcard sin pedir DNS):

- `SEARXNG_URL=https://<id>.papelitosdecolor.com` (sin `/` final; ver `web/lib/retrieval.ts`)
- Si el SearXNG es compartido y protegido con Basic Auth (Traefik):
  `SEARXNG_BASIC_AUTH=usuario:clave` (en claro; el código la codifica).
  Sin esto, todo da 401. La instancia vieja abierta no lo necesita.
- Los services de Coolify viven en redes Docker distintas, así que no se asume
  resolución por hostname interno entre recursos.

## 3. Application web (Git + Dockerfile)

Coolify → New → Application → Public Repository:
`https://github.com/diegovelezg/retain-engine-ai`, rama `main`.

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
- Entre service y application **siempre valor literal, nunca `${...}`**: las
  referencias no cruzan recursos y resuelven vacío (el worker queda sin key
  con `401 No API key found`, ver §7). Service Supabase → Environment →
  revelar y copiar:
  - `SUPABASE_URL` = `https://retention-api.papelitosdecolor.com` (HTTPS
    pública, no `localhost` ni hostname interno: cada service vive en su
    propia red Docker).
  - `SUPABASE_SERVICE_ROLE_KEY` = `SERVICE_ROLE_KEY` legacy (JWT `eyJ…`) o
    `SUPABASE_SECRET_KEY` (`sb_secret_…`). **NO** usar
    `SERVICE_ROLE_KEY_ASYMMETRIC` (es la JWK privada, no es apikey).
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = `ANON_KEY` legacy o
    `SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`).
  Tras cambiar env: **redeploy** de la `web` (si no, el container sigue con
  el env viejo).
- No tocar `web/Dockerfile` (standalone, ya ignora tracking con `web/.dockerignore`).

## 3b. Cron diario (Scheduled Task sobre `web`, sin recurso worker)

Coolify → Scheduled Task contra el recurso `web`, todos los días 11:00 UTC
(= 06:00 Lima, sin DST):

* Name: `retention-daily`
* Schedule: `0 11 * * *`
* Command:
```
npm run worker -- --once --kinds=sync,morning
```
* Timeout: `3600` (el full secuencial de 3-5 tiendas con pasos LLM supera
  los 300s del default y la task lo mata a medias dejando solo la cabecera).
* Container: el de la app `web`.

```
npm run worker -- --once --kinds=sync,morning
```

Sin `--store`: todas las tiendas medusa. `runSyncOnce` reclama slot atómico
por tienda: si el login/manual lo está corriendo, el cron lo omite (run null),
no duplica. Exit 1 si alguna tienda falló (visible en la tarea).
Tras guardar: run manual y buscar en el log `start stores=N` … `done
failed=0`. Si solo salen las líneas de `npm`/avisos de Node = el worker
murió antes de arrancar (exit 0 falso): ver §7.
Sin cola: la web corre `runSyncOnce` directo en `after()` (respuesta <200ms);
el cron es solo el programador diario + las corridas manuales usan el mismo
comando con `--store=<uuid>` opcional.

## 3c. Scheduler (notas)

Tabla `jobs` (migración `20261029000000_jobs.sql`) en desuso: no borrar
(artefacto histórico en DB), no programar nada sobre ella.

Modo alterno en código (no usado en prod): daemon interno con
`WORKER_SCHEDULE=1` (`WORKER_CRON_HOUR`/`WORKER_CRON_MINUTE`, default `6:00`
Lima, offset fijo −5). Solo para dev/local; en Coolify no se setea
(default apagado = one-shot).

## 4. Esquema + datos (sin bind mounts)

La plantilla no corre `supabase/migrations/*.sql`: se aplican por stdin contra
el contenedor `supabase-db-<uuid>` (`docker exec -i -u postgres … psql`,
peer-auth, sin password y sin copiar archivos al VPS). Script versionado:
`scripts/retain-apply.sh` (testeado con stub de `docker`; ver su cabecera):

```bash
export SSHPASS='<root VPS>' VPS_IP=46.225.73.40
DB_CONTAINER=supabase-db-<uuid> ./scripts/retain-apply.sh status     # solo lectura: pendientes local vs VPS (exit 1 si hay)
DB_CONTAINER=supabase-db-<uuid> ./scripts/retain-apply.sh schema     # todas las migraciones en orden + tracking public.schema_migrations
DB_CONTAINER=supabase-db-<uuid> ./scripts/retain-apply.sh relations  # solo lectura: tablas/columnas que el código asume
DB_CONTAINER=supabase-db-<uuid> ./scripts/retain-apply.sh data <public-data.sql> [auth.sql]  # data-only (sin tracking)
DB_CONTAINER=supabase-db-<uuid> ./scripts/retain-apply.sh verify     # esperado: stores=1 customers=953 orders=699 merchant_users=1 auth.users=1 auth.identities=1
```

Tras `schema` con DDL (tablas/columnas nuevas): **reiniciar la sub-app
`rest`** en Coolify (o `NOTIFY pgrst, 'reload schema'`). PostgREST cachea el
esquema: sin reload la app sigue viendo `Could not find the table ... in the
schema cache` aunque la tabla ya exista (pasó el 2026-10-21 con `products`).
Gate en runtime por si se omite este paso: el worker falla en rojo al
arrancar (`DB detrás del código...`, ver `web/lib/schema-guard.ts`) y
`/api/health` lo expone como `schemaOk/schemaGaps`.

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

`merchant_users` linkea cada login con sus tiendas (multiuser por tenant:
cualquier miembro ve todo su tenant). La migración
`20261102000000_merchant_users_bootstrap` asigna automáticamente las tiendas
existentes a usuarios sin membresía; si un user ve "Sin acceso a esta
tienda", alta manual:

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
curl -sk https://retention-api.papelitosdecolor.com/auth/v1/health                       # GoTrue exige apikey: 401 vía Kong es lo esperado
curl -sk -o /dev/null -w '%{http_code}\n' https://retention-studio.papelitosdecolor.com/  # 307 (sin Basic Auth: pendiente §1.2)
curl -sk -o /dev/null -w '%{http_code}\n' https://retention-api.papelitosdecolor.com/storage/v1/bucket  # 503 esperado (lean, §1b)
curl -sk https://<searxng>/healthz
docker ps --format '{{.Names}} {{.Ports}}' | grep -i 5432   # Postgres sin puerto público
```

En la app: login con `diegovelezg@gmail.com` → `/customers` muestra **952**.
Probar una acción de enriquecimiento (usa `SEARXNG_URL`, `web/lib/retrieval.ts`).

### Pipeline sin login (issue #24)

```sql
-- Studio → SQL editor. La cinta es background_runs (la tabla jobs está
-- retirada como artefacto histórico y siempre sale vacía, no la uses):
select kind, status, summary, started_at
  from background_runs order by started_at desc limit 10;
-- Esperado a las 06:05 Lima sin ningún login en 24h: filas sync + scout +
-- strategist + copywriter + prospect en done para cada store.
-- Slot atómico (sin duplicados entre réplicas):
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and proname = 'start_run_if_free';
-- Debe devolver 1 fila; si sale vacía, aplicar
-- supabase/migrations/20261029000001_run_slot.sql (ver §4 / script).
```

Criterios: sin login en 24h el pipeline corre 1 vez por store; redeploy a
mitad de run → `error` con `reap` a los 30min (sin reintento intra-día: hasta
el próximo cron o rerun manual con `--store`); login con sesión siempre
abierta no dispara trabajo pesado síncrono (solo `runSyncOnce` en `after()`).

Local sigue igual: `npx supabase start` → `http://127.0.0.1:54323`.
Worker local: `cd web && npm run worker` (otra terminal, con `web/.env.local`).

## 7. Si algo falla

- Login "Credenciales inválidas (…)" con detalle: el mensaje incluye el error
  real de GoTrue (`web/lib/auth-actions.ts`). Causas típicas: `NEXT_PUBLIC_*`
  horneadas con valores viejos (rebuild sin caché), `SUPABASE_PUBLIC_URL` sin
  `https://`, o usuario inexistente en la DB nueva (paso 5).
- Login redirige en loop: `SITE_URL` / `API_EXTERNAL_URL` /
  `ADDITIONAL_REDIRECT_URLS` deben ser los dominios públicos con `https`.
- `/customers` vacío: verificar conteos (paso 4 `verify`) y `merchant_users` linkeado.
- SearXNG 403/5xx: revisar `SEARXNG_SECRET` del service y `SEARXNG_URL` de la web.
- Prospect en `error` con `spawn ps ENOENT` (crawl en 0 requests): faltaba
  `procps` en la imagen runner (Crawlee spawnea `ps` para memoria).
  Fijado en `web/Dockerfile`; exige rebuild + redeploy de la web.
- Task `retention-daily` en Success pero sin `start stores=N` (solo cabecera
  `npm`/avisos Node): el worker murió antes de arrancar (exit 0 falso).
  Causas vistas en prod, en orden:
  1. `401 {"message":"No API key found in request"}` al listar `stores`:
     falta `SUPABASE_SERVICE_ROLE_KEY` en el env de la `web` (típico:
     quedó un `${...}` entre recursos o falta redeploy). Ojo: el task en
     Success no significa nada (el `fetch` a `/health` no lanza con 401);
     Kong exige `apikey` hasta en `/auth/v1/health`.
  2. `[worker] Run slot: Could not find the function public.start_run_if_free`:
     falta aplicar `20261029000001_run_slot.sql` en la BD prod (ver §6).
  3. `[worker] Node.js detected but native WebSocket not found` (o silencio
     total con exit 0 en tsx): `createClient` de supabase-js lanzaba en Node 20
     sin WebSocket global (imagen vieja `node:20`; actual `node:22` + polyfill).
     Fijado en `web/lib/supabase.ts` (polyfill `ws` solo cuando falta; dep
     explícita en `web/package.json`).
  Diagnóstico en la misma task (timeout 60), en orden:
```
node -e "fetch(process.env.SUPABASE_URL+'/auth/v1/health').then(r=>r.text().then(t=>console.log(r.status,t.slice(0,80)))).catch(e=>console.error('FETCH_FAIL',e.message))"
node -e "(async()=>{const{createClient}=await import('@supabase/supabase-js');const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});const{data,error}=await db.from('stores').select('id,platform').limit(20);if(error){console.error('STORES_FAIL',error.message);process.exit(1)}console.log(JSON.stringify(data))})()"
```
- Redeploy que tumba el VPS: el build (`npm ci` + `next build` + toolchain
  nativo) satura un VPS al límite. Antes de reintentar: `free -m`, nada de
  builds en paralelo, y parar stacks muertos (2026-10-21: había **5** stacks
  Supabase y solo `jpixillx` con datos; los otros 4 se paran en Coolify con
  Stop —no delete— para no perder volúmenes). Si el container viejo sigue
  vivo, un parche puntual vía `docker cp` (p. ej. `lib/` que el worker corre
  por `tsx`) desbloquea sin rebuild; el fix real entra en el próximo build.
- No tocar contenedores, volúmenes, redes ni proxy de otros proyectos; no correr
  `docker builder prune` global.
- Dominios `Indexable`: API y Studio no deben indexarse en Google (Domains →
  engranaje → noindex). Pendiente de aplicar.

## 8. Checklist de release (web)

0. Schema al día **antes** de desplegar la web: `status` sin pendientes,
   `relations` ok y `verify` verde. Si el release trae DDL, reiniciar `rest`
   tras el `schema` (schema-cache). Regla: nunca desplegar código que asuma
   tablas/columnas que prod aún no tiene (2026-10-21: 9 migraciones por
   detrás → `products` invisible + `para actuar hoy` 1 vs 2 por foto vieja).
   Si el release toca dependencias solo-node o `next.config.ts`:
   `npm run build && npm run check:bundle` (Crawlee bundleado en el SSR
   tumba prospect solo en prod, sin síntoma en dev).
1. Env Coolify al día (valores literales, §3) + redeploy.
2. Rebuild **sin caché** si cambió `NEXT_PUBLIC_*` o la anon key.
3. §6 verde: login 200, API 401, Studio 307, SearXNG ok, conteos `verify`.
4. Cron `retention-daily` corre 1 vez: `start stores=N … done failed=0`.
5. Si el VPS está al límite, no desplegar nada más en paralelo (§7).
