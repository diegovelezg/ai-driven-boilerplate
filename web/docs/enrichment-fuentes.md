# Enriquecimiento: límites de fuente Mapbox (issue #1 P2)

Fecha: 2026-11-08. No son errores de cálculo: el código reporta fiel lo que
la fuente devuelve. Se documenta para no "arreglar" lo que es fidelidad.

## 2. `place_type=street` en Av. Dos de Mayo (San Isidro)

- Mapbox Geocoding clasifica Av. Dos de Mayo 1836 como `street`.
- `roadHierarchy()` mapea honesto: `street` → "Vía de Conexión Local", score 50.
- No se fuerza a `primary`: inventar jerarquía vial rompería la auditoría.
- Si Mapbox reclasifica a `primary`, el score sube solo (35 pts jerarquía).

## 4. Searchbox `limit=10` (máximo de la API)

- `CATEGORIAS_BUSQUEDA` × 7 categorías con `limit=10`: conteos son cotas
  inferiores por diseño (la API no da más).
- Impacto marginal auditado: intensidad satura en 100, perfiles usan raíz
  0.65 (`Math.pow(count, 0.65)`), anclas top-10.
- No paginar: 7 llamadas best-effort con timeout 15s; más llamadas = más
  latencia en creación de pantalla sin cambio material en score.

## Ver también

- `screens-enrich.ts:183-185` Tilequery con `layers=road,landuse,building`
  (P0, radio efectivo 400 m real en zonas densas).
- `screens-enrich.ts:224,242` `congestionLevel: unknown` cuando no hay
  muestras low/moderate/heavy/severe (P1a, antes mentía `low`).
- `screens-enrich.ts:270-277` hoteles excluidos de `ptsNodos` (P1b, doble
  conteo con `travel_transit`).
