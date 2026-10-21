/** Glosario SSOT de estados del motor (hero, embudo, Customers, Ayuda).
 *  Etiquetas concretas y explícitas + explicación de una línea para tooltips.
 *  Si cambia aquí, cambia en todos lados: no duplicar estos textos. */
export const DECISION_COPY = {
  paraActuarHoy: {
    label: "Para actuar hoy",
    tip: "Necesitan mensaje hoy: probabilidad, ventana y valor dicen que conviene escribir. Se aprueba en Review, nada se envía solo.",
  },
  puedenNecesitar: {
    label: "Pueden necesitar mensaje pronto",
    labelCorto: "Pueden necesitar pronto",
    tip: "Vigilados con chance alta: hoy no necesitan mensaje, pero es probable que lo necesiten pronto. El motor los mira a diario.",
  },
  vigiladosSinAccion: {
    label: "Vigilados sin acción hoy",
    tip: "Vigilados pero lejos o con chance baja: hoy no necesitan nada. Se quedan en automático, sin escribirles.",
  },
  sinNadaQueHacer: {
    label: "Sin nada que hacer",
    tip: "No necesitan mensaje: volverán solos, están dormidos, no tienen canal o fueron contactados hace poco.",
  },
  valorEsperado: {
    label: "Valor esperado",
    tip: "Ticket esperado × probabilidad de recompra, sumado de los que necesitan mensaje hoy. Es una estimación para priorizar, no una promesa de ingreso: el rango es la banda baja–alta del modelo.",
  },
} as const;
