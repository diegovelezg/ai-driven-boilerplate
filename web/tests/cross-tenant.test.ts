// Issue #4 P0 + #5 + #6: fail-closed cross-tenant, fin no-medianoche, ZZZ.
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displayEndOf } from "../lib/availability";
import { isValidCurrency, normalizeCurrency } from "../lib/currency";

const ROOT = join(import.meta.dirname, "..");

describe("cross-tenant fail-closed (issue #4 P0)", () => {
  it("rutas [id] responden 404 idéntico sin membresía (nunca 403 oráculo)", () => {
    for (const f of [
      "app/api/companies/[id]/route.ts",
      "app/api/orders/[id]/route.ts",
      "app/api/screens/[id]/route.ts",
    ]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      // Un solo guard SSOT (#4/#8): requireRouteEntity, sin requireStoreMember suelto.
      assert.match(src, /requireRouteEntity/, `${f}: usa requireRouteEntity`);
      assert.doesNotMatch(src, /requireStoreMember/, `${f}: sin doble stack`);
      // 404 propio + enmascarado en el guard (ver abajo): nunca 403.
      const n404 = (src.match(/status: 404/g) ?? []).length;
      assert.ok(n404 >= 1, `${f}: ${n404} respuestas 404`);
      assert.doesNotMatch(src, /status: 403/, `${f}: sin 403 oráculo`);
    }
    // El choke point compartido: delega en requireStoreAccess y responde
    // 404 idéntico en ausencia y en denegación.
    const guard = readFileSync(join(ROOT, "lib/api/guard.ts"), "utf8");
    assert.match(guard, /requireStoreAccess/, "guard delega en requireStoreAccess");
    const guard404 = (guard.match(/status: 404/g) ?? []).length;
    assert.ok(guard404 >= 2, `guard: ${guard404} respuestas 404`);
  });
  it("profile-actions resuelve storeId en servidor (nunca del cliente)", () => {
    const src = readFileSync(join(ROOT, "lib/profile-actions.ts"), "utf8");
    assert.match(src, /resolveTenantStoreAction/, "resuelve tenant en servidor");
    assert.match(src, /clientStoreId/, "param cliente renombrado (compat, no se confía)");
  });
  it("guard delega en tenant.hasStoreMembership (un solo chequeo)", () => {
    const guard = readFileSync(join(ROOT, "lib/api/guard.ts"), "utf8");
    const tenant = readFileSync(join(ROOT, "lib/tenant.ts"), "utf8");
    assert.match(tenant, /hasStoreMembership/, "tenant expone hasStoreMembership");
    assert.match(guard, /hasStoreMembership/, "guard delega en tenant");
  });
});

describe("displayEndOf no-medianoche (issue #5)", () => {
  it("fin medianoche Lima → día anterior", () => {
    assert.equal(displayEndOf("2026-11-25T00:00:00-05:00"), "2026-11-24");
  });
  it("fin no-medianoche NO retrocede un día", () => {
    assert.equal(displayEndOf("2026-11-25T12:00:00-05:00"), "2026-11-25");
  });
});

describe("moneda SSOT rechaza ZZZ (issue #6)", () => {
  it("ZZZ no es moneda válida", () => {
    assert.equal(isValidCurrency("ZZZ"), false);
    assert.equal(normalizeCurrency("ZZZ", "PEN"), "PEN");
    assert.equal(isValidCurrency("XXX"), false);
  });
  it("migración currency_iso incluye ZZZ en denylist", () => {
    const sql = readFileSync(
      join(ROOT, "../supabase/migrations/20261208000000_currency_ssot.sql"),
      "utf8",
    );
    assert.match(sql, /ZZZ/, "DOMAIN + pre-chequeo incluyen ZZZ");
  });
});
