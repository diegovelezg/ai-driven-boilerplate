<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

## Política de DROP seguro (migraciones destructivas)

Toda migración que elimine datos o esquema DEBE blindarse. Reglas obligatorias:

1. **Pre-chequeo con `RAISE`:** antes de cada `DROP TABLE` / `DROP COLUMN`
   destructivo, contar filas y abortar si hay datos que nadie declaró vacíos:
   ```sql
   DO $$
   DECLARE n int;
   BEGIN
     SELECT count(*) INTO n FROM public.mi_tabla;
     IF n > 0 THEN
       RAISE EXCEPTION 'DROP bloqueado: public.mi_tabla tiene % filas; crear _backup o migrar antes', n;
     END IF;
   END $$;
   DROP TABLE IF EXISTS public.mi_tabla CASCADE;
   ```
   La excepción `20261122` ("cero filas" afirmado en comentario sin `RAISE`)
   no se repite.
2. **Backup antes de borrar:** si la tabla/columna puede tener filas en algún
   entorno (prod incluido), renombrar a `_backup_<fecha>` o copiar a
   `_backup` en la misma migración en vez de `DROP` directo. Solo `DROP`
   directo con conteo 0 verificado por el `RAISE` anterior.
3. **Irreversibles documentados:** operaciones sin vuelta atrás (p. ej.
   `ceil(price_pen)` en `20261201`, que redondea hacia arriba) llevan
   comentario `IRREVERSIBLE:` con el porqué y el alcance medido
   (`SELECT count(*) ... WHERE ...` previo).
4. **Verificador:** `supabase/migrations` no acepta `DROP TABLE`/`DROP COLUMN`
   sin su bloque `RAISE` o su `IRREVERSIBLE:`/`_backup` correspondiente.
5. **Grandfather (migraciones pre-política):** la política rige desde
   2026-11-08. Anteriores sin blindaje quedan registradas, no se reescriben
   (ya aplicadas en prod):
   - `20261111` (§§70-106, 6 DROPs) sin `RAISE`/backup.
   - `20261201000000_round_prices_up.sql`: `ceil(price_pen)` — ver
     `IRREVERSIBLE:` en el propio archivo (146/204 pantallas afectadas).
