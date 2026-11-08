-- Precios de pantallas: redondeo a enteros hacia arriba (ceil).
-- inv_screens.price_pen está en soles (numeric). 146/204 pantallas traían
-- decimales (ej. 129.8, 726.89). Se aplica ceil para dejar enteros.
--
-- IRREVERSIBLE: ceil() solo sube, nunca baja; no hay vuelta atrás sin
-- backup. Alcance medido antes de aplicar: 146 de 204 pantallas con
-- decimales (price_pen <> trunc(price_pen)). Grandfather: migración
-- pre-política DROP-seguro (ver AGENTS.md §5), se documenta sin reescribir.

update inv_screens
set price_pen = ceil(price_pen)
where price_pen is not null and price_pen <> trunc(price_pen);
