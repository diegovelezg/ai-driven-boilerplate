# Sistema visual

La base visual vive en `app/globals.css` y en los componentes compartidos.
Las páginas conservan sus anchos de lectura y formulario, y comparten el ritmo
vertical y los márgenes mediante `page-shell`.

## Criterios

- Familia: Geist para títulos, contenido y controles; Geist Mono para código.
- Títulos de página: 24 px en móvil / 30 px desde `sm`, peso 600.
- Títulos de sección y tarjeta: 16 px, peso 600, interlineado compacto.
- Cuerpo y descripciones: 14 px con interlineado relajado.
- Badges y metadatos: 12 px; badges con altura mínima de 24 px.
- Campos: 16 px en móvil y 14 px en escritorio. Labels de 14 px.
- Separación entre bloques de página: 32 px. Gutter: 16 / 24 / 32 px.
- Tarjetas: padding de 16 px en móvil y 20 px desde `sm`; compactas de 16 px.
- Tablas principales: celdas de 16 × 12 px, cifras alineadas con `tabular-nums`.
  `DrawerTable` mantiene su densidad compacta para fichas.
- Acento principal para acciones y selección; verde, ámbar, rojo y azul para
  estados según `lib/ui-badges.tsx`. Los atributos neutros usan outline.
- Acento y colores de foco originales del sitio conservados en ambos temas.
- Las animaciones respetan `prefers-reduced-motion`.

## Defectos corregidos en la revisión

- Tres familias tipográficas y variables de fuente autorreferenciales.
- Texto de tarjetas/controles de 12 px y badges de 10 px.
- Anchos de 1152 y 1200 px mezclados entre vistas equivalentes.
- Márgenes laterales excesivos en móvil y espaciados de drawers distintos.
- Truncado de nombres y descripciones en cabeceras de fichas.
- Cabecera de Inbox y Ocupación con el nombre de Hoy.
- Login sin altura de viewport garantizada.

## Validación de la ronda

- `npx tsc --noEmit` y `npm run build`: correctos.
- `git diff --check`: correcto.
- Revisión visual autenticada de dashboards, listas, ficha de orden,
  configuración, ayuda y formularios; temas claro y oscuro.
- Comprobación de las 11 vistas principales y formularios de empresa,
  contacto y pantalla a 390 px: sin desbordamiento horizontal de página.
- El lint global mantiene seis errores de lógica preexistentes. Los cuatro
  presentes en archivos con cambios visuales (`finance/page.tsx`,
  `orders/new/nueva-form.tsx` y `entity-list.tsx`) se contrastaron con HEAD
  y ya existían (en nueva orden solo se desplazaron tres líneas por imports).

## Revisión individual de creación y drawers

El acento original se restauró exactamente, incluidos `primary`, su foreground,
los tokens de sidebar y los anillos de foco. No se sustituye por un pastel.

| Vista | Cobertura |
| --- | --- |
| Nueva empresa | Campos completos; anunciante y agencia con comisión |
| Nuevo contacto | Empresa, cargo, principal, nombre, apellido, email y teléfono |
| Nueva pantalla | Ubicación/mapa; digital e impresa; medidas; precio y pauta |
| Nueva orden | Contratante, facturación, intermediario, fechas, selección y precio por pantalla |
| Empresa | Ficha, Perfil, Contactos, Órdenes, Vínculos, Agentes; editor, tipo y comisión |
| Contacto | Resumen, Órdenes, Agentes; edición de datos y principal |
| Marca | Ficha, Perfil, Órdenes, Empresas, Agentes |
| Pantalla | Ficha, Comercial, Ocupación, Entorno, Agentes; editor de pauta |
| Orden | Resumen, Producción, Cobranza, Agentes; editor, factura y tres diálogos de adjuntos |

Los cuatro formularios de creación delegan los campos visibles al primitivo
`Input`; las notas de orden usan `Textarea`. `form-field` fija un gap de 8 px
y etiquetas de 14 px en creación y edición. La orden usa dos columnas en
escritorio para evitar campos comprimidos. La edición de líneas se comprobó
con datos locales de muestra porque las órdenes disponibles estaban firmadas;
la ruta temporal de revisión fue eliminada.

Los cinco drawers usan el ancho móvil completo: la clase explícita
`data-[side=right]:w-full` evita que el ancho de 75% del primitivo Sheet gane
por especificidad. Sus 23 pestañas se recorrieron a 390 px, incluyendo
perfiles y chats después de la carga; no se detectó desbordamiento de tarjetas,
campos o listas de datos. Las tablas y pestañas conservan scroll interno.
Los diálogos limitan su altura al viewport y permiten scroll vertical.

Se corrigió el estado inicial de factura que mostraba `issued`: las etiquetas
se resuelven desde el mismo mapa tanto antes como después de abrir el select.
La revisión visual se hizo sin crear, guardar ni eliminar registros.
