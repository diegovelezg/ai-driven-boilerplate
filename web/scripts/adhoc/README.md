# scripts/adhoc — one-offs (no pipeline)
<!-- 2026-10-20: creado para el rescate de captions de TuPantalla. -->

Un solo uso contra prod para rescatar/arreglar data. No importarlos desde la app.

Reglas:
- Header con fecha + objetivo + comando exacto.
- Resume-safe (dedup por hash) para poder re-correr.
- Nunca tocan el comentario humano del metadata (fuente de Medusa).
- Si un ad-hoc se vuelve recurrente, se promueve a `scripts/*-once.ts` (pipeline).
