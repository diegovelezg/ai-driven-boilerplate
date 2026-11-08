-- Precios de pantallas: redondeo a enteros hacia arriba (ceil).
-- inv_screens.price_pen está en soles (numeric). 146/204 pantallas traían
-- decimales (ej. 129.8, 726.89). Se aplica ceil para dejar enteros.

update inv_screens
set price_pen = ceil(price_pen)
where price_pen is not null and price_pen <> trunc(price_pen);
