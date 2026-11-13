// Worker Fase 2: sin morning pipeline. La gestión DOOH (órdenes, inventario,
// empresas) es operativa y no necesita corrida diaria. Este worker queda como
// no-op intencional: sale 0 sin hacer nada. Si a futuro hay pipeline (vencimientos, alertas),
// se reintroduce aquí por tienda.
import { createLogger } from "@/lib/log";

const log = createLogger("worker");

async function main(): Promise<void> {
  log("Fase 2: sin pipeline programado (no-op).");
}

if (require.main === module) {
  main().catch((e) => {
    log.error(e instanceof Error ? e : String(e), { fatal: true });
    process.exit(1);
  });
}
