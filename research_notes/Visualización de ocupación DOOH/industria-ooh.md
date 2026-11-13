# Visualización de ocupación e inventario en la industria OOH/DOOH

## Cómo muestran las plataformas qué pantallas están reservadas vs. libres

### Takeaway
El referente documentado más completo es Broadsign Platform (módulo Guaranteed Campaigns, docs actualizadas a nov-2026): disponibilidad en tiempo real integrada con el CMS, con columnas de Availability y Occupancy por pantalla/cara más un "Goal chip". Los marketplaces self-serve (Blip, Fliphound) no exponen calendario de ocupación: usan disponibilidad binaria por cartel y subasta/cupos, sin vista temporal de reservas.

### Cited Findings
- Broadsign Guaranteed Campaigns "taps into the power of real-time inventory availability" and lets sales teams "quickly identify the best available screens or faces", "avoid double-booking" with inventory fully integrated with content/network management — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/guaranteed-campaign.html)
- Broadsign screen-selection UI has three availability primitives: Goal Achievability chip (%, right side), Availability column (per-screen bookability within flight dates), Occupancy column (% of time occupied for the flight) — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-screen-availability.html)
- Same three primitives exist for static faces (billboards): Goal chip, Availability column, Occupancy column; occupancy 25% means "booked for a quarter of the line item duration, such as 1 week out of a 4-week line item" — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-face-availability.html)
- Broadsign Booking Level widget shows "fill level of the screens or faces over time" with per-Hour, per-Day, or per-7-Days granularity; dark blue = booked, grey = held; clicking an Occupancy % filters to that screen's booking detail — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-booking-levels.html)
- Blip exposes no time-based occupancy: signs are either listed (available) or removed/"Temporarily Unavailable"; buyers are told availability "can change at any time" and to add unavailable boards anyway since "your campaign won't run on those signs until they become available" — [Source](https://help.blipbillboards.com/sign-availability-faq)
- Blip charges "only for each time your ad displays"; if all signs become unavailable "your campaign will pause until you make changes" — no booking/overbooking concept, it is a remnant pay-per-flip marketplace — [Source](https://help.blipbillboards.com/sign-availability-faq)
- Fliphound sells fixed rotation slots per board (¼ slot ~4 min rotation, ½ slot ~2 min, Full slot ~1 min) combined with campaign duration (1 day → 4 weeks), computing plays/views/CPM — quantity-of-play packaging, no availability calendar visible pre-signup — [Source](https://www.fliphound.com/online-national-digital-billboard-network)

### Inferences
- Direct-sales CMS tools (Broadsign) treat availability as a computed function of (screens × flight dates × ad duration × type-of-buy), not a static calendar field; marketplaces treat it as binary eligibility plus auction/budget pacing.
- Static (printed faces) uses day-count occupancy; digital uses loop-time occupancy — two different denominators under one UI.

### Gaps
- No reliable sources found on Vistar Media, Hivestack/Perion, Place Exchange, Adomni, or OneScreen.ai availability/occupancy UI: web search API was unavailable (HTTP 402) and direct fetches to support.vistarmedia.com, help.adomni.com, vistarmedia.com solutions pages, placeexchange.com/product and onescreen.ai/billboards failed (transport/404). Their seller-side availability views remain unverified.
- Broadsign screenshot contents are described from docs text/alt-text only; actual pixel-level encodings (exact hues, bar geometry) could not be inspected.

## Qué codificaciones visuales usan (binario, %, heatmaps, Gantt, listas)

### Takeaway
Broadsign usa una lista tabular con semáforos de 3 estados + columnas numéricas + widget de niveles apilados en el tiempo; no hay evidencia de heatmaps ni Gantt por pantalla en sus docs. Es un patrón "lista + chip de objetivo + gráfico de llenado temporal", no un calendario de pared.

### Cited Findings
- Availability column states: Available (Green), Partial (Blue), Unavailable (Amber), each with warning icons (blocking-schedule icon for inactivity events; triangle for other warnings such as "screen scheduled to go live on [date]"); hover shows tooltip with reason(s); icons also propagate to the Summary bar Screens/Faces tile — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-screen-availability.html)
- Goal chip color encoding: Green = 100%+ of goal achievable (requires ALL selected screens available for entire flight); Amber = 0.1–99.99% partial; Red = 0% — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-screen-availability.html)
- Goal % math differs by buy type: Fixed buys (Frequency, Fixed SoV, Takeover) show average availability across screens (e.g. 100% + 80% → 90%); flexible buys (Impressions, Plays, Avg SoV) show % of goal reachable, which can read 100% "even if one of the selected screens is completely full" — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-screen-availability.html)
- Booking Level widget is a stacked area-over-time chart (dark blue booked / grey held, hover shows % per day) with Hour/Day/7-day zoom, reflecting current screen/face selection or filter set — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-booking-levels.html)
- Occupancy column is a numeric % per screen/face, sortable ("sort them based on their Occupancy") to pick low-occupancy screens — e.g. choosing 50 takeover screens with lowest occupancy to minimize displacement — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-screen-availability.html)
- Unachievable-goal alerts appear in three redundant places: top-right alert with reachable %, summary panel max impressions/reach, and a left-side availability bar whose form differs per type-of-buy — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-face-availability.html)
- Blip buyer UI offers map view + table view + filters for locations, with binary "Temporarily Unavailable" tagging — no utilization %, no timeline — [Source](https://help.blipbillboards.com/sign-availability-faq); [Source](https://help.blipbillboards.com/how-to-create-and-launch-a-blip-campaign)

### Inferences
- The traffic-light-plus-percentage list pattern fits seller workflows (filter → compare → shortlist faces), whereas a wall-calendar/Gantt would fit operations; Broadsign splits these (sales sees list+booking widget; ops presumably sees loop scheduling in Broadsign Control).
- Blue = "partial" (not yellow) is a notable convention choice, reserving amber/red for hard blocks.

### Gaps
- No evidence found of heatmap, Gantt/timeline-per-face, or utilization-dial encodings in any vendor's public docs; whether Broadsign Control (player-side CMS) shows a loop timeline/Gantt is unverified.
- Exact visual form of the "availability bar" per type-of-buy is described only by reference, not depicted in retrievable text.

## Cómo comunican QUIÉN ocupa vs. solo QUE está ocupado, y disponibilidad parcial (share of voice, loops con slots libres)

### Takeaway
Broadsign separa ambas capas: el vendedor ve primero ocupación agregada anónima (%, disponible/parcial/no) y con un clic revela la atribución completa (línea, campaña, anunciante, cliente, dueño, precio, prioridad) en la tabla Fill Rate Details; el loop parcial se cuantifica en segundos de slot y en "Avg Availability" (slots enteros redondeados hacia abajo).

### Cited Findings
- Clicking an Occupancy % opens the Fill Rate Details table listing every occupying line item with: Line Item Name, Campaign Name, Occupancy, Status, Type of Buy, Priority, Start/End dates, Advertiser, Client, Screens/Faces Number, Price, Owner; admin can restrict Direct Sales users to only their own campaigns ("Other lines are hidden, but they are included in the total booking levels") — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-booking-levels.html)
- Occupancy semantics for digital: % of loop/flight time that fits the requested buy; e.g. 80% occupancy = 20% open, "reserved due to blocking day parts or pre-existing bookings" — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-screen-availability.html)
- Per-buy-type occupancy math documented with worked examples: Frequency and Fixed SoV use avail-time/total-time fit tests against loop length (e.g. 70s used + 15s slot vs 90s loop); Takeover is binary (100% free required or 0%); Impressions/Budget/Plays count any free sliver ≥ 0.01 saturation as available; Daily Avg-per-Screen SoV counts qualifying days/total days — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-screen-availability-occupancy.html)
- Avg Availability column shows "average number of integer slots available for booking", computed from ad duration × flight × day parts, always rounded DOWN to whole slots — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-screen-availability.html)
- Blocking day parts (roadworks, damage, maintenance, blackouts, uncommissioned screens) make screens "temporarily out-of-charge": blocked ≥ flight → 0% + booking prevented; blocked < flight → blocked time excluded from availability math; a lock icon marks the conflict — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-screen-availability.html)
- Fixed slot durations (e.g. bylaw-mandated 7s/9s slots) propagate from Broadsign Control into availability math; a 10s creative plays 10s/7s/9s on three different screens — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/guaranteed-campaign.html)
- Advanced Availability Check: when goal < 100%, one click runs a reallocation simulation (up to 5 min) to test whether reshuffling existing campaigns frees space, then "Create Line" to book — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-screen-availability.html)
- Takeover booking shows PRE-takeover occupancy so planners pick emptiest screens — [Source](https://docs.broadsign.com/broadsign-platform/Documentation_Gteed_Campaigns/g-c-screen-availability.html)
- Buyer-side marketplaces show no attribution at all: Blip advertisers never see who else occupies a sign, only whether their own ad displays (and billing is per-display) — [Source](https://help.blipbillboards.com/sign-availability-faq)

### Inferences
- Progressive disclosure (aggregate % → per-line-item attribution with privacy role-gating) is the key UX pattern for seller-side occupancy: it keeps the shortlist view scannable while preserving negotiability ("contact its owner… negotiate").
- Partial availability is never shown as raw free seconds to sellers — always normalized to the buy at hand (slots, % of goal, qualifying days).

### Gaps
- Whether competing sellers see advertiser NAMES vs anonymized "held/booked" in Broadsign when restriction is off is documented only via the CSV-exportable Fill Rate table; in-list identity display is unverified.
- Programmatic-guaranteed / PMP availability UX (Vistar, Place Exchange, Hivestack SSP views of "available impressions by venue/date") found no citable source — biggest gap for the buyer-side half of the objective. (Parcialmente cerrado en "Segunda pasada: huecos" abajo: Place Exchange Publisher Portal y SSP describen control de inventario/deals/reporting sin calendario de ocupación verificable; Vistar SSP+Ad Server integrados; Perion/Hivestack deal types y planner con "screen availability" como input sin UI de calendario verificable; Adomni sí verificado con utilization/play-usage.)

---

## Segunda pasada: huecos (verificación 12-nov-2026)

Método: web search API siguió indisponible (HTTP 402, igual que en la primera pasada); se recurrió a fetches directos de páginas de vendor y help centers. Todo lo afirmado abajo tiene fuente primaria citada; lo no verificado se marca explícitamente como tal. Nada de esta sección reescribe lo anterior.

### 1. Vistar Media (seller / media-owner UI)

#### Takeaway
Vistar no expone públicamente ninguna UI de disponibilidad/ocupación: la gestión de inventario seller-side vive tras login (DSP/SSP/Ad Server, Cortex CMS). Lo verificable es arquitectónico: SSP + Ad Server integran campañas loop-based y programáticas en una sola plataforma, y el planner usa "screen availability" como input.

#### Cited Findings
- Vistar's SSP "brings automation to advertising in the real world... allowing media owners to manage OOH inventory efficiently" — [Source](https://www.vistarmedia.com/for-media-owners)
- "Our Ad Server integrates loop-based and programmatic campaigns so media owners choreograph inventory with one smart management platform for OOH" — [Source](https://www.vistarmedia.com/for-media-owners)
- "Cortex is designed as an intuitive CMS for the world of DOOH... remote deployment, troubleshooting, performance alerts" — [Source](https://www.vistarmedia.com/for-media-owners)
- Login-gated products confirm seller UIs exist but are not publicly inspectable: "DSP, SSP & Ad Server" (trafficking.vistarmedia.com), "Cortex" (fleet.cortexpowered.com), "Adstruc" (traditional OOH planning) — [Source](https://www.vistarmedia.com/)

#### Inferences
- El equivalente funcional al módulo Guaranteed de Broadsign existe (Ad Server con loop + programático integrados, Adstruc para OOH tradicional), pero su codificación visual de disponibilidad (calendario, %, lista) no es verificable sin cuenta.

#### Gaps
- No verificado: ningún calendario, %, heatmap o vista de ocupación de Vistar; support.vistarmedia.com falló por error de transporte; las docs de trafficking/Cortex exigen login.

### 2. Place Exchange (seller UI: Publisher Portal)

#### Takeaway
El Place Exchange Publisher Portal (verificado) organiza el seller-side en 4 módulos — Inventory Management, Campaigns, Ad Approvals, Reporting — sin evidencia pública de calendario de ocupación ni % de disponibilidad: el control es por deals/placements y aprobaciones, no por franjas temporales.

#### Cited Findings
- Portal modules: "Inventory Management: Add new inventory and keep inventory up-to-date to make it easily accessible for all eligible campaigns"; "Campaigns: Create custom placements that seamlessly group inventory for campaigns, and set up deals that specify pricing terms"; "Ad Approvals: Review and approve the creatives"; "Reporting: comprehensive reports... on revenue, campaigns, and network activity" — [Source](https://www.placeexchange.com/place-exchange-publisher-portal)
- SSP seller promise: "full transparency and control" with "Support for open auctions and private deals", "Full transparency and control over approved advertisers and creatives", "Full control over inventory pricing and auction dynamics", "No bundling of publisher inventory" — [Source](https://www.placeexchange.com/ssp-supply)

#### Inferences
- Place Exchange delega la disponibilidad al mecanismo programático (subasta/deals) en vez de a un calendario de reservas: el seller controla precio, creatividades aprobadas y deals, y mide ex-post vía reporting. Sin atribución "quién ocupa" por pantalla/día en la parte pública.

#### Gaps
- No verificado: cómo ve el publisher la ocupación prevista por fecha/venue (el Portal exige login en app.placeexchange.com); la página /product enlazada en la primera pasada devuelve 404.

### 3. Hivestack / Perion (buyer + seller UI)

#### Takeaway
Hivestack ya no existe como marca pública: es Perion (perion.com; hivestack.com redirige al ecosistema Perion One). Verificado: marketplace DOOH de 400+ media owners con 8 tipos de deal (de PG garantizado a open auction) y un AI planner que consume "screen availability" como input — pero sin UI pública de calendario/ocupación.

#### Cited Findings
- "Perion connects buyers to a global marketplace of premium DOOH inventory across 400+ media owners in 35+ markets" — [Source](https://perion.com/channels/dooh/)
- Deal types incl. "Programmatic Guaranteed (PG): Lock in fixed pricing and guaranteed impression volume", "PG Cadence: Secure structured, pre-defined loop sequences at regular intervals", "PMP Preferred... pre-negotiated fixed eCPM", "Private Marketplace... competing above a set floor price", "Open Auction" — [Source](https://perion.com/channels/dooh/)
- "The Ask Perion Agentic DOOH Planner... Automatically factor in location intelligence, screen availability, venue relevance, and audience movement patterns" — [Source](https://perion.com/channels/dooh/)
- "programmatic DOOH through Perion can be optimized in-flight. Shift budget or creative toward the highest-performing screens, times, and locations while the campaign is still running" — [Source](https://perion.com/channels/dooh/)

#### Inferences
- "PG Cadence" (secuencias de loop predefinidas a intervalos regulares) es lo más cercano a una primitiva de ocupación parcial verificada en programático: reserva de cadencia dentro del loop en vez de % de día.
- "Screen availability" como input del planner confirma que el dato existe en el sistema, pero su visualización (calendario, lista, score) no es pública.

#### Gaps
- No verificado: ninguna captura o descripción de UI de disponibilidad/ocupación seller o buyer de Hivestack/Perion; el inventario (dooh-inventory.perion.com) no se inspeccionó (requiere interacción JS/login).

### 4. Adomni (buyer availability UI — verificado en help center)

#### Takeaway
Adomni sí verifica públicamente su modelo: compra programática sin negociación por pantalla ("instead of negotiating for specific screens"), con feedback de disponibilidad en el Key Metrics Tray (utilization %, play usage, plays/hora) y regla operativa 90–100% screens / 20–40% play usage / 3–4 plays por hora.

#### Cited Findings
- "Instead of negotiating for specific screens, Adomni provides access to millions of available screens... Screen availability may vary based on demand" — [Source](https://www.adomni.com/help-center)
- "Start by setting your campaign schedule, budget, and preferred venue types. The Key Metrics Tray will populate estimated impressions, CPM, and delivery pacing. Then open the Details dropdown to see screen utilization and play usage. A good rule of thumb is: Aim for 90–100% of screens utilized; 20–40% play usage; 3–4 plays per hour" — [Source](https://www.adomni.com/help-center)
- "Programmatic DOOH inventory is dynamic. Screens selected during planning may go in and out of availability while a campaign is live... campaigns are not guaranteed to run on every selected screen" — [Source](https://www.adomni.com/help-center)
- "Adomni only bills for impressions actually delivered. If your campaign underdelivers, you'll be invoiced for the delivered amount" — [Source](https://www.adomni.com/help-center)
- Buyer planning dimensions are audience/geo/daypart, not occupancy: "Choose from 1,000+ audience segments... Place ads... by DMA/zip/POI... Set ads to play at specific times of the day" — [Source](https://www.adomni.com/self-service-advertising)
- Testimonio buyer: "my team can activate a campaign in 90 seconds or less... invaluable for expedited launches, immediate avails feedback" — [Source](https://www.adomni.com/self-service-advertising)
- Device List CSV with screen names/location downloadable; "How to download campaign device list and exclude unavailable devices" how-to video — [Source](https://www.adomni.com/help-center)

#### Inferences
- Adomni sustituye el calendario de ocupación por un modelo de elegibilidad + pacing: pantallas elegibles por audiencia/geo, runs/plays por hora como cuota, y facturación solo por impresiones entregadas. "Screen utilization / play usage" son los análogos funcionales al % de ocupación de Broadsign del lado comprador.

#### Gaps
- No verificado: pixel-level del Key Metrics Tray (colores, barras); atribución "quién más ocupa" no existe para buyers (solo tu propio delivery vía Performance Report CSV).

### 5. OneScreen.ai (verificado: sin UI self-serve)

#### Takeaway
OneScreen.ai verifica como managed-service/agencia ("One team, one plan"), no como plataforma self-serve: no hay UI pública de disponibilidad por pantalla/fecha; el planning es por brief y el despliegue es "5 days from brief to live".

#### Cited Findings
- "Three motions, one platform... One team, one plan, fast deployment"; "One point of contact. One media plan." — [Source](https://www.onescreen.ai/billboards) (redirige a homepage 2026)
- "Five days from brief to live for most digital placements" — [Source](https://www.onescreen.ai/billboards)
- "Most OOH attribution is overpromised. We put the rigor on the front end — mapping your ICP to real-world environments before you spend" — [Source](https://www.onescreen.ai/billboards)

#### Inferences
- Sin buyer UI inspectable, no hay codificación de disponibilidad que verificar; el "availability check" es interno del equipo de servicio.

#### Gaps
- No verificado (y probablemente inexistente públicamente): cualquier vista de ocupación de OneScreen.ai.

### 6. Channel managers hoteleros — análogo de inventario perecedero diario (Cloudbeds / Mews)

#### Takeaway
Parcialmente verificado a nivel arquitectónico (Cloudbeds: pooled inventory, single source of truth, sync en tiempo real anti-overbooking), pero la codificación visual del calendario (colores, números, heatmaps) NO pudo verificarse: el help center de Cloudbeds y las páginas de Mews devolvieron 404/errores de fetch.

#### Cited Findings
- "O Channel Manager da Cloudbeds sincroniza suas tarifas e disponibilidade em todos os canais em tempo real... garantindo que os preços estejam sempre atualizados" (página localizada pt-br servida en lugar de /hotel-channel-manager/) — [Source](https://www.cloudbeds.com/hotel-channel-manager/)
- "Venda seus quartos a partir de um único local [pooled inventory] e mapeie automaticamente seu inventário do PMS para seu motor de reservas e OTAs"; "Um gerenciador de canais fornece uma fonte única de verdade para a disponibilidade de quartos" — [Source](https://www.cloudbeds.com/hotel-channel-manager/)
- Mews: ningún fetch funcionó (mews.com/en/product/channel-manager, /en/channel-manager y /products/channel-manager → 404; help.mews.com/s/article/availability-calendar → 404).

#### Inferences
- El patrón arquitectónico hotelero (inventario pooled por tipo de habitación + sync bidireccional en tiempo real + single source of truth) es el análogo directo propuesto para slots DOOH por día; pero sin capturas del calendario no se puede afirmar su codificación (típicamente celdas día×tarifa con conteo restante y color por umbral, mas esto queda como conocimiento general no verificado, NO como hallazgo).

#### Gaps
- No verificado: codificación exacta del availability calendar de Cloudbeds ni de Mews (colores, números restantes, heatmaps, restricciones por día); se requiere acceso a help centers con URLs vigentes o cuenta demo.
