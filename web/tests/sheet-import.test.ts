import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  headerIndex,
  isGoogleSheetUrl,
  normalizeCompanyRow,
  normalizeContactRow,
  normalizeScreenRow,
  normalizeVenueRow,
  parseCsv,
  sheetUrlToCsvUrl,
  validateImportCsv,
} from "@/lib/sheet-import";

describe("sheetUrlToCsvUrl", () => {
  it("convierte /edit a export csv", () => {
    const out = sheetUrlToCsvUrl("https://docs.google.com/spreadsheets/d/ABC123/edit#gid=5");
    assert.equal(out, "https://docs.google.com/spreadsheets/d/ABC123/export?format=csv&gid=5");
  });
  it("rechaza no-sheets", () => {
    assert.equal(sheetUrlToCsvUrl("https://example.com/x.csv"), null);
    assert.equal(isGoogleSheetUrl("https://example.com/x.csv"), false);
    assert.equal(isGoogleSheetUrl("https://docs.google.com/spreadsheets/d/ABC/edit"), true);
  });
});

describe("parseCsv", () => {
  it("maneja comillas y saltos", () => {
    const rows = parseCsv('a,b\n"ho,la",2\n"x\ny",3\n');
    assert.deepEqual(rows, [
      ["a", "b"],
      ["ho,la", "2"],
      ["x\ny", "3"],
    ]);
  });
});

describe("normalize rows", () => {
  it("company requiere name y valida tipo", () => {
    const idx = headerIndex(["name", "kind"]);
    assert.equal(normalizeCompanyRow(["", "agencia"], idx).ok, false);
    assert.equal(normalizeCompanyRow(["Acme", "cliente"], idx).ok, false);
    const r = normalizeCompanyRow(["Acme", "agencia"], idx);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.kind, "agencia");
  });
  it("venue exige loop coherente en screens", () => {
    const v = normalizeVenueRow(["RP", "mall", "", "", "", "", "", "supplier", ""], headerIndex(["name", "venue_type", "latitude", "longitude", "city", "country", "timezone", "ownership", "supplier_ref"]));
    assert.equal(v.ok, false); // supplier sin ref
    const s = normalizeScreenRow(
      ["v1", "LED", "", "", "", "", "", "", "own", "60000", "6", "9999", ""],
      headerIndex(["venue_ref", "name", "width_px", "height_px", "orientation", "technology", "placement", "player_id", "ownership", "loop_duration_ms", "loop_slots", "slot_duration_ms", "external_ref"]),
    );
    assert.equal(s.ok, false); // 6×9999 ≠ 60000
  });
  it("validateImportCsv cuenta ok/errores", () => {
    const v = validateImportCsv("companies", "name,kind\nAcme,agencia\n,anunciante\n");
    assert.equal(v.ok, 1);
    assert.equal(v.errors.length, 1);
    assert.equal(v.errors[0].row, 3);
  });
  it("company conserva external_ref y contact exige company_ref", () => {
    const r = normalizeCompanyRow(
      ["Acme", "20123456789", "acme-001", "anunciante"],
      headerIndex(["name", "tax_id", "external_ref", "kind"]),
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.external_ref, "acme-001");
    const c = normalizeContactRow(
      ["acme-001", "Ana", "ana@acme.pe"],
      headerIndex(["company_ref", "first_name", "email"]),
    );
    assert.equal(c.ok, true);
    if (c.ok) assert.equal(c.value.company_ref, "acme-001");
  });
});
