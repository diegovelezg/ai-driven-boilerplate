# Visualización de ocupación DOOH — estado actual de la UI

> Notas de inventario solo-código (sin cambios). Ámbito: `web/` del repo DOOH ops manager.
> Convención de fuentes: `ruta:línea`. UI en español. Stack visual: Tailwind + shadcn-style
> `Calendar` (`components/ui/calendar.tsx`, wrapper de `react-day-picker` `DayPicker`),
> `DataTable/*` (`components/data-table.tsx`), `Money` (`components/money.tsx`),
> badges (`components/badges.tsx` ← `lib/ui-badges.tsx`).

## 1. Superficies que comunican ocupación/disponibilidad

### Takeaway
Hay 7 superficies: 2 pickers del flujo de orden (multiselect + tabla), 1 diálogo calendario por pantalla,
1 vista inventario por pantalla (`pantalla-ocupacion.tsx`), 1 página matriz `/occupancy`,
dashboard (métrica + huecos) y 2 tools de agente chat. Solo la vista inventario muestra
estados parciales con color propio; el resto es binario rojo/verde o texto.

### Cited Findings
- Order flow — `ScreenMultiSelect` (`app/(dashboard)/orders/order-screens/screen-multiselect.tsx:20-62`):
  ocupa = visible pero no seleccionable (`blocked`, `:156-190`). Nota por fila `:165-167`:
  `Parcial · {io_number · brand} · hasta {until}` si `free>0`, si no `No disponible · …`.
  `restNote` (`:161-164`) muestra `Quedan X de Y slots` solo cuando la fila NO está bloqueada
  y `free < cap`. Footer `:222-244`: `Todo libre en {periodLabel}` / `{n} ocupadas en {periodLabel}` +
  botón próximo hueco. Checkbox `Solo disponibles` filtra (`:67-70`). Precio `PEN {n}` por fila (`:201-203`).
- Order flow — `OrderScreensTable` (`app/(dashboard)/orders/order-screens/order-screens-table.tsx:81-102,113-139`):
  banner `N sin cupo(s) en ese periodo` + botón `Mover al próximo hueco` o `Sin hueco común libre en 12 meses`.
  Fila bloqueada con fondo `bg-destructive/5` (`:131`). `blockedLabel` (`:117-123`):
  `Parcial|Llena · quedan F de C slots · {io·brand} ({días}) — quítala o cambia fechas`.
  Precio/slots editables; input slots se deshabilita solo si `free<=0` (`:163`), precio si hay choque (`:145`).
- Order flow — `ScreenCalendarDialog` (`app/(dashboard)/orders/order-screens/screen-calendar-dialog.tsx:82-105`):
  `Calendar mode="range"`, `modifiers={{booked}}`, clase `bg-destructive/10 text-destructive line-through`
  (`:87`), `disabled={booked}` (`:88`). Leyenda `:96-105`: `sin cupo · libre desde {free} ·
  quedan {minFree} de {capacity} slots en el periodo` (o `{capacity} slots/día`) `· hueco de Nd: {fecha}`
  + botón `Usar …`. Sin modificador parcial: días con resto >0 pero <q se ven libres.
- Hook compartido — `useScreenAvailability` (`app/(dashboard)/orders/order-screens/use-screen-availability.ts:16-87`):
  debounce 400ms, llama en paralelo `checkAvailabilityAction` + `getScreenOccupancyAction` (`:59-62`).
  Expone `occupiedOf/untilOf/remainingOf/capacityOf/occupiedCount/periodLabel/commonWindowFor/
  nextWindowLabelFor/ensureOccupancy` (`:151-171`). `remainingOf` = mínimo de slots libres en el
  periodo, null sin periodo (`:106-113`). Calendario carga perezosa por pantalla (`:136-149`).
  Consumido igual en nueva orden (`app/(dashboard)/orders/new/nueva-form.tsx:107-108,642-643,679-680,716-717`)
  y edición (`app/(dashboard)/orders/order-lines-form.tsx:141-142,320-321,346-347,385-386`).
- Inventario por pantalla — `PantallaOcupacion` (`app/(dashboard)/screens/pantalla-ocupacion.tsx:52-266`):
  fetch `GET /api/screens/:id/occupancy?past=90&future=120` (`:59`). Tarjeta `Próximos 30 días` (`:152-183`):
  `Hoy: Llena|Libre` (`:157`), `{io·brand} · quedan F de C slots` (`:159-166`), `Ocupación 30d {pct}%`
  = días llenos/30 (`:122-126,169-173`), `Libre desde {fecha}` (`:176-180`).
  Calendario (`:185-203`) con DOS modificadores: `booked` → `bg-destructive/10 text-destructive line-through`,
  `partial` (días `0<free<capacity`, `:135-140`) → `bg-amber-500/15 text-amber-700` (`:189-193`).
  Leyenda `:195-202` con swatches rojo/ámbar + nota `el borrador aparta 7 días, vencido libera solo`.
  Listas con atribución: `Órdenes próximas (≤20, hasta 120d)` (`:205-236`) y `Historial (≤10, 90d atrás)`
  (`:238-263`); cada fila `{io_number · brand} · {fechas} · {N} slots` + `OccupancyBadge/UpcomingBadge/
  HistoryBadge` (`:213-229,246-258`). Es la ÚNICA superficie con color parcial + atribución por ítem + slots.
- Matriz `/occupancy` — página server (`app/(dashboard)/occupancy/page.tsx:20-156`) + cliente
  `OccupancyTimeline` (`app/(dashboard)/occupancy/occupancy-timeline.tsx:24-272`):
  header `Filas = pantallas, columnas = días. Rojo ocupado, verde libre.` (`page.tsx:132-136`).
  Ventana `[desde, desde+dias-1]`, dias ∈ {7,14,28} default 14 (`page.tsx:28-30,124`).
  Llama `getScreenConflicts(storeId, desde, lastStr)` SIN slots → q=1 (`page.tsx:125`).
  Celdas binarias: `bg-rose-500/70` ocupado vs `bg-emerald-500/20` libre (`timeline:234-239`);
  tooltip `Ocupado · {io·brand||source}` / `Libre · {día}` (`:228-232`). Filtros q/proveedor/ciudad/
  estado + shift ±días + `SegmentedControl` 7/14/28d (`:111-184`). Contador
  `{n} pantallas · {pct}% ocupado` (`:179-183`). Clic en fila abre `PantallaDrawer` (`:269`).
  Ficha drawer tiene tab `Ocupación` (`app/(dashboard)/screens/pantalla-drawer.tsx:386`) que monta
  `PantallaOcupacion`.
- Dashboard `/` — `app/(dashboard)/page.tsx:85-129` ← `lib/dashboard.ts:291-317,437-444,488,497`:
  `Metric Ocupación 14d` = `{vendidos} de {disponibles} pantalla-día` + % (`page.tsx:85-91`);
  cálculo pantalla-día binario por líneas (ignora bookings/hold y capacidad slots: `occupied.add(screen:day)`
  si hay solape, `:294-313`; ratio `vendidos/disponibles`, `:315-317`).
  `Huecos vendibles` = top-5 pantallas con más días libres 14d, `{nombre} · {n}d libres` (`page.tsx:113-129`,
  `dashboard.ts:437-444`). Sin atribución de orden ni parcialidad por slots.
- Chat agent — `lib/adk/agents/customer-agent.ts:219-311` (`get_screen`) y `:313-385` (`search_inventory`):
  `get_screen` devuelve `free: mine.length===0`, `conflicts: mine.slice(0,5)` (io/brand/starts/ends/source),
  `occupancy_next_400d: ranges.slice(0,20)`, counts y `deep_link /screens?screen=` (`:284-305`).
  `search_inventory` sin from/to → `hint: Sin periodo: ocupación no evaluada`; con periodo →
  por pantalla `free` + `conflicts.slice(0,3)` (`:337-379`). Todo binario (vía `getScreenConflicts`
  default q=1), sin remaining/capacities en la respuesta.

### Inferences
- La "verdad" slot-aware vive en servidor (`remaining/capacities/minFree`) pero solo 2 superficies
  la pintan con fidelidad (tabla de orden como texto, inventario como color+texto); matriz, dashboard
  y agente la colapsan a binario.
- `PantallaOcupacion` es el patrón a imitar para parciales (modificador `partial` ámbar + `quedan F de C`).

### Gaps
- No hay conteo de pantallas con `capacity>1` vs `=10` default en estas notas (requeriría query viva).
- `pantalla-drawer.tsx` tab Ocupación no se leyó a fondo más allá de `:386`.

## 2. Datos disponibles hoy (lib, actions, API)

### Takeaway
El backend ya es slot-aware y con atribución: `ScreenConflict` trae io/brand/source + blockedDays +
capacity/requested/remaining(minFree); `getPeriodAvailability` trae `remaining` día×pantalla y
`capacities`; el endpoint `/occupancy` trae `items` (cada pauta con slots) + `remainingByDay` + `capacity`.
Todo lo necesario para parciales + atribución viaja o se obtiene con 1 llamada.

### Cited Findings
- `lib/availability.ts:20-35` — `ScreenConflict { screen_id, io_number|null, brand|null, starts, ends,
  source: order|booking, blockedDays?, capacity?, requested?, remaining? (mínimo libre en periodo) }`.
- `lib/availability.ts:243-303` — `PeriodAvailability { conflicts, remaining: screenId→día→libres,
  capacities }`. `getPeriodAvailability(storeId, screenIds|null, starts, ends, {excludeIoId, slots})`:
  `remaining[id][día] = max(0, capacity - reservados)` (`:279-281`), `blocked = días con free<q` (`:283`),
  conflicto con `starts/ends` = extremos de blocked + `remaining: minFree` (`:286-300`).
- `lib/availability.ts:310-336` — `getScreenOccupancy(storeId, ids, from, {excludeIoId, slots})`:
  rangos sin cupo 400d relativos a q (`free<q`, `:328-333`); días parciales NO entran al rango
  (documentado `:305-309`: `los días con resto parcial no entran al rango pero sí a remaining`).
- `lib/availability.ts:83-118` — `getScreenCapacities`: slots propios activos o fallback
  `default_slots_per_screen` (`DEFAULT_SLOTS_PER_SCREEN`, de `lib/store-slots.ts`).
- `lib/availability.ts:129-219` — `loadAvailabilityGrid`: fuentes = `io_lines` vigentes
  (excluye `cancelled`; `draft` solo si `isHoldFresh`, `HOLD_DAYS=7`, `:17-18,43-48,165-166`) +
  `inv_bookings` vigentes × `inv_slots` (1 slot c/u, `:189-213`). Atribución `info` = PRIMER
  io/brand por pantalla (`note` solo si ausente, `:148-150`) — puede ocultar co-ocupantes.
- `lib/order-actions.ts:629-636,756-781` — `AvailabilityState { ok, conflicts, remaining, capacities,
  message }`; `checkAvailabilityAction({starts, ends, excludeIoId, screenIds≤200, slots})` envuelve
  `getPeriodAvailability` (`:769-776`).
- `lib/order-actions.ts:783-816` — `OccupancyState { ok, occupancy: id→OccupiedRange[], capacities,
  message }`; `getScreenOccupancyAction({screenIds≤200, from, excludeIoId, slots})` (`:792-811`).
  NO devuelve remaining diario ni items/atribución — solo rangos + capacidades.
- `app/api/screens/[id]/occupancy/route.ts:26-137` — `GET ?past=90&future=120` (clamp 0-365, `:37-41`):
  responde `{ from, to, today, ranges (días sin cupo q=1), items: OccupancyItem[] {starts, ends,
  io_number, brand, status, source, slots}, capacity, remainingByDay }` (`:132`).
  `ranges` derivado de `conflicts.find(...).blockedDays` con q=1 (`:111-131`); `capacity` fallback 10
  si falla avail (`:109`). `items` ordenados por starts (`:106`). Bookings aportan `slots: 1` (`:101`).
- `lib/availability-utils.ts:10-51` — `OccupiedRange {starts, ends}` (`:10-13`); `firstFreeDay`,
  `nextFreeWindow(duration)` (horizonte 365), `unionRanges` (`:21-51`). Puro cliente.

### Inferences
- Para parciales en pickers/calendarios basta lo que ya viaja: `remainingOf/capacityOf` (mínimo del
  periodo) + `remaining` diario (ya en estado del hook) + `getScreenOccupancyAction.capacities`.
  Para atribución en pickers bastaría añadir `blockedDays` (ya en `ScreenConflict`) al tooltip/texto
  — o 1 fetch al endpoint `/occupancy` por pantalla (items con slots).
- `getScreenOccupancyAction` es el único eslabón que PIERDE información (rangos binarios sin remaining
  diario); el diálogo calendario no puede pintar parciales sin extenderlo o reusar `remaining` del hook.

### Gaps
- `AvailabilityState`/`OccupancyState` no incluyen `blockedDays` por día con libres exactos en la
  acción de ocupación (solo en conflictos del periodo); habría que confirmar consumo exacto en
  `nueva-form.tsx:642-717` (no leído a fondo).

## 3. Qué componentes reciben slot-data y qué hacen con ella

### Takeaway
`remainingOf/capacityOf/minFree/capacity` llegan a tabla, multiselect y diálogo calendario, pero solo
la tabla y el inventario los muestran siempre; el multiselect los muestra a medias y el diálogo
calendario recibe `capacity/minFree` pero NO pinta parciales en el calendario.

### Cited Findings
- Reciben y RENDERIZAN:
  - `OrderScreensTable` (`order-screens-table.tsx:33-34,52-53,115-123`): usa `remainingOf/capacityOf`
    en `blockedLabel` (`quedan F de C slots`, `Parcial|Llena`). Renderiza siempre que hay choque.
  - `ScreenCalendarDialog` texto (`screen-calendar-dialog.tsx:30,44,99-101,385-386` en callers):
    `capacity` + `minFree` → `quedan {minFree} de {capacity} slots en el periodo` (`:100`).
  - `PantallaOcupacion` (`pantalla-ocupacion.tsx:112-118,135-140,159-166`): `capacity` + `remainingByDay`
    → `quedan F de C slots`, modificador `partial` ámbar, `Ocupación 30d %`, `Llena|Libre hoy`.
- Reciben y renderizan PARCIALMENTE:
  - `ScreenMultiSelect` (`screen-multiselect.tsx:28-29,159-167`): `remainingOf/capacityOf` → `restNote`
    `Quedan X de Y slots` solo si NO bloqueada (`:161-164`); si bloqueada, el `note` (`:165-167`) dice
    `Parcial · io·brand · hasta …` pero SIN `quedan F de C` (el dato existe y no se muestra).
    `SelectionBadge` de elegidas (`:249-264`) no muestra estado.
  - `OccupancyTimeline` (`occupancy-timeline.tsx:57-76,223-242`): recibe `conflicts` (con
    capacity/requested/remaining/blockedDays) pero SOLO usa `starts/ends` + `io_number/brand/source`
    para el tooltip; ignora `blockedDays/capacity/remaining`. Sin slots ni parciales.
- Reciben y IGNORAN:
  - Dashboard `Metric`/`Huecos` (`page.tsx:85-129`, `dashboard.ts:291-317`): cálculo propio pantalla-día,
    ignora capacities/slots por diseño (nota `:291`: `por líneas, no por bookings hold`).
  - Agente (`customer-agent.ts:282-283,351`): llama `getScreenConflicts` default (q=1) y descarta
    `blockedDays/capacity/requested/remaining` al mapear (`:370-376` solo io/brand/starts/ends/source).
- Tech disponible para el rediseño (verificado en código):
  - `Calendar` acepta `modifiers` + `modifiersClassNames` arbitrarios (probado con `booked`+`partial`
    en inventario, `:189-193` pantalla-ocupacion); `disabled` acepta rangos (`screen-calendar-dialog.tsx:88`).
  - `DataTable/DrawerTable`, `Money`, `OccupancyBadge/HistoryBadge/UpcomingBadge/SelectionBadge`
    existentess (`components/badges.tsx:74-112`, `lib/ui-badges.tsx:170-194`).
  - Locale español `es` de `react-day-picker/locale` en ambos calendarios.

### Inferences
- Brecha central: el modificador `partial` ámbar existe SOLO en inventario; llevarlo al diálogo de
  orden + matriz es mecánico (los datos ya están en el hook / endpoint).
- Segunda brecha: atribución (`qué orden ocupa`) existe en tabla (texto), inventario (listas) y matriz
  (tooltip), pero FALTA en multiselect-bloqueadas-detalle (solo primer ocupante), calendario de orden
  (ninguna) y dashboard/agente (ninguna).

## 4. Brechas concretas vs "ocupación + qué orden ocupa, con parciales visibles"

### Takeaway
Hoy se comunica "libre/ocupado" con atribución mínima; la distinción 1/10 vs 10/10 y el "quién ocupa"
faltan en 4 de 7 superficies. El inventario es la referencia de llegada.

### Cited Findings
- Binario sin distinción 1/10 vs 10/10: matriz (`timeline:234-239` celdas rose/emerald),
  dashboard (`dashboard.ts:294-313` set pantalla:día), agente (`free: busy.length===0`,
  `customer-agent.ts:299,369`), calendario de orden (`screen-calendar-dialog.tsx:82-88` solo `booked`).
- Sin atribución de orden: calendario de orden (ninguna; solo `libre desde`, `:96-105`),
  dashboard huecos (solo nombre + días libres, `page.tsx:121-128`), `SelectionBadge` elegidas
  (`screen-multiselect.tsx:249-264`), tooltip matriz solo primer ocupante (`timeline:228-232`
  usa `hit` = primer rango que cubre el día; `availability.ts:148-150` guarda solo el primero).
- Parcial a medias: multiselect bloqueada dice `Parcial` pero sin cifras (`:165-167` vs `restNote`
  `:161-164` que sí tiene cifras pero solo para no-bloqueadas); tabla sí dice
  `Parcial · quedan F de C` (`order-screens-table.tsx:117-123`); inventario es el único con color
  parcial (`pantalla-ocupacion.tsx:189-193`).
- Página ocupación lista sin slot counts: matriz no muestra `capacity/requested/remaining` aunque
  viajan en `ScreenConflict` (`page.tsx:125` los pide implícitamente y `timeline:57-64` los ignora).
- Inconsistencia de capacidad: endpoint usa q=1 para `ranges` (`route.ts:111-112`) mientras el flujo
  de orden usa q=slots pedidos (`use-screen-availability.ts:58-61`); un día 9/10 se ve rojo en
  inventario y libre en el picker de 1 slot, y viceversa.

### Gaps
- Sin acceso a datos vivos no se cuantifica cuántas pantallas tienen `capacity != 10` ni el volumen
  de días parciales reales; el rediseño debería prever ambos casos.
- No verificado si `io_check_hold_overlap` (mencionado en `search_inventory` description,
  `customer-agent.ts:317`) impone alguna regla visual adicional; solo se cita como hard-hold.
