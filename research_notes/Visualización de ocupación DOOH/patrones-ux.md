# Patrones UX para visualizar ocupación y disponibilidad de recursos

Contexto objetivo (noviembre 2026): app web B2B en español, desktop-first pero responsive, para reservar pantallas publicitarias (DOOH) por día, con 1–100 slots por pantalla y día. Pregunta central del equipo: qué patrón usar para un display de disponibilidad por día con slots.

Nota metodológica: la búsqueda web falló durante esta investigación (HTTP 402) y varias páginas de documentación devolvieron 404, por lo que las secciones de bibliotecas se apoyan en documentación primaria verificada por fetch directo (noviembre 2026) y el resto del conocimiento establecido va marcado como inferencia o gap. Donde no hubo fuente verificable se declara el gap en vez de inventar la cita.

## Gantt/timeline: cuándo superan al calendario, bibliotecas, límites a escala

### Takeaway
El timeline de recursos (filas = pantallas, eje X = días) supera al calendario mensual cuando la tarea es comparar disponibilidad entre muchos recursos a lo largo de un horizonte largo; el calendario mensual gana para elegir un día concreto en un solo recurso. A escala 200 recursos × 120 días todas las bibliotecas exigen virtualización/render diferido y agregación; ninguna renderiza 24.000 celdas interactivas sin penalización.

### Cited Findings
- FullCalendar v7 expone vistas `resourceTimelineDay/Week/Month/Year` como funcionalidad Premium, con filas de recursos y eje temporal horizontal configurable, y documenta explícitamente que con muchos recursos o un eje largo hay que activar el renderizado virtual para que solo se rendericen filas y columnas visibles — [Source](https://fullcalendar.io/docs/timeline-view)
- FullCalendar timeline soporta agrupación visual de recursos (`resourceGroupField`), columnas de datos personalizadas en el área de recursos (`resourceColumns`) y hooks de render (`resourceLane`, `slotLane`) para personalizar celdas — [Source](https://fullcalendar.io/docs/timeline-view)
- vis-timeline (open source) modela grupos (ej. salas, personas, recursos) en un eje vertical con items de tipo `box`, `point`, `range` y `background`, y advierte que el ordenamiento personalizado (`order`) no es apto para grandes volúmenes: en esa configuración el Timeline renderiza todos los items una vez para medirlos y recomienda limitarlo a unos pocos cientos de items — [Source](https://visjs.github.io/vis-timeline/docs/timeline/)
- vis-timeline ofrece `cluster` para agrupar items solapados al hacer zoom, con criterios y plantillas de tooltip configurables — [Source](https://visjs.github.io/vis-timeline/docs/timeline/)
- DHTMLX Gantt publica benchmarks de hasta 100.000 tareas pero condiciona el rendimiento a la configuración: exige mantener activado el smart rendering (virtualización, activo por defecto desde v6.2), evitar `autosize` en datasets grandes, usar escalas gruesas (mes/año o `step` alto), acotar el rango visible (`start_date`/`end_date`) y aplicar cambios en lote con `batchUpdate` — [Source](https://docs.dhtmlx.com/gantt/guides/performance/)
- DHTMLX documenta que con rangos de fechas grandes el fondo estático (`static_background`, solo PRO) sustituye el render de líneas de la zona timeline por una imagen de fondo — [Source](https://docs.dhtmlx.com/gantt/guides/performance/)
- Apache ECharts es una biblioteca de charts open source (Apache 2.0) con heatmap, custom series y ejemplos oficiales; es el candidato natural para grillas de utilización cuando no se necesita edición drag-and-drop — [Source](https://echarts.apache.org)

### Inferences
- Para 200 pantallas × 120 días: el timeline con scroll virtualizado + vista agregada por defecto (semana o quincena con drill-down a día) es el patrón correcto para la vista "comparar pantallas"; el calendario mensual por pantalla es el patrón correcto para el picker de fecha dentro del flujo de reserva.
- FullCalendar Scheduler resuelve el caso con `resourceTimeline` + `slotDuration: {days: 1}` + columnas de recurso personalizadas, a costa de licencia Premium comercial; vis-timeline es gratis pero queda corto en virtualización horizontal documentada para 24.000 celdas; ECharts heatmap es gratis y escala bien en canvas para la vista agregada de solo lectura.
- DHTMLX Gantt está orientado a dependencias entre tareas, irrelevantes para slots DOOH independientes: sería sobreingeniería pagar PRO solo por `static_background`.

### Gaps
- No se pudo verificar con fuentes primarias el pricing 2026 de FullCalendar Premium ni de DHTMLX PRO (búsqueda web caída); el redactor debe tratar cualquier cifra de precio como no verificada.
- No se verificó `react-day-picker` modifiers (su URL de docs devolvió 404 en noviembre 2026); su API de modificadores por día para teñir celdas de calendario queda como gap de implementación.
- Faltan benchmarks propios: ninguna fuente primaria confirma fluidez a 200 filas × 120 columnas con celdas interactivas; se recomienda prototipo con datos sintéticos antes de elegir biblioteca.

## Heatmaps de utilización: codificar ocupación parcial y escalas de color

### Takeaway
La convención establecida es una escala secuencial de 3–5 pasos (vacío / bajo / medio / alto / lleno) más un tratamiento visual distinto —no un paso más de la misma rampa— para el 100%, y siempre con etiqueta numérica o tooltip porque el color solo nunca basta.

### Cited Findings
- GitHub documenta su gráfico de contribuciones como una grilla calendario donde la intensidad del verde codifica el volumen diario y el tooltip muestra el recuento exacto; es la referencia de facto del patrón "grilla tipo contribuciones" — [Source](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-github-profile/managing-contribution-graphs-on-your-profile)
- Las rampas secuenciales ColorBrewer (ej. YlGn, Blues, OrRd) están diseñadas y testadas como seguras para daltónicos comunes (versiones "colorblind safe" marcadas), mientras que las rampas arcoíris no lo son — [Source](http://colorbrewer2.org)
- WCAG exige no usar el color como único medio visual de transmitir información (criterio 1.4.1 Use of Color) — [Source](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color)

### Inferences
- Codificación recomendada para slots DOOH por día: 0% = celda neutra clara con "0"; 1–99% = 3 pasos de rampa secuencial (ej. YlGnBu claro→medio→oscuro) con el % o "n/m" impreso; 100% = color sólido distinto (gris oscuro o azul corporativo con check o "Lleno"), no el extremo de la rampa, para que "lleno" se lea como estado, no como cantidad.
- La leyenda debe mostrar los 5 estados con etiqueta textual cada uno ("Libre", "Baja", "Media", "Alta", "Completo") más un ejemplo numérico, no solo una barra de gradiente sin marcas.
- Para modo oscuro o impresión, verificar contraste de texto sobre celdas oscuras (blanco sobre el paso más oscuro) y ofrecer vista "solo números" como alternativa accesible.

### Gaps
- No se encontraron estudios primarios con tasas de error comparando rampas 3 vs 5 pasos en grillas de revenue-management hotelero; la recomendación de 3–5 pasos es consenso de práctica, no dato experimental verificado.
- Pendiente validar paleta exacta con un simulador de deuteranopia/protanopia sobre los colores de marca del producto.

## Indicadores de densidad en calendarios (pickers y drawers)

### Takeaway
En superficies pequeñas el patrón que funciona es doble codificación redundante: sombreado/fondo de celda para el estado grueso + marcador compacto (barra proporcional bajo el número del día o punto) para la cantidad, con tooltip o label al foco; los puntos solos no comunican cantidades y las barras solas fallan sin leyenda.

### Cited Findings
- Material Design 3 documenta el componente Date Picker con días seleccionables, rangos y estados visuales por día sobre una grilla mensual compacta; es la referencia de interacción base para pickers en web — [Source](https://m3.material.io/components/date-pickers)
- Las guías de accesibilidad de Apple (HIG) exigen que la información codificada por color tenga una alternativa no cromática (etiqueta, forma o textura) — principio coherente con WCAG 1.4.1 citado arriba — [Source](https://developer.apple.com/design/human-interface-guidelines/)

### Inferences
- Para el picker "elige día" por pantalla: barra proporcional bajo el número (ancho = % ocupado) + fondo tenue por tramos + número exacto "12/40" en tooltip y en texto accesible (aria-label "12 de 40 espacios ocupados"). La barra comunica proporción de un vistazo; el número la hace exacta.
- Para el drawer mensual multi-pantalla: sombreado de celda en 3 pasos + conteo agregado ("3 pantallas libres") evita el ruido de 200 mini-barras.
- Los dots de "tiene eventos" heredados de calendarios personales son insuficientes aquí: indican existencia, no magnitud; no usarlos como única señal de ocupación parcial.

### Gaps
- No se verificó con fuentes primarias qué densidad mínima de celda (px) mantiene legible una barra proporcional en móvil; requiere prueba en dispositivo con la rejilla real del producto.
- Sin acceso a NNGroup (artículos de calendarios no recuperables en esta pasada), las afirmaciones sobre escaneo visual en calendarios quedan como inferencia de práctica estándar.

## Barras de capacidad y fórmulas "X de Y"

### Takeaway
El patrón dominante en listas y confirmaciones es barra fina + texto "Quedan X de Y" (escasez honesta con números exactos), colocado junto al CTA y repetido en la confirmación; la redacción con número restante concreto supera a etiquetas vagas como "¡Últimos espacios!" o "Alta demanda".

### Cited Findings
- (Sin fuente primaria recuperada en esta pasada; la búsqueda web falló.) La evidencia de e-commerce sobre urgencia honesta vs. urgencia falsa es amplia pero no se pudo citar una fuente concreta verificable en noviembre 2026.

### Inferences
- Ubicaciones: (1) fila de resultado/pantalla en lista → mini-barra + "Quedan 7 de 40 espacios"; (2) picker de fecha → "X de Y" bajo el CTA "Reservar"; (3) confirmación → resumen "Has reservado 5 de los 7 espacios restantes del 12 dic" para prevenir sobrereserva percibida.
- Redacción en español recomendada: "Quedan X de Y espacios" (neutro), "Completo" (no "Agotado", que sugiere producto físico), "X espacios disponibles" cuando X es alto para no fabricar urgencia falsa. Evitar "¡Solo quedan!" en mayúsculas si el inventario es amplio: erosiona confianza B2B.
- La barra debe mostrar lo restante (no lo ocupado) cuando el objetivo es vender: gente interpreta mejor "cuánto me queda por comprar" junto al CTA; mostrar % ocupado junto a la barra solo en vistas de gestión/revenue.

### Gaps
- No se pudo citar un test A/B concreto (ej. Booking.com) que cuantifique la mejora de conversión de "X left" frente a etiquetas vagas; se necesita esa evidencia o un test propio antes de afirmarlo en el informe final.
- Falta definir umbrales de escasez por negocio: ¿a partir de qué % mostrar "Quedan pocos"? (propuesta de partida: <20% o <5 slots, configurable por pantalla).

## Atribución: quién ocupa cada slot sin saturar la vista densa

### Takeaway
El consenso es revelado progresivo en 3 niveles: color o sigla de marca en la celda densa → tooltip/hover con detalle (marca, orden, slots) → drawer lateral con la ficha completa; jamás texto completo de marca dentro de celdas de grilla densa.

### Cited Findings
- vis-timeline soporta plantillas HTML por item (`template`), tooltip por item (`title`, `tooltip.template` con retardo configurable) y color/clase por item (`className`, `style`), es decir, la infraestructura exacta del patrón 3-niveles — [Source](https://visjs.github.io/vis-timeline/docs/timeline/)
- FullCalendar timeline ofrece hooks de render por lane y por celda (`resourceLane`, `slotLane`, `resourceCell`) que permiten inyectar chips/siglas sin re-render completo — [Source](https://fullcalendar.io/docs/timeline-view)

### Inferences
- Nivel 1 (grilla 200×120): celda coloreada por marca top-ocupante o por estado + sigla de 2–3 letras solo si hay espacio (celdas ≥ ~48px); si el día lo ocupan varias marcas, celda segmentada (stacked mini-bar) en vez de un solo color.
- Nivel 2 (hover/foco, desktop; tap en móvil): tooltip o popover con "Marca · Orden #1234 · n slots · contacto"; en táctil el tap sustituye al hover, así que el tooltip debe ser fijable (popover), no solo hover.
- Nivel 3: click abre drawer lateral con la orden completa (líneas, fechas, creatividades, facturación) sin perder la grilla de contexto.
- Regla anti-saturación: máximo 1 sigla + 1 segmento por celda; el resto colapsa en "+n" con el desglose en el tooltip.

### Gaps
- Sin ejemplos verificados de channel managers (Cloudbeds, Mews) ni de desk-booking (Robin, Envoy): sus patrones concretos de atribución en calendario quedan sin citar por caída de la búsqueda; valdría una pasada de screenshots manuales.
- Sin dato sobre cuántas marcas distintas por día son legibles en celda segmentada; hipótesis de trabajo: hasta 3 segmentos, más requiere agregación.

## Anti-patrones: lo que falla sistemáticamente

### Takeaway
Los fracasos recurrentes son cinco: binario rojo/verde, color como única señal, leyendas ausentes o crípticas, urgencia falsa y grillas densas sin agregación ni virtualización.

### Cited Findings
- WCAG 1.4.1: el color no debe ser el único medio visual para transmitir información — viola directamente el binario rojo/verde sin etiquetas — [Source](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color)
- DHTMLX documenta como errores de rendimiento el desactivar smart rendering, usar `autosize` con datasets grandes y recalcular en cada repaint: el equivalente funcional de "renderizarlo todo y rezar" — [Source](https://docs.dhtmlx.com/gantt/guides/performance/)
- FullCalendar exige virtual rendering ante muchos recursos/eje largo: sin ella, la vista colapsa — el anti-patrón es asumir que el timeline "escala solo" — [Source](https://fullcalendar.io/docs/timeline-view)

### Inferences
- Rojo/verde binario falla triple: daltónicos rojo-verde (~8% hombres) no lo distinguen, no expresa parcialidad (el caso 1–99% que es el negocio DOOH) y el rojo connota error/prohibición en vez de "vendido, buen trabajo".
- Leyenda tipo gradiente sin marcas ni números nadie la lee: cada estado necesita etiqueta textual y ejemplo numérico, visible sin scroll junto a la grilla.
- Urgencia falsa ("¡Últimos espacios!" con 80% libre) destruye confianza en comprador B2B recurrente; usar números exactos siempre.
- Celdas con texto completo de marca a 200 filas son ilegibles y rompen el layout: usar sigla/segmento + tooltip (ver sección anterior).
- El "calendario mensual infinito con scroll" como única vista para comparar 200 pantallas obliga a paginar recurso por recurso: siempre ofrecer vista agregada (heatmap/timeline) como puerta de entrada y el calendario como drill-down.

### Gaps
- La tasa de daltonismo y las citas de estudios de error con rojo/verde son conocimiento estándar pero no se recuperó fuente primaria en esta pasada; conviene citar una referencia médica/accesibilidad concreta en el informe final.
- No se documentaron fallos reales de producto (casos públicos de channel managers con quejas de usabilidad); serían oro para el informe pero requieren investigación adicional.
