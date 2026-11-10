// SSOT de fechas (lib/format.ts): display + parse/canon en un solo lugar,
// cero inlines o hardcodes fuera. Este test lo impone en dos niveles:
// 1) unidades: el SSOT formatea/parcea con el estilo único;
// 2) estático: ningún otro archivo de producto formatea/parcea fechas a mano.
// Corre con: npm test (node:test vía tsx).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DATE_LOCALE,
  DATE_TIME_ZONE,
  DAY_MS,
  MONTH_SHORT_ES,
  addDays,
  addMonths,
  dayNumToISO,
  diffDaysInclusive,
  displayEndOf,
  displayEndOfSafe,
  firstOfMonth,
  formatDate,
  formatDateTime,
  formatDayMonth,
  formatTimeAgo,
  isISODateShape,
  isValidISODate,
  isoDayPart,
  isoDayToNum,
  limaDayStart,
  monthLabelES,
  parseISODate,
  todayLima,
  toISODateLocal,
  toISODateUTC,
  toMonthKey,
  utcDayStart,
} from "../lib/format";

describe("SSOT fechas: display único dd/mm/yyyy", () => {
  it("formatDate: fecha o ISO → dd/mm/yyyy; inválido → —", () => {
    assert.equal(formatDate("2026-11-03"), "03/11/2026");
    assert.equal(formatDate("2026-11-03T00:00:00-05:00"), "03/11/2026");
    assert.equal(formatDate("2026-11-03T14:05:00-05:00"), "03/11/2026");
    assert.equal(formatDate(null), "—");
    assert.equal(formatDate(""), "—");
    assert.equal(formatDate("no-fecha"), "—");
    assert.equal(formatDate(123 as unknown as string), "—");
  });

  it("formatDateTime: timestamptz → dd/mm/yyyy hh:mm en Lima", () => {
    assert.equal(formatDateTime("2026-11-03T14:05:00-05:00"), "03/11/2026 14:05");
    assert.equal(formatDateTime("2026-11-03"), "03/11/2026");
    assert.equal(formatDateTime("no-fecha"), "—");
    assert.equal(formatDateTime(null), "—");
  });

  it("formatDayMonth: ISO → dd/mm", () => {
    assert.equal(formatDayMonth("2026-11-08"), "08/11");
    assert.equal(formatDayMonth("2026-11-08T00:00:00-05:00"), "08/11");
    assert.equal(formatDayMonth(null), "—");
    assert.equal(formatDayMonth("no-fecha"), "—");
  });

  it("formatTimeAgo usa el mismo dd/mm de respaldo", () => {
    const now = Date.parse("2026-11-08T12:00:00Z");
    assert.equal(formatTimeAgo(new Date(now - 30_000).toISOString(), now), "ahora mismo");
    assert.equal(formatTimeAgo(new Date(now - 5 * 60_000).toISOString(), now), "hace 5 min");
    assert.equal(formatTimeAgo("2026-10-01T00:00:00-05:00", now), "01/10");
  });
});

describe("SSOT fechas: parse/canon", () => {
  it("parseISODate: round-trip estricto (rechaza 2026-02-30)", () => {
    assert.deepEqual(parseISODate("2026-11-03")?.toISOString().slice(0, 10), "2026-11-03");
    assert.equal(parseISODate("2026-02-30"), undefined);
    assert.equal(parseISODate("no-fecha"), undefined);
    assert.equal(parseISODate(""), undefined);
  });

  it("isValidISODate rechaza rollover; isISODateShape solo forma", () => {
    assert.equal(isValidISODate("2026-11-03"), true);
    assert.equal(isValidISODate("2026-02-30"), false);
    assert.equal(isValidISODate("2026-13-01"), false);
    assert.equal(isValidISODate("no-fecha"), false);
    assert.equal(isISODateShape("2026-02-30"), true);
    assert.equal(isISODateShape("3/11/2026"), false);
  });

  it("isoDayPart extrae el prefijo de fecha o ISO", () => {
    assert.equal(isoDayPart("2026-11-03T14:05:00-05:00"), "2026-11-03");
    assert.equal(isoDayPart("2026-11-03"), "2026-11-03");
    assert.equal(isoDayPart("no-fecha"), null);
    assert.equal(isoDayPart(null), null);
  });

  it("toISODateLocal/UTC tienen forma yyyy-mm-dd", () => {
    assert.match(toISODateLocal(new Date(2026, 10, 3, 12)), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(toISODateUTC(new Date(Date.UTC(2026, 10, 3, 12))), "2026-11-03");
  });

  it("addDays cruza mes/año; diffDaysInclusive cuenta inclusivo", () => {
    assert.equal(addDays("2026-11-30", 1), "2026-12-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-11-03", 21), "2026-11-24");
    assert.equal(diffDaysInclusive("2026-11-03", "2026-11-24"), 22);
    assert.equal(diffDaysInclusive("2026-11-03", "2026-11-03"), 1);
    assert.equal(diffDaysInclusive("2026-11-24", "2026-11-03"), null);
    assert.equal(diffDaysInclusive("", "2026-11-03"), null);
  });

  it("ordinal día ↔ ISO es round-trip", () => {
    assert.equal(dayNumToISO(isoDayToNum("2026-11-03")), "2026-11-03");
  });

  it("inicios de día Lima/UTC y hoy Lima", () => {
    assert.equal(limaDayStart("2026-11-03"), "2026-11-03T00:00:00-05:00");
    assert.equal(utcDayStart("2026-11-03"), "2026-11-03T00:00:00Z");
    assert.match(todayLima(), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("displayEndOf: exclusivo → inclusivo; safe no lanza", () => {
    assert.equal(displayEndOf("2026-11-25T00:00:00-05:00"), "2026-11-24");
    assert.throws(() => displayEndOf("NaN-nada"), /Fecha inválida/);
    assert.equal(displayEndOfSafe("2026-11-25T00:00:00-05:00"), "2026-11-24");
    assert.equal(displayEndOfSafe("NaN-nada"), null);
    assert.equal(displayEndOfSafe(null), null);
  });

  it("meses: clave, etiqueta y aritmética sin rollover", () => {
    assert.equal(toMonthKey(new Date(2026, 9, 15)), "2026-10");
    assert.equal(monthLabelES(new Date(2026, 9, 15)), "oct");
    assert.equal(toMonthKey(addMonths(firstOfMonth(new Date(2026, 9, 15)), -1)), "2026-09");
    assert.deepEqual(MONTH_SHORT_ES.length, 12);
  });

  it("constantes del negocio", () => {
    assert.equal(DATE_LOCALE, "es-PE");
    assert.equal(DATE_TIME_ZONE, "America/Lima");
    assert.equal(DAY_MS, 86_400_000);
  });
});

describe("SSOT fechas: cero inlines fuera de lib/format.ts", () => {
  const ROOT = join(import.meta.dirname, "..");
  const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo", "tests", "scripts"]);
  // shadcn DayPicker: plumbing de locale de la lib (no estilo propio).
  // lib/adk: schemas zod de herramientas (contrato de API, no display).
  // lib/sheet-import: fila CSV de ejemplo (dato, no código).
  const ALLOW_FILE = new Set([
    "components/ui/calendar.tsx",
    "lib/sheet-import.ts",
  ]);
  const ALLOW_ADK = "lib/adk/";
  const ALLOW_FORMAT = "lib/format.ts";

  const BANNED: Array<{ re: RegExp; label: string; allow?: (f: string) => boolean }> = [
    { re: /toLocale(Date|Time)?String\s*\(/, label: "toLocale* (usa formatDate/formatDateTime)", allow: (f) => f === ALLOW_FORMAT },
    { re: /Intl\.DateTimeFormat/, label: "Intl.DateTimeFormat", allow: (f) => f === ALLOW_FORMAT },
    { re: /["']en-CA["']/, label: '"en-CA" (usa todayLima/toISODateUTC)', allow: (f) => f === ALLOW_FORMAT },
    { re: /["']es-PE["']/, label: '"es-PE" (usa DATE_LOCALE)', allow: (f) => f === ALLOW_FORMAT },
    { re: /timeZone\s*:/, label: "timeZone inline (usa DATE_TIME_ZONE)", allow: (f) => f === ALLOW_FORMAT },
    { re: /\bget(Date|Month|FullYear|UTCFullYear|UTCMonth|UTCDate)\(\)/, label: "getter de Date (usa parseISODate/toISODate*/isoDayToNum)", allow: (f) => f === ALLOW_FORMAT },
    { re: /padStart\(2/, label: "padStart(2 (usa pad2 del SSOT)", allow: (f) => f === ALLOW_FORMAT },
    { re: /d\{4\}-/, label: "regex de fecha (usa isISODate*/isoDayPart/formatDate)", allow: (f) => f === ALLOW_FORMAT || f.startsWith(ALLOW_ADK) },
    { re: /toISOString\(\)\.slice\(0,\s*10\)/, label: "toISOString().slice (usa toISODateUTC)" },
    { re: /String\([^)]*\)\.slice\(0,\s*10\)/, label: "String(x).slice (usa isoDayPart)" },
    { re: /T00:00:00/, label: "sufijo T00:00:00 (usa limaDayStart/utcDayStart)", allow: (f) => f === ALLOW_FORMAT },
    { re: /86_400_000/, label: "86_400_000 (usa DAY_MS)", allow: (f) => f === ALLOW_FORMAT },
    { re: /Date\.UTC\(/, label: "Date.UTC (usa startOfDayUTC/isoDayToNum)", allow: (f) => f === ALLOW_FORMAT },
    { re: /new Date\([^)]*,/, label: "new Date(y,m,…) (usa parseISODate/addMonths)", allow: (f) => f === ALLOW_FORMAT },
    { re: /hour12/, label: "hour12 (usa formatDateTime)", allow: (f) => f === ALLOW_FORMAT },
  ];

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (SKIP_DIRS.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        if (p === ROOT) continue;
        walk(p, out);
      } else if (/\.(ts|tsx)$/.test(e)) out.push(p);
    }
    return out;
  }

  it("sin formateo/parseo manual de fechas fuera del SSOT", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
      if (ALLOW_FILE.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      for (const { re, label, allow } of BANNED) {
        if (allow?.(rel)) continue;
        const m = re.exec(src);
        if (m) offenders.push(`${rel}: [${label}] …${m[0].slice(0, 40)}…`);
      }
    }
    assert.deepEqual(offenders, [], `formato de fecha fuera del SSOT:\n${offenders.join("\n")}`);
  });
});
