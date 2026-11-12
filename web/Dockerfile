# web — Dockerfile prod (build multi-stage).
# Node 22 exigido por supabase-js/better-sqlite3/mikro-orm/kysely (>=22);
# @google/adk no pinea engines y es compatible.
#
# Reglas de este archivo:
# - UN solo `apt-get` (stage `base`): 3 apt-get en paralelo + 2 `npm ci`
#   contra red saturaban máquinas chicas sin RAM.
# - UN solo `npm ci` con red (stage `deps`). `prod-deps` deriva por COPY +
#   `npm prune` local, sin descargar nada.
# - Runner SIN toolchain: `runner-base` solo trae procps (Crawlee spawnea
#   `ps` en runtime) + usuario no-root. python3/make/g++ se quedan en `base`
#   (solo build). ~-280MB en la imagen final; los binarios nativos
#   (better-sqlite3) se compilan en `deps` y viajan ya compilados.
# - Sin devDeps inútiles en el lock: la CLI `supabase` (146MB) y `shadcn`
#   salieron de package.json (local: `npm i -g supabase`, `npx shadcn`).
#   `adk-devtools` se queda: `.bin/adk` apunta ahí (`npm run adk` local).
FROM node:22-bookworm-slim AS base
WORKDIR /app
# Un solo apt: toolchain (better-sqlite3 vía crawlee compila nativo con
# node-gyp) + procps (Crawlee spawnea `ps` para snapshots de memoria;
# sin esto prospect muere con `spawn ps ENOENT`, 2026-10-21).
# Un solo RUN: una layer, y el usuario existe antes de usarlo
# (el log 2026-10-23 mostró `addgroup ERROR: not found` por orden frágil).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ procps \
  && rm -rf /var/lib/apt/lists/ \
  && addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

FROM base AS deps
# Cache BuildKit: los re-deploys sin cambio de lock reutilizan ~/.npm
# en vez de re-descargar. --no-audit/--no-fund: el audit no aporta en build.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# Deps solo-prod para el runner: deriva de `deps` por COPY + prune local
# (sin red). NO otro `npm ci` en paralelo.
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev

# Base limpia de runtime: sin toolchain de compilación (python3/make/g++ se
# quedan en `base`, solo build). Solo procps (Crawlee spawnea `ps`) +
# usuario no-root. Misma distro y Node que `base` para que los binarios
# nativos compilados en `deps` sigan valiendo.
FROM node:22-bookworm-slim AS runner-base
RUN apt-get update && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/ \
  && addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* se inlinan en el build → pasarlas como Build Args
# (mismo valor que las runtime).
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM runner-base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Worker dedicado (issue #24): misma imagen, distinto comando. El standalone
# no trae fuentes; se copian para `tsx worker.ts` (solo las usa el worker).
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/worker.ts ./worker.ts
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/config ./config
COPY --from=builder /app/agent.ts ./agent.ts
# Solo prod, ya podado en su propio stage: COPY directo
# (eslint/tailwind/typescript quedan fuera;
# `tsx` es dep prod —la usa el cron— y se conserva).
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --chown=nextjs:nodejs entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh \
  && mkdir -p /app/.data/crawlee && chown -R nextjs:nodejs /app/.data
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Sin `sh -c` ni `npm` intermedios: ENTRYPOINT en forma exec, PID1 es el
# proceso real (node o tsx) y recibe el SIGTERM directo.
ENTRYPOINT ["/app/entrypoint.sh"]
