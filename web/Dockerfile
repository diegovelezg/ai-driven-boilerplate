# web — Dockerfile prod para Coolify (deploy único con compose raíz).
# Node 22 exigido por supabase-js/better-sqlite3/mikro-orm/kysely (>=22);
# @google/adk no pinea engines y es compatible.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 (vía crawlee) compila nativo con node-gyp: necesita toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Cache BuildKit: los re-deploys sin cambio de lock reutilizan ~/.npm
# en vez de re-descargar 1100+ paquetes (~40s en el log 2026-10-23).
RUN --mount=type=cache,target=/root/.npm npm ci

# Deps solo-prod para el runner: lo que se copia a la imagen final.
# Evita el patrón COPY-todo + `npm prune` (la layer de 1.1GB + whiteouts
# ya quedaba grabada: 37s de COPY + 12.7s de export en el log 2026-10-23).
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
  && npm cache clean --force

FROM node:22-bookworm-slim AS builder
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

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Crawlee (scout/prospect) spawnea `ps` para sus snapshots de memoria
# (@apify/ps-tree): la imagen slim no lo trae y el crawl muere con
# `spawn ps ENOENT` (prospect en error 4 corridas seguidas, 2026-10-21).
# Un solo RUN: un apt-update, una layer, y el usuario existe antes de usarlo
# (el log 2026-10-23 mostró `addgroup ERROR: not found` por orden paralelo frágil).
RUN apt-get update && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/ \
  && addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
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
# Solo prod, ya podado en su propio stage: COPY directo, sin `npm prune`
# (shadcn/eslint/tailwind/supabase-CLI/adk-devtools/typescript quedan fuera;
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
