# Deploy único en Coolify (todo junto)

Push al repo → redeploy en Coolify → levantan `web + db + auth + rest + studio + searxng`.

## 1. Preparar secretos (una vez, local)

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # POSTGRES_PASSWORD
openssl rand -hex 32   # PG_META_CRYPTO_KEY
openssl rand -base64 32 # SECRETS_ENCRYPTION_KEY
openssl rand -hex 32   # SEARXNG_SECRET_KEY

python3 infra/supabase/gen-keys.py '<JWT_SECRET>'
# -> pega salida en ANON_KEY / SERVICE_ROLE_KEY
```

Ver plantilla completa en `.env.deploy.example`.

## 2. Crear el servicio en Coolify

1. Coolify → New Project → New Service → Docker Compose → conecta el repo GH (`main`).
2. Compose file: `./docker-compose.yaml` (raíz, default de Coolify).
3. Pega las envs del paso 1 en Environment.
4. Asigna 3 dominios (en cada servicio del compose):
   - `web:3000` → `https://app.tudominio.com`
   - `gateway:8000` → `https://api.tudominio.com`
   - `studio:3000` → `https://studio.tudominio.com`
5. Protege Studio (obligatorio): el Studio self-hosted oficial **no pide usuario/contraseña**.
  Sin protección, cualquiera con la URL `studio.tudominio.com` ve tu base de datos.
  En Coolify abre el servicio `studio` → Domains → tu dominio → activa la opción de
  contraseña (según tu versión se llama "Password Protection", "Basic Auth" o
  "Protect with password") y define usuario + contraseña. Desde entonces el navegador
  pide esa contraseña ANTES de mostrar Studio. Si tu Coolify no muestra ese interruptor,
  no expongas Studio a internet: accede por SSH tunnel (`ssh -L 3000:localhost:3000 tu-vps`)
  o dime y cableo basic-auth en el compose.
6. Deploy.

## 3. Entrar a Supabase Studio

Con todo desplegado, Studio **es un servicio más del compose**:

- URL: `https://studio.tudominio.com`
- Pide antes la protección de acceso de Coolify que configuraste.
- Dentro verás la DB (`public.*`: `stores`, `customers`, `orders`, …), Auth → Users y el SQL editor.
- Primer usuario merchant: Studio → Authentication → Users → Create user (email+password con tu dominio), luego en SQL editor:
  ```sql
  insert into merchant_users (store_id, user_id)
  values ('<store_id>', '<auth_user_id>');
  ```
- La app (`https://app.tudominio.com/login`) usa ese mismo usuario (GoTrue `auth:9999` vía `gateway:8000/auth/v1`).

Local sigue igual: `npx supabase start` → `http://127.0.0.1:54323`.

## 4. Actualizar con cada push

`git push` → Coolify → Redeploy (o auto-deploy si lo activas). El servicio `migrator` aplica solo las migraciones nuevas de `supabase/migrations/*.sql` (tabla `public.schema_migrations`); `web` se rebuildea con los `NEXT_PUBLIC_*` como Build Args (ya cableados en el compose).

## 5. Migrar los datos locales a Coolify

El esquema lo crea solo el servicio `migrator` en el primer deploy; los datos se mueven aparte (tu local tiene ~1 store, ~950 customers, ~700 orders, <2 MB):

```bash
# 1. Primer deploy en Coolify SIN datos (migrator crea el esquema vacío).
# 2. Dump + restore (el script verifica esquema y compara conteos):
./infra/supabase/migrate-data.sh '<TARGET_URL>'
# TARGET_URL = connection string del Postgres de Coolify
# (desde tu máquina con el puerto expuesto, o corriendo el script en el VPS).
```

3. Recrea tu usuario login: Studio de Coolify → Authentication → Users → Create user.
   Luego linkéalo a tu tienda (el `store_id` se preservó del dump):
   ```sql
   insert into merchant_users (store_id, user_id)
   values ('<store_id>', '<auth_user_id>');
   ```
4. Verifica en la app: `/customers` debe mostrar tus ~950 customers.

Notas: `merchant_users` local está vacío (0 filas), así que no arrastra FKs viejas;
`auth.users` NO se migra (con 1 solo usuario es más limpio recrearlo que copiar tablas
internas de GoTrue): se recrea el usuario y se linkea.

## 6. Si algo falla

- `migrator` → `MIGRATIONS_OK` en logs = DB al día. Si una migración falla, el deploy se detiene antes de levantar `web` (a propósito).
- Deploy parado en `migrator ... Waiting` → el contenedor no terminó (compose espera su exit por el `service_completed_successfully`). Ya no puede quedarse colgado: el script acota la espera de `db` (180s), cada sentencia (`lock_timeout` 30s / `statement_timeout` 5min) y cada `psql` (10min). Revisa:
  ```bash
  docker ps -a | grep migrator                      # ¿sigue Up o ya Exited?
  docker logs --tail=200 <nombre-migrator>          # dice el archivo y el ERROR
  docker exec <nombre-db> psql -U postgres -c \
    "select pid, state, wait_event_type, wait_event, now()-xact_start as age, left(query,120)
       from pg_stat_activity where datname='postgres' order by xact_start"
  ```
  Si aparece `wait_event_type=lock`, hay una sesión con una transacción abierta (Studio/SQL editor, un `psql` olvidado, etc.): ciérrala o `select pg_terminate_backend(<pid>)`. Cada archivo corre en una sola transacción: si falla, se revierte completo y el próximo deploy lo reintenta desde cero.
- `web` en blanco / `Falta NEXT_PUBLIC_...` → revisa Build Args en Coolify (deben ser = `SUPABASE_PUBLIC_URL` y `ANON_KEY`).
- Login redirige en loop → `SITE_URL`, `API_EXTERNAL_URL` y `ADDITIONAL_REDIRECT_URLS` deben ser los dominios públicos reales con `https`.
- SearXNG 403 → `SEARXNG_SECRET_KEY` distinto al `secret_key` de dev de `infra/searxng/settings.yml` (prod manda el env).
