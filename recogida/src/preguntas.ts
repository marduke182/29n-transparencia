/**
 * The voter questions of the party pages and the sections behind each one.
 * Canonical definition and admission criteria: criterios/preguntas.md.
 *
 * Classification is question-first: the classifier and the adjudicator decide
 * which question a document answers (`pregunta`), then the section. `seccion`
 * stays the stored field (the site and its validators key on it); `pregunta`
 * lives only in the run's outputs and proposals and is never written to the
 * party files.
 *
 * Two sections serve two questions each, split by fields already stored:
 * - verificacion: a check of a claim by the party or its candidate
 *   (`afirmacion`, no `bulo`) answers Q3; a fact-check of a hoax about the party
 *   made by others (`bulo: true`) answers Q6.
 * - historial: a past promise or announcement compared with its outcome answers
 *   Q4; a court case, which comes only from the equal `causas` search (its
 *   `busqueda` ends in `-causas`), answers Q8.
 *
 * An item may be a context note (`contexto: true`): relevant background with no
 * statement or action by the party, filed in the section of the question it
 * relates to. It never carries a `veredicto`.
 */

type Objeto = Record<string, unknown>;

export const PREGUNTAS = {
  Q1: { slug: 'quien', texto: '¿Quién se presenta?', secciones: ['candidatura'] },
  Q2: { slug: 'promesas', texto: '¿Qué dicen que harán?', secciones: ['lema-y-frases', 'temas', 'por-escrito'] },
  Q3: { slug: 'cierto', texto: '¿Lo que dicen es cierto?', secciones: ['verificacion'] },
  Q4: { slug: 'cumplido', texto: '¿Han cumplido antes?', secciones: ['historial'] },
  Q5: { slug: 'cambios', texto: '¿Han cambiado de opinión?', secciones: ['cambios'] },
  Q6: { slug: 'opinan', texto: '¿Qué dicen de ellos?', secciones: ['criticos-defensores', 'verificacion'] },
  Q7: { slug: 'encuestas', texto: '¿Cómo van en las encuestas?', secciones: ['encuestas'] },
  Q8: { slug: 'causas', texto: '¿Tienen causas abiertas?', secciones: ['historial'] },
} as const satisfies Record<string, { slug: string; texto: string; secciones: readonly string[] }>;

export type Pregunta = keyof typeof PREGUNTAS;

/** Question ids in order. */
export const IDS_PREGUNTA = Object.keys(PREGUNTAS) as Pregunta[];

export const esPregunta = (valor: unknown): valor is Pregunta => typeof valor === 'string' && Object.hasOwn(PREGUNTAS, valor);

/** A court-case item: it comes from the equal `causas` search (same test as diario.ts `tipoBuscado`). */
export const esCausa = (item: Objeto): boolean => typeof item.busqueda === 'string' && item.busqueda.endsWith('-causas');

/** The questions a section can answer (two for verificacion and historial, one for the rest; none for an unknown section). */
export function preguntasDeSeccion(seccion: string): Pregunta[] {
  return IDS_PREGUNTA.filter((id) => (PREGUNTAS[id].secciones as readonly string[]).includes(seccion));
}

/** The one question an item of a section answers; undefined for an unknown section. */
export function preguntaDe(seccion: string, item: Objeto = {}): Pregunta | undefined {
  if (seccion === 'verificacion') return item.bulo === true ? 'Q6' : 'Q3';
  if (seccion === 'historial') return esCausa(item) ? 'Q8' : 'Q4';
  return preguntasDeSeccion(seccion)[0];
}

/** Why an item's `contexto` flag is not valid, or undefined. */
export function motivoContexto(seccion: string, item: Objeto): string | undefined {
  if (item.contexto === undefined) return undefined;
  if (typeof item.contexto !== 'boolean') return 'contexto debe ser true o false';
  if (item.contexto && item.veredicto !== undefined) return 'una nota de contexto no lleva veredicto';
  if (item.contexto && seccion === 'verificacion') return 'una nota de contexto no va en verificacion, que exige veredicto';
  return undefined;
}

/**
 * Why a proposal's `pregunta` does not fit its `seccion` and item, or undefined.
 * - Missing (`undefined`): accepted, for outputs written before the field existed.
 * - `null` (the material answers no question): refused; such material is not proposed.
 * - Otherwise it must be Q1..Q8 and match the section and the splitting fields
 *   (`bulo` in verificacion, the `causas` search in historial).
 */
export function motivoPregunta(pregunta: unknown, seccion: string, item: Objeto = {}): string | undefined {
  if (pregunta === undefined) return undefined;
  if (pregunta === null) return 'pregunta null: lo que no responde a ninguna pregunta no se propone';
  if (!esPregunta(pregunta)) return `pregunta desconocida "${String(pregunta)}"`;
  const esperada = preguntaDe(seccion, item);
  if (esperada === undefined || esperada === pregunta) return undefined;
  if (seccion === 'verificacion') {
    return pregunta === 'Q6'
      ? 'pregunta Q6 en verificacion sin "bulo": true (un bulo es lo que otros dicen del partido)'
      : `pregunta ${pregunta} en verificacion con "bulo": true: un bulo sobre el partido responde a Q6`;
  }
  if (seccion === 'historial' && (pregunta === 'Q4' || pregunta === 'Q8')) {
    return pregunta === 'Q8'
      ? 'pregunta Q8 en historial sin la búsqueda igual de causas: una causa judicial solo sale de esa búsqueda'
      : 'pregunta Q4 en historial con la búsqueda de causas: una causa judicial responde a Q8';
  }
  return `pregunta ${pregunta} (${PREGUNTAS[pregunta].texto}) no corresponde a la sección ${seccion}, que responde a ${esperada}`;
}
