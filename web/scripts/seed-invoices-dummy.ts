// Seed de facturas dummy para ver el flujo de cobranza completo.
// Uso: npx tsx --env-file=.env.local scripts/seed-invoices-dummy.ts
// Re-ejecutable: borra F001-DUMMY-* y la orden DUMMY-2026-005 antes de insertar.
// Cubre: sin_facturar (DUMMY-005 sin facturas), facturado (Tottus),
// parcial (Toyota), pagado+prepago (Pacífico), vencido + anulada (Qroma).
import { getSupabase } from "@/lib/supabase";
import { fail, loadStoreId } from "./lib/run-once";

const DUMMY_ORDER = "DUMMY-2026-005";

async function main() {
  const db = getSupabase();
  const storeId = await loadStoreId();

  const { data: orders } = await db
    .from("io_orders")
    .select("id,io_number")
    .eq("store_id", storeId)
    .in("io_number", ["NP-2026-001", "NP-2026-002", "NP-2026-003", "NP-2026-004"]);
  const byNum = new Map(((orders ?? []) as Array<{ id: string; io_number: string }>).map((o) => [o.io_number, o.id]));
  for (const n of ["NP-2026-001", "NP-2026-002", "NP-2026-003", "NP-2026-004"]) {
    if (!byNum.has(n)) throw new Error(`Falta orden ${n}: correr seed-ois-smartmedia.ts primero.`);
  }

  // Limpieza idempotente.
  await db.from("io_invoices").delete().eq("store_id", storeId).like("number", "F001-DUMMY-%");
  await db.from("io_orders").delete().eq("store_id", storeId).eq("io_number", DUMMY_ORDER);

  // Orden sin facturas → sin_facturar.
  const { data: dummy, error: dummyErr } = await db
    .from("io_orders")
    .insert({ store_id: storeId, io_number: DUMMY_ORDER, brand: "Dummy", status: "draft", currency: "PEN" })
    .select("id")
    .single();
  if (dummyErr) throw new Error(`Dummy order: ${dummyErr.message}`);
  void dummy;

  const rows = [
    // Tottus (bruto 500000) → facturado.
    { io: "NP-2026-001", number: "F001-DUMMY-001", amount_minor: 500000, status: "issued", issue_date: "2026-11-05", due_date: "2026-12-15" },
    // Toyota (bruto 1675800) → parcial (50% pagado + 50% emitido).
    { io: "NP-2026-002", number: "F001-DUMMY-002", amount_minor: 837900, status: "paid", issue_date: "2026-10-01", due_date: "2026-11-30" },
    { io: "NP-2026-002", number: "F001-DUMMY-003", amount_minor: 837900, status: "issued", issue_date: "2026-11-01", due_date: "2027-01-15" },
    // Pacífico (bruto 1008000) → pagado + prepago (emisión previa al inicio 2026-10-26).
    { io: "NP-2026-003", number: "F001-DUMMY-004", amount_minor: 1008000, status: "paid", issue_date: "2026-10-20", due_date: "2026-12-04" },
    // Qroma (bruto 880000) → vencido (emitida con vencimiento pasado) + 1 anulada (se ignora).
    { io: "NP-2026-004", number: "F001-DUMMY-005", amount_minor: 880000, status: "issued", issue_date: "2026-10-01", due_date: "2026-10-15" },
    { io: "NP-2026-004", number: "F001-DUMMY-006", amount_minor: 100000, status: "cancelled", issue_date: "2026-10-01", due_date: "2026-11-01" },
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
  console.log(`seed OK: 6 facturas dummy + orden ${DUMMY_ORDER} (sin_facturar).`);
}

main().catch((e) => fail("INVOICES-DUMMY", e));
