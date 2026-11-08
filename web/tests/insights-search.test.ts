// Búsqueda del muro/inbox: mismo mecanismo fuzzy que screens, órdenes y
// marcas — normalización ES + tokens AND + ranking. El feed filtra en JS
// (20 avisos en cliente: sin RPC, como marcas y órdenes).
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  audienceMentions,
  insightHaystack,
} from "@/lib/insight-mentions";
import {
  matchScore,
  matchTokens,
  normalizeSearch,
  tokenizeSearch,
} from "@/lib/search-text";

const aviso = {
  title: "Terminadas sin certificar · 3",
  body: "3 orden(es) terminada(s) sin foto-check — riesgo de disputa al cobrar.",
  kind: "por_certificar",
  context: {
    company: "León y Asociados",
    brand: "Tottus",
    metrics: [{ label: "En riesgo", value: "3 OIs" }],
  },
  audience: { emails: ["ana@x.pe"], roles: ["seller"] },
};

describe("muro/inbox: haystack aviso + contexto + menciones", () => {
  it("haystack junta título, cuerpo, kind, empresa, marca, métricas y menciones", () => {
    const hay = insightHaystack(aviso);
    for (const t of ["certificar", "foto-check", "leon", "tottus", "riesgo", "@ana", "@seller"]) {
      assert.ok(hay.includes(t), `falta ${t} en ${hay}`);
    }
  });

  it("tildes y mayúsculas no importan", () => {
    const hay = insightHaystack(aviso);
    assert.ok(matchTokens(hay, tokenizeSearch("LEON")));
    assert.ok(matchTokens(hay, tokenizeSearch("león")));
  });

  it("multi-token en desorden calza si todos están", () => {
    const hay = insightHaystack(aviso);
    assert.ok(matchTokens(hay, tokenizeSearch("tottus certificar")));
    assert.ok(matchTokens(hay, tokenizeSearch("leon riesgo")));
  });

  it("la empresa o la marca recuperan el aviso (nuevo alcance)", () => {
    const hay = insightHaystack(aviso);
    assert.ok(matchTokens(hay, tokenizeSearch("leon")));
    assert.ok(matchTokens(hay, tokenizeSearch("tottus")));
    assert.ok(!matchTokens(hay, tokenizeSearch("cusco")));
  });

  it("un token ausente descarta el aviso", () => {
    const hay = insightHaystack(aviso);
    assert.equal(matchScore(hay, tokenizeSearch("tottus cusco"), normalizeSearch("tottus cusco")), -1);
  });

  it("sin tokens todo matchea (sin filtro de texto)", () => {
    assert.equal(matchScore(insightHaystack(aviso), [], ""), 0);
  });

  it("prefijo del query completo rankea primero", () => {
    const tokens = tokenizeSearch("terminadas");
    const q = normalizeSearch("terminadas");
    const head = matchScore(insightHaystack(aviso), tokens, q);
    const other = matchScore(
      insightHaystack({ ...aviso, title: "Ocupación 14d · 42%", body: "muro terminadas" }),
      tokens,
      q,
    );
    assert.ok(head > other);
  });

  it("menciones visibles también indexan", () => {
    assert.deepEqual(audienceMentions({ emails: ["Ana@x.pe"], roles: ["seller"] }), ["@ana", "@seller"]);
    const hay = insightHaystack(aviso);
    assert.ok(matchTokens(hay, tokenizeSearch("@seller")));
  });
});
