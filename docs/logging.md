# Logging SSOT (`web/lib/log.ts`)

Único punto para debuguear procesos. Todo log de server/scripts pasa por aquí.

```ts
import { createLogger } from "@/lib/log";
const log = createLogger("profiler", { storeId, runId });
log.info("pipeline synthesis", { arch, conf });
log.debug("detalle verboso");   // solo con LOG_LEVEL=debug
log.warn("degradado", { storeId });
log.error(err, { storeId });    // acepta Error o string
const child = log.child({ runId }); // contexto fijo
```

## Niveles y env

| env | default | efecto |
|-----|---------|--------|
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`: mínimo emitido |
| `LOG_MAX` | `2000` | tope de chars por mensaje/ctx (legacy `ADK_LOG_MAX`) |
| `ADK_LOG_VERBOSE=0` | — | legacy: scope `adk` sube el mínimo a `warn` |

## Salidas

- Consola: `console.debug/log/warn/error` con prefijo `[scope]`.
- Archivo best-effort (nunca lanza):
  - `.data/<scope>.log` — por proceso.
  - `.data/app.log` — combinado de todos (tail único para cruzar procesos).

## Formato

`[ISO] [LEVEL] [scope] mensaje k=v` — grepeable:

```bash
tail -f .data/app.log
grep "run=abc" .data/adk.log
grep "\[error\]" .data/app.log
LOG_LEVEL=debug pnpm dev
```

## Procesos cubiertos (`PROCESSES`)

| grupo | scopes | dónde se loguea |
|-------|--------|-----------------|
| crud | `crm`, `orders`, `order-flow`, `screens`, `insights`, `members`, `settings` | `log.warn` en cada `DB read/write` fallido + `log.error` en cada `catch` de `lib/*-actions.ts` |
| ai | `chat`, `adk`, `profiler`, `enrichment`, `investigate`, `verticals`, `company-research`, `llm-usage` | ciclo de vida del chat (`chat start/done/aborted/fail` en `lib/api/chat-route.ts`), plugin ADK (run/agent/model/tool + errores), pipeline del perfilador con `storeId`, fallbacks LLM, `ai_llm_usage` (DB + warn si se salta) |
| inbox | `brief`, `wall` | `runBriefJob` (`brief start/done`, skip, errores) + `scripts/run-brief.ts` por tienda + `finishRun` en `sys_runs` |
| api | `api` (`process` = ruta) | `apiLog` en cada `catch` de `app/api/**/route.ts` |
| system | `worker`, `tenant`, `auth`, `background`, `scripts` | `startRun/finishRun` (ok + error), `reapStaleRuns` (warn), login fails (sin PII) |

## Consultar fallos

```bash
# últimos 50 errores de TODO
tsx scripts/logs.ts --level=error --tail=50
# un proceso
tsx scripts/logs.ts --scope=brief --tail=100
# un run / una tienda a través de procesos
tsx scripts/logs.ts --grep="run=abc123" --tail=200
tsx scripts/logs.ts --grep="storeId=xyz" --level=warn --tail=200
# desde una fecha + qué scopes tienen archivo
tsx scripts/logs.ts --level=warn --since=2026-11-11 --tail=200
tsx scripts/logs.ts --list
```

Las funciones `parseLogLine` / `filterLogLines` / `queryLogs` / `trace`
viven en el SSOT y tienen tests en `web/tests/log.test.ts`.

## Reglas

1. Nuevo código: `createLogger("<proceso>")` con `log.debug/info/warn/error` y ctx (`storeId`, `runId`, `process`). No `console.*` directo en `lib/`, `app/api/`, `worker.ts`, `scripts/`.
2. CRUD: todo `catch (e)` loguea `error`; todo `DB read/write` fallido loguea `warn` con la acción. Los rechazos de validación (input del usuario) no se loguean.
3. Compat legacy: `log("texto")` = `info`; `createProfilerLogger()` sigue funcionando (wrapper a scope `profiler`).
4. Sin PII en mensajes; secretos se redactan (`Bearer`, `sk-*`, `token/password` en ctx) pero igual evita loguearlos.
5. Los errores de negocio que ya van a DB (`sys_runs.error`, `finishRun`) además van al log para consulta rápida.
