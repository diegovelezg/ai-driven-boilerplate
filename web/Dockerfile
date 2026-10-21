# web — Dockerfile prod para Coolify (deploy único con compose raíz).
# Node 20.19+ exigido por @google/adk.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 (vía crawlee) compila nativo con node-gyp: necesita toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* se inlinan en el build → Coolify debe pasarlas como Build Args
# (mismo valor que las runtime). Ver docs/coolify.md.
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Crawlee (scout/prospect) spawnea `ps` para sus snapshots de memoria
# (@apify/ps-tree): la imagen slim no lo trae y el crawl muere con
# `spawn ps ENOENT` (prospect en error 4 corridas seguidas, 2026-10-21).
RUN apt-get update && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
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
COPY --from=deps /app/node_modules ./node_modules
# /app lo crea root y los COPY quedan root:root: sin esto, `nextjs` no puede
# crear /app/.data (logs, .data/crawlee de Crawlee, fallback connections.json)
# y la prospección revienta con `EACCES: permission denied, mkdir '/app/.data'`.
RUN mkdir -p /app/.data/crawlee && chown -R nextjs:nodejs /app/.data
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# El cron de prod (Scheduled Task Coolify, docs/coolify.md 3b) corre one-shot
# dentro de esta misma imagen: `npm run worker -- --once --kinds=sync,morning`.
# WORKER_MODE=1 → `npm run worker` (solo dev/daemon local); si no, web Next.js.
# `exec`: PID1 es el proceso real y recibe el SIGTERM de compose/Coolify (sin
# exec, PID1 queda `sh`, los handlers del worker nunca se disparan y cada
# redeploy deja el job en `running` hasta el reap).
CMD ["sh", "-c", "if [ \"$WORKER_MODE\" = \"1\" ]; then exec npm run worker; else exec node server.js; fi"]
