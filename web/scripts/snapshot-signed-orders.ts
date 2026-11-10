// Foto NP a órdenes ya firmadas sin snapshot (una vez; las nuevas firman con foto).
// Uso: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/snapshot-signed-orders.ts
// Idempotente: solo status='signed' con snapshot_json null.
import { getSupabase } from "@/lib/supabase";
import { getOrderDetail } from "@/lib/orders-db";
import { buildOrderSnapshot } from "@/lib/order-snapshot";
import { normalizeCurrency } from "@/lib/currency";
import { fail, loadStoreId } from "./lib/run-once";

async function main() {
  const storeId = await loadStoreId();
  const db = getSupabase();
  const { data, error } = await db
    .from("io_orders")
    .select("id,io_number")
    .eq("store_id", storeId)
    .eq("status", "signed")
    .is("snapshot_json", null);
  if (error) throw new Error(`signed scan: ${error.message}`);
  const rows = ((data ?? []) as Array<Record<string, unknown>>);
  if (rows.length === 0) {
    console.log("Sin firmadas pendientes de foto.");
    return;
  }
  const failures: string[] = [];
  for (const r of rows) {
    const id = String(r.id);
    const num = String(r.io_number ?? id);
    try {
      const detail = await getOrderDetail(storeId, id);
      if (!detail) throw new Error("detalle nulo");
      const gross = detail.lines.reduce((a, l) => a + Number(l.rate_minor ?? 0), 0);
      const toContact = (
        c: { name: string; role: string | null; email: string | null; phone: string | null } | null,
      ) => (c ? { name: c.name, role: c.role, email: c.email, phone: c.phone } : null);
      const snapshot = buildOrderSnapshot({
        signed_at:
          typeof detail.order.signed_at === "string" && detail.order.signed_at
            ? String(detail.order.signed_at)
            : new Date().toISOString(),
        currency: normalizeCurrency(
          (detail.order.currency as string | null | undefined) ?? "PEN",
        ),
        payment_terms_days:
          typeof detail.order.payment_terms_days === "number"
            ? (detail.order.payment_terms_days as number)
            : null,
        gross_minor: gross,
        advertiser_name: detail.advertiser_name,
        billing_name: detail.billing_name,
        billing_tax_id: detail.billing_tax_id,
        billing_city: detail.billing_city,
        billing_country: detail.billing_country,
        agency_name: detail.agency_name,
        agency_tax_id: detail.agency_tax_id,
        agency_commission_pct: detail.agency_commission_pct,
        billing_contact: toContact(detail.contacts.billing),
        signer_contact: toContact(detail.contacts.signer),
        payment_contact: toContact(detail.contacts.payment),
        manager_contact: toContact(detail.contacts.manager),
      });
      const { error: uerr } = await db
        .from("io_orders")
        .update({ snapshot_json: snapshot })
        .eq("store_id", storeId)
        .eq("id", id);
      if (uerr) throw new Error(uerr.message);
      console.log(`${num}: foto ok`);
    } catch (e) {
      failures.push(`${num}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failures.length > 0) {
    console.error(`Fallaron ${failures.length}:\n${failures.join("\n")}`);
    process.exit(1);
  }
}

main().catch((e) => fail("SNAPSHOT-SIGNED", e));
