// Seed de facturas dummy para ver el flujo de cobranza completo.
// Uso: npx tsx --env-file=.env.local scripts/seed-invoices-dummy.ts
// Re-ejecutable: borra F001-DUMMY-* y la orden legacy DUMMY-2026-005 antes de insertar.
// Cubre (brutos exactos de io_lines, vencimientos = payment_terms de cada OI):
// sin_facturar (NP-2026-005 firmada sin facturas), facturado (Tottus 001),
// parcial (Toyota 002: 50% pagado + 50% emitido), pagado+prepago (Pacífico 003,
// emitida antes del inicio 2026-10-26), vencido (Qroma 004: emitida 05/09 con
// 60d, vencida 04/11).
// La orden legacy DUMMY-2026-005 (brand "Dummy") se elimina: su caso lo cubre
// NP-2026-005 (Toyota Corolla, coherente con el set limpio).
import { getSupabase } from "@/lib/supabase";
import { fail, loadStoreId } from "./lib/run-once";

const LEGACY_DUMMY_ORDER = "DUMMY-2026-005";
const ORDER_NUMS = ["NP-2026-001", "NP-2026-002", "NP-2026-003", "NP-2026-004", "NP-2026-005"];

async function main(): Promise<void> {
  const db = getSupabase();
  const storeId = await loadStoreId();

  const { data: orders } = await db
    .from("io_orders")
    .select("id,io_number")
    .eq("store_id", storeId)
    .in("io_number", ORDER_NUMS);
  const byNum = new Map(((orders ?? []) as Array<{ id: string; io_number: string }>).map((o) => [o.io_number, o.id]));
  for (const n of ORDER_NUMS) {
    if (!byNum.has(n)) throw new Error(`Falta orden ${n}: correr seed-ois-smartmedia.ts primero.`);
  }

  // Limpieza idempotente (facturas del seed + orden legacy sucia).
  await db.from("io_invoices").delete().eq("store_id", storeId).like("number", "F001-DUMMY-%");
  await db.from("io_orders").delete().eq("store_id", storeId).eq("io_number", LEGACY_DUMMY_ORDER);

  // NP-2026-005 queda sin facturas a propósito: caso sin_facturar.
  const rows = [
    // Tottus (bruto 2000+3000=5000 → 500000): facturado (30d: 05/11 → 05/12).
    { io: "NP-2026-001", number: "F001-DUMMY-001", amount_minor: 500000, status: "issued", issue_date: "2026-11-05", due_date: "2026-12-05" },
    // Toyota (bruto 16758 → 1675800): parcial (50% pagado + 50% emitido, 60d).
    { io: "NP-2026-002", number: "F001-DUMMY-002", amount_minor: 837900, status: "paid", issue_date: "2026-10-01", due_date: "2026-11-30" },
    { io: "NP-2026-002", number: "F001-DUMMY-003", amount_minor: 837900, status: "issued", issue_date: "2026-11-01", due_date: "2026-12-31" },
    // Pacífico (bruto 5600+4480=10080 → 1008000): pagado + prepago (45d: 20/10 → 04/12, emisión previa al inicio 26/10).
    { io: "NP-2026-003", number: "F001-DUMMY-004", amount_minor: 1008000, status: "paid", issue_date: "2026-10-20", due_date: "2026-12-04" },
    // Qroma (bruto 4400+4400=8800 → 880000): vencido (60d: 05/09 → 04/11, pasado al 09/11).
    { io: "NP-2026-004", number: "F001-DUMMY-005", amount_minor: 880000, status: "issued", issue_date: "2026-09-05", due_date: "2026-11-04" },
  ];
  const { error } = await db.from("io_invoices").insert(
    rows.map((r) => ({
      store_id: storeId,
      io_id: byNum.get(r.io)!,
      number: r.number,
      amount_minor: r.amount_minor,
      currency: "PEN",
      status: r.status,
      issue_date: r.issue_date,
      due_date: r.due_date,
    })),
  );
  if (error) throw new Error(`Invoices: ${error.message}`);
  console.log("seed OK: 5 facturas dummy (001 facturado, 002 parcial, 003 pagado+prepago, 004 vencido; 005 sin_facturar).");
}

main().catch((e) => fail("INVOICES-DUMMY", e));
