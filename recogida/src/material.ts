/**
 * The material of each Claude call, built by the script (agentes/08-diario.md):
 * what goes into each prompt, in which batch, and what the call may answer.
 * Pure functions of data already read: no files, no clock, no randomness.
 *
 * Rules the batching keeps, the same for the four parties:
 * - No document loses text by length alone. A document is always whole in one
 *   prompt; only one longer than MAX_DOCUMENTO (none so far: the largest of the
 *   12 Nov run had 105 494 characters) is reduced, to windows around the terms
 *   of all four parties (`extractoNeutral`), so the excerpt is the same whoever
 *   reads it. Every excerpt is recorded (`Recorte`) for the summary.
 * - A document goes to exactly one batch, with everything that refers to it:
 *   its classifications and, in an adjudication, the party's equal-search
 *   results on it. A result with no cached document is a piece of its own.
 * - Shared facts are batched by event (`eventoDe`), never split inside an
 *   event unless the event alone does not fit.
 * - An adjudication batch carries only the sheet sections its pieces touch, so
 *   the fixed context stays small for every party.
 * - The search runs in small calls: the four parties of one kind of equal
 *   search together, then the source tasks a few at a time.
 */
import { PARTY_IDS, type PartyId } from './cache.ts';
import { salidaTarea, type Alias, type Emisor, type TareaBusqueda } from './descubrir.ts';
import type { TareaClasificar, TareaEquidad } from './diario.ts';
import { AVISO_DATOS, datosNoFiables, lotesPorTamano } from './juicio.ts';

type Objeto = Record<string, unknown>;
const esObjeto = (v: unknown): v is Objeto => typeof v === 'object' && v !== null && !Array.isArray(v);
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const comparar = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- sizes

/** Characters of documents a classification call aims at (Haiku); a larger document goes alone. */
export const OBJETIVO_CLASIFICACION = 60_000;
/** Tasks of one classification call at most (a document's tasks are never split). */
export const MAX_TAREAS_CLASIFICACION = 20;
/** Characters a facts call aims at (Opus), fixed context included. */
export const OBJETIVO_JUICIO = 400_000;
/**
 * Characters of documents in one adjudication batch at most, the same for the
 * four parties: how many batches a party gets depends on its documents only,
 * never on the size of its sheet or perfil (the fixed context comes on top).
 */
export const ESPACIO_DOCUMENTOS_ADJUDICACION = 250_000;
/** Characters of any prompt at most: a larger one is not sent (the call is skipped and the gate decides). */
export const MAX_PROMPT = 480_000;
/** Characters of one document above which it is reduced to a party-neutral excerpt. */
export const MAX_DOCUMENTO = 250_000;
/** Characters on each side of a term kept in an excerpt. */
export const VENTANA_EXTRACTO = 1_500;
/** Source tasks of one search call. */
export const FUENTES_POR_LLAMADA = 4;

// ---------------------------------------------------------------- excerpts

/** One document reduced for a prompt: recorded and listed in the summary. */
export interface Recorte {
  doc_id: string;
  url: string;
  via: string;
  caracteres: number;
  extracto: number;
  ventanas: number;
}

/**
 * The terms of all four parties (names, regional brands, members, people):
 * the same excerpt for every party. Short all-caps acronyms (PP, IU) are
 * kept; other terms need three characters. All match as whole words.
 */
export function terminosNeutrales(alias: Partial<Record<PartyId, Alias>>): string[] {
  const todos = PARTY_IDS.flatMap((p) => {
    const a = alias[p];
    return a ? [...a.nombres, ...a.marcas_regionales, ...a.miembros, ...a.personas] : [];
  });
  return [...new Set(todos.map((t) => t.trim()).filter((t) => t.length >= 3 || /^\p{Lu}{2}$/u.test(t)))].sort(comparar);
}

/** Lowercase without accents, one character for one character, so positions match the original. */
const plano = (texto: string) => [...texto].map((c) => (c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()[0] ?? c)).join('');
const esLetra = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * A party-neutral excerpt of a long text: its first VENTANA_EXTRACTO × 2
 * characters (headline, byline) and a window around every whole-word match of
 * any party's term, merged, in order, up to `max` characters, with each gap
 * marked. Deterministic.
 */
export function extractoNeutral(texto: string, terminos: readonly string[], max = MAX_DOCUMENTO, ventana = VENTANA_EXTRACTO): { texto: string; ventanas: number } {
  const chars = [...texto];
  const base = plano(texto);
  const tramos: [number, number][] = [[0, Math.min(chars.length, 2 * ventana)]];
  for (const termino of terminos) {
    const buscado = plano(termino);
    let desde = 0;
    for (;;) {
      const i = base.indexOf(buscado, desde);
      if (i === -1) break;
      desde = i + 1;
      if (esLetra(base[i - 1]) || esLetra(base[i + buscado.length])) continue;
      tramos.push([Math.max(0, i - ventana), Math.min(chars.length, i + buscado.length + ventana)]);
    }
  }
  tramos.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unidos: [number, number][] = [];
  for (const t of tramos) {
    const ultimo = unidos.at(-1);
    if (ultimo && t[0] <= ultimo[1]) ultimo[1] = Math.max(ultimo[1], t[1]);
    else unidos.push([t[0], t[1]]);
  }
  const partes: string[] = [];
  let total = 0;
  let previo = 0;
  for (const [a, b] of unidos) {
    const trozo = chars.slice(a, b).join('');
    if (total + trozo.length > max) break;
    if (a > previo) partes.push(`[… ${a - previo} caracteres omitidos por la ejecución …]`);
    partes.push(trozo);
    total += trozo.length;
    previo = b;
  }
  if (previo < chars.length) partes.push(`[… ${chars.length - previo} caracteres omitidos por la ejecución …]`);
  return { texto: partes.join('\n'), ventanas: partes.filter((p) => !p.startsWith('[… ')).length };
}

/**
 * The text of a document as a prompt carries it: whole, unless it is longer
 * than MAX_DOCUMENTO, then the party-neutral excerpt, recorded. The same for
 * every document and every party: nothing about the document's classification
 * or origin changes it.
 */
export function textoDocumento(doc: { id: string; meta?: Objeto; texto?: string }, terminos: readonly string[]): { texto?: string; recorte?: Recorte } {
  if (doc.texto === undefined || doc.texto.length <= MAX_DOCUMENTO) return { ...(doc.texto !== undefined ? { texto: doc.texto } : {}) };
  const { texto, ventanas } = extractoNeutral(doc.texto, terminos);
  return {
    texto,
    recorte: { doc_id: doc.id, url: String(doc.meta?.url ?? ''), via: String(doc.meta?.via ?? ''), caracteres: doc.texto.length, extracto: texto.length, ventanas },
  };
}

// ---------------------------------------------------------------- blocks

/** A named section of a prompt with JSON the script wrote itself (trusted): the registry, the tasks. */
export const seccionJson = (nombre: string, valor: unknown) => `${nombre} (JSON):\n${JSON.stringify(valor)}`;
/** A named section with data from the web, the site data or a model: untrusted, between delimiters. */
export const seccionNoFiable = (nombre: string, valor: unknown) => `${nombre}:\n${datosNoFiables(nombre, typeof valor === 'string' ? valor : JSON.stringify(valor, null, 1))}`;

/**
 * One cached document as a prompt block: its meta, what refers to it (`extra`)
 * and its text, as untrusted data. A part of a split document (`parte`, "k de
 * n") keeps its real doc_id in META and says its part in its own field.
 */
export function bloqueDocumento(id: string, meta: Objeto | undefined, texto: string | undefined, extra: Record<string, unknown> = {}, parte?: string): string {
  const m = meta ?? {};
  const cabecera = { doc_id: id, ...(parte ? { parte } : {}), url: m.url, url_canonica: m.url_canonica, consultado: m.consultado, via: m.via, ...(m.origen ? { origen: m.origen } : {}), ...extra };
  const cuerpo = `META: ${JSON.stringify(cabecera)}\n${texto === undefined ? 'TEXTO: (no está en la caché)' : `TEXTO:\n${texto}`}`;
  const nombre = parte ? `${id} (parte ${parte})` : id;
  return `DOCUMENTO ${nombre}:\n${datosNoFiables(`DOCUMENTO ${nombre}`, cuerpo)}`;
}

/** The source registry as the calls need it: id, name, hosts and kind of each emisor. */
export const fuentesResumidas = (emisores: readonly Emisor[]) => emisores.map((e) => ({ id: e.id, nombre: e.nombre, hosts: e.hosts, tipo: e.tipo }));

const urlsDe = (i: Objeto) => lista(i.fuentes).flatMap((f) => (esObjeto(f) && typeof f.url === 'string' ? [f.url] : []));

/**
 * A party sheet in short: its card (candidate, slogan and its source), its
 * pending matters, its discarded items (ref, state, reason) and, of the
 * sections in `secciones` (all when omitted), each item's ref, text, state,
 * shared-fact key, search id and source URLs; held items likewise.
 */
export function fichaResumida(ficha: unknown, secciones?: ReadonlySet<string>): Objeto {
  if (!esObjeto(ficha)) return {};
  const vale = (s: unknown) => secciones === undefined || secciones.has(String(s));
  const item = (seccion: unknown, i: Objeto) => ({
    ref: i.ref,
    seccion,
    texto: i.texto,
    estado: i.estado,
    ...(i.matiz ? { matiz: i.matiz } : {}),
    ...(i.hecho ? { hecho: i.hecho } : {}),
    ...(i.busqueda ? { busqueda: i.busqueda } : {}),
    ...(i.postura ? { postura: i.postura } : {}),
    fuentes: urlsDe(i),
  });
  const tarjeta = esObjeto(ficha.tarjeta) ? { candidato: ficha.tarjeta.candidato, lema: ficha.tarjeta.lema, fuente_lema: ficha.tarjeta.fuente_lema } : undefined;
  return {
    id: ficha.id,
    corte: ficha.corte,
    ...(tarjeta ? { tarjeta } : {}),
    pendientes: lista(ficha.pendientes),
    descartados: lista(ficha.descartados).flatMap((d) => (esObjeto(d) ? [{ ref: d.ref, estado: d.estado, motivo: d.motivo }] : [])),
    secciones_incluidas: secciones === undefined ? 'todas' : [...secciones].sort(comparar),
    items: lista(ficha.secciones).flatMap((s) => (esObjeto(s) && vale(s.id) ? lista(s.items).flatMap((i) => (esObjeto(i) ? [item(s.id, i)] : [])) : [])),
    en_espera: lista(ficha.en_espera).flatMap((i) => (esObjeto(i) && vale(i.seccion) ? [item(i.seccion, i)] : [])),
  };
}

/** Every item of a sheet in one line each (ref, section, source URLs), held items too: in every adjudication batch, so none loses track of what the sheet already has. */
export function fichaCompacta(ficha: unknown): Objeto[] {
  if (!esObjeto(ficha)) return [];
  return [
    ...lista(ficha.secciones).flatMap((s) => (esObjeto(s) ? lista(s.items).flatMap((i) => (esObjeto(i) ? [{ ref: i.ref, seccion: s.id, fuentes: urlsDe(i), ...(i.hecho ? { hecho: i.hecho } : {}) }] : [])) : [])),
    ...lista(ficha.en_espera).flatMap((i) => (esObjeto(i) ? [{ ref: i.ref, seccion: i.seccion, en_espera: true, fuentes: urlsDe(i) }] : [])),
  ];
}

/** A perfil in short: its limits, and its documents, proposals and messages by id, text and URL. */
export function perfilResumido(perfil: unknown): Objeto | undefined {
  if (!esObjeto(perfil)) return undefined;
  const de = (clave: string, campos: string[]) => lista(perfil[clave]).flatMap((x) => (esObjeto(x) ? [Object.fromEntries(campos.filter((c) => x[c] !== undefined).map((c) => [c, x[c]]))] : []));
  return {
    partido: perfil.partido,
    periodo: perfil.periodo,
    limites: lista(perfil.limites),
    documentos: de('documentos', ['id', 'titulo', 'fecha', 'tipo', 'url']),
    propuestas: de('propuestas', ['id', 'tema', 'texto', 'documentos']),
    mensajes: de('mensajes', ['id', 'tipo', 'texto', 'documentos']),
  };
}

/** The equal searches of busquedas.json as one party sees them: each run's queries, and this party's count, notes and findings. */
export function busquedasDelPartido(registro: unknown, partido: PartyId): Objeto[] {
  const busquedas = esObjeto(registro) ? lista(registro.busquedas) : [];
  return busquedas.flatMap((b) => {
    if (!esObjeto(b)) return [];
    const de = (campo: string) => (esObjeto(b[campo]) ? (b[campo] as Objeto)[partido] : undefined);
    return [{ id: b.id, tipo: b.tipo, fecha: b.fecha, periodo: b.periodo, consultas: lista(b.consultas).map((c) => (esObjeto(c) ? { plantilla: c.plantilla, motor: c.motor, dominios: c.dominios } : c)), resultados: de('resultados'), ...(b.nota ? { nota: b.nota } : {}), ...(de('notas') ? { nota_partido: de('notas') } : {}), hallazgos: de('hallazgos') ?? [] }];
  });
}

/** The shared facts already published, from the four sheets: one entry per key, with every party that carries it. */
export function hechosPublicados(fichas: Partial<Record<PartyId, unknown>>): Objeto[] {
  const porClave = new Map<string, Objeto & { partidos: string[] }>();
  for (const partido of PARTY_IDS) {
    const ficha = fichas[partido];
    if (!esObjeto(ficha)) continue;
    for (const s of lista(ficha.secciones)) {
      if (!esObjeto(s)) continue;
      for (const i of lista(s.items)) {
        if (!esObjeto(i) || typeof i.hecho !== 'string') continue;
        const previo = porClave.get(i.hecho);
        if (previo) previo.partidos.push(partido);
        else porClave.set(i.hecho, { hecho: i.hecho, seccion: s.id, texto: i.texto, estado: i.estado, ...(i.matiz ? { matiz: i.matiz } : {}), fuentes: urlsDe(i), partidos: [partido] });
      }
    }
  }
  return [...porClave.values()].sort((a, b) => comparar(String(a.hecho), String(b.hecho)));
}

/** The tasks of a classification call as the model sees them (no paths). */
export const tareasVisibles = (tareas: readonly TareaClasificar[]) => tareas.map(({ doc_id, partido, url, url_canonica, via, consultado, origen }) => ({ doc_id, partido, url, url_canonica, via, consultado, origen }));

// ---------------------------------------------------------------- batches

/** One prompt and what it carries: recorded in claude/<session>.lotes.json. */
export interface LotePrompt {
  documentos: string[];
  resultados?: string[];
  grupos?: string[];
  secciones?: string[];
  salidas?: string[];
  /** Characters at the start of the prompt that are the same in every batch of the pass (the cacheable part). */
  comun?: number;
  caracteres: number;
}

/** One piece of a facts or adjudication call: a document (or a result with no document) and everything that refers to it. */
export interface Pieza {
  id: string;
  bloque: string;
  /** The event (facts) the piece belongs to: pieces of one event go together. */
  grupo: string;
  /** The sheet sections it touches (adjudication). */
  secciones: string[];
  /** The equal-search result URLs it carries (adjudication). */
  resultados: string[];
}

/**
 * Batches of pieces: in order, a new batch when adding the next group would
 * pass `objetivo` with the fixed context the batch then needs (`fijo`, from the
 * sections it touches). A group goes whole into one batch; only a group that
 * alone does not fit is split, piece by piece. Deterministic.
 */
export function lotesDePiezas(piezas: readonly Pieza[], fijo: (secciones: ReadonlySet<string>) => number, objetivo: number): Pieza[][] {
  const grupos: Pieza[][] = [];
  for (const p of piezas) {
    const ultimo = grupos.at(-1);
    if (ultimo && ultimo[0]!.grupo === p.grupo) ultimo.push(p);
    else grupos.push([p]);
  }
  const coste = (lote: readonly Pieza[]) => fijo(new Set(lote.flatMap((p) => p.secciones))) + lote.reduce((n, p) => n + p.bloque.length + 2, 0);
  const lotes: Pieza[][] = [];
  let actual: Pieza[] = [];
  const meter = (grupo: Pieza[]) => {
    if (actual.length && coste([...actual, ...grupo]) > objetivo) {
      lotes.push(actual);
      actual = [];
    }
    actual.push(...grupo);
  };
  for (const grupo of grupos) {
    if (coste(grupo) <= objetivo) meter(grupo);
    else for (const pieza of grupo) meter([pieza]);
  }
  if (actual.length) lotes.push(actual);
  return lotes;
}

/** The prompt of one batch: instructions, the rule on untrusted data, the fixed context and the pieces. */
export function promptLote(base: string, fijo: string, bloques: readonly string[]): string {
  const cabecera = `${base.trimEnd()}\n\n${AVISO_DATOS}\n\n${fijo.trimEnd()}\n`;
  return bloques.length ? `${cabecera}\n${bloques.join('\n\n')}\n` : cabecera;
}

/** The sheet section an equal search of each kind feeds. */
export const SECCION_DE_TIPO: Record<string, string> = { criticos: 'criticos-defensores', defensores: 'criticos-defensores', bulos: 'verificacion', causas: 'historial' };

const masFrecuente = (valores: string[]) => {
  const cuenta = new Map<string, number>();
  for (const v of valores) cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1] || comparar(a[0], b[0]))[0]?.[0] ?? '';
};

/**
 * The event a shared-fact candidate belongs to, from its relevant
 * classifications: the most frequent question and section, and topic (ties by
 * name). Polls go with polls, a debate with the debate; never by hash.
 */
export function eventoDe(clasificaciones: readonly Objeto[]): string {
  const relevantes = clasificaciones.filter((c) => c.relevante === true);
  const fuente = relevantes.length ? relevantes : clasificaciones;
  return `${masFrecuente(fuente.map((c) => `${String(c.pregunta ?? '-')}/${String(c.seccion ?? '-')}`))}/${masFrecuente(fuente.map((c) => String(c.tema ?? '-')))}`;
}

/** A judgement pass's prompts and batches, and the documents reduced. */
export interface Prompts {
  prompts: string[];
  lotes: LotePrompt[];
  recortes: Recorte[];
}

/** A cached document with what the script read about it. */
export interface DocumentoMaterial {
  id: string;
  meta?: Objeto;
  texto?: string;
}

/** One classification batch: its tasks, then each of its documents once, whole (or excerpted above MAX_DOCUMENTO). */
export function promptClasificacion(base: string, tareas: readonly TareaClasificar[], documentos: ReadonlyMap<string, DocumentoMaterial>, terminos: readonly string[]): Prompts {
  const ids = [...new Set(tareas.map((t) => t.doc_id))];
  const recortes: Recorte[] = [];
  const bloques = ids.map((id) => {
    const doc = documentos.get(id) ?? { id };
    const { texto, recorte } = textoDocumento(doc, terminos);
    if (recorte) recortes.push(recorte);
    return bloqueDocumento(id, doc.meta, texto);
  });
  const prompt = promptLote(base, seccionJson('TAREAS', tareasVisibles(tareas)), bloques);
  return { prompts: [prompt], lotes: [{ documentos: ids, caracteres: prompt.length }], recortes };
}

/**
 * A document's blocks for a prompt: one, or, when even alone it would pass
 * MAX_PROMPT with the fixed context (`fijo` characters), consecutive parts
 * that each fit, so no prompt is ever over the limit and no text is lost.
 */
export function bloquesDocumento(id: string, meta: Objeto | undefined, texto: string | undefined, extra: Record<string, unknown>, fijo: number, max = MAX_PROMPT, espacio = Number.POSITIVE_INFINITY): string[] {
  const entero = bloqueDocumento(id, meta, texto, extra);
  const sitio = Math.min(max - fijo - 2_000, espacio);
  if (texto === undefined || entero.length <= sitio) return [entero];
  const cabida = Math.max(10_000, sitio - (entero.length - texto.length));
  const partes: string[] = [];
  for (let i = 0; i < texto.length; i += cabida) partes.push(texto.slice(i, i + cabida));
  return partes.map((parte, k) => bloqueDocumento(id, meta, parte, extra, `${k + 1} de ${partes.length}`));
}

/** The shared facts: one piece per candidate document with all its classifications, batched by event, with the registry and the published facts. */
export function promptsHechos(
  base: string,
  e: { fuentes: readonly Emisor[]; publicados: Objeto[]; candidatos: (DocumentoMaterial & { clasificaciones: Objeto[] })[]; terminos: readonly string[] },
  objetivo = OBJETIVO_JUICIO,
): Prompts {
  const recortes: Recorte[] = [];
  const fijo = [seccionJson('FUENTES', fuentesResumidas(e.fuentes)), seccionNoFiable('HECHOS PUBLICADOS', e.publicados)].join('\n\n');
  // Room left for the facts the earlier batches wrote (diario.sh appends them to each later prompt).
  const fijoLargo = base.length + AVISO_DATOS.length + fijo.length + 8 + RESERVA_HECHOS_PREVIOS;
  const piezas: Pieza[] = e.candidatos
    .flatMap((doc) => {
      const { texto, recorte } = textoDocumento(doc, e.terminos);
      if (recorte) recortes.push(recorte);
      const grupo = eventoDe(doc.clasificaciones);
      return bloquesDocumento(doc.id, doc.meta, texto, { clasificaciones: doc.clasificaciones }, fijoLargo).map((bloque, k) => ({ id: k ? `${doc.id}#${k + 1}` : doc.id, bloque, grupo, secciones: [], resultados: [] }));
    })
    .sort((a, b) => comparar(a.grupo, b.grupo) || comparar(a.id, b.id));
  const lotes = lotesDePiezas(piezas, () => fijoLargo, objetivo);
  const grupos = lotes.length ? lotes : [[]];
  const prompts = grupos.map((lote) => promptLote(base, fijo, lote.map((p) => p.bloque)));
  return { prompts, lotes: grupos.map((lote, i) => ({ documentos: lote.map((p) => p.id), grupos: [...new Set(lote.map((p) => p.grupo))], caracteres: prompts[i]!.length })), recortes };
}

/** Characters kept free in each facts prompt for the facts earlier batches wrote. */
export const RESERVA_HECHOS_PREVIOS = 40_000;

/** A party's adjudication material: what every batch carries and what is split among them. */
export interface MaterialAdjudicacion {
  partido: PartyId;
  criterios: string;
  ficha: unknown;
  perfil: unknown;
  fuentes: readonly Emisor[];
  busquedas: unknown;
  hechos: unknown;
  /** Each document classified for the party, or found by its equal searches and cached. */
  documentos: (DocumentoMaterial & { clasificacion?: Objeto; resultados: Objeto[] })[];
  /** Equal-search results with no cached document. */
  resultadosSueltos: Objeto[];
  terminos: readonly string[];
}

/**
 * A party's adjudication: one piece per document (its classification for the
 * party, its equal-search results, its whole text) and one per result with no
 * document, sorted by the sheet section they touch, then by id. Every batch
 * starts with the same context, so the prompt cache can serve later batches:
 * criteria, registry, the party's searches, perfil, today's facts and the whole
 * sheet in one line per item (`fichaCompacta`); then, for the batch only, the
 * full items of the sections it touches, and its pieces. Every piece, and so
 * every equal-search result, is in exactly one batch.
 */
export function promptsAdjudicacion(base: string, m: MaterialAdjudicacion, objetivo = ESPACIO_DOCUMENTOS_ADJUDICACION): Prompts {
  const recortes: Recorte[] = [];
  const seccionesDe = (clasificacion: Objeto | undefined, resultados: Objeto[]) =>
    [...new Set([...(clasificacion && typeof clasificacion.seccion === 'string' ? [clasificacion.seccion] : []), ...resultados.map((r) => SECCION_DE_TIPO[String(r.tipo)] ?? '')].filter(Boolean))].sort(comparar);
  const urls = (resultados: Objeto[]) => [...new Set(resultados.map((r) => String(r.url)))].sort(comparar);
  const perfil = perfilResumido(m.perfil);
  const comun = [
    `CRITERIOS:\n${m.criterios}`,
    seccionJson('FUENTES', fuentesResumidas(m.fuentes)),
    seccionNoFiable('BUSQUEDAS', busquedasDelPartido(m.busquedas, m.partido)),
    ...(perfil ? [seccionNoFiable('PERFIL', perfil)] : []),
    seccionNoFiable('HECHOS', m.hechos ?? { hechos: [] }),
    seccionNoFiable('FICHA COMPLETA EN UNA LÍNEA POR ELEMENTO', fichaCompacta(m.ficha).map((i) => JSON.stringify(i)).join('\n')),
  ].join('\n\n');
  const fijoDe = (secciones: ReadonlySet<string>) => `${comun}\n\n${seccionNoFiable('FICHA', fichaResumida(m.ficha, secciones))}`;
  const fijoMax = base.length + AVISO_DATOS.length + fijoDe(new Set(SECCIONES_FICHA)).length + 8;
  const piezas: Pieza[] = [
    ...m.documentos.flatMap((doc) => {
      const { texto, recorte } = textoDocumento(doc, m.terminos);
      if (recorte) recortes.push(recorte);
      const secciones = seccionesDe(doc.clasificacion, doc.resultados);
      const extra = { ...(doc.clasificacion ? { clasificacion: doc.clasificacion } : {}), ...(doc.resultados.length ? { resultados_equidad: doc.resultados } : {}) };
      return bloquesDocumento(doc.id, doc.meta, texto, extra, fijoMax, MAX_PROMPT, ESPACIO_DOCUMENTOS_ADJUDICACION).map((bloque, k) => ({ id: k ? `${doc.id}#${k + 1}` : doc.id, bloque, grupo: doc.id, secciones, resultados: k ? [] : urls(doc.resultados), orden: secciones[0] ?? '~' }));
    }),
    ...m.resultadosSueltos.map((r) => {
      const secciones = seccionesDe(undefined, [r]);
      const id = `resultado ${String(r.url)}`;
      return { id, bloque: `RESULTADO DE LA BÚSQUEDA IGUAL (sin documento en la caché):\n${datosNoFiables(id, JSON.stringify(r))}`, grupo: id, secciones, resultados: urls([r]), orden: secciones[0] ?? '~' };
    }),
  ]
    // In section order, so a batch touches few sections, but never a break forced between sections: a batch holds
    // ESPACIO_DOCUMENTOS_ADJUDICACION characters of documents for every party, whatever its fixed context.
    .sort((a, b) => comparar(a.orden, b.orden) || comparar(a.id, b.id))
    .map(({ orden: _orden, ...pieza }) => pieza);
  const lotes = lotesDePiezas(piezas, () => 0, objetivo);
  const grupos = lotes.length ? lotes : [[]];
  const prompts = grupos.map((lote) => promptLote(base, fijoDe(new Set(lote.flatMap((p) => p.secciones))), lote.map((p) => p.bloque)));
  return {
    prompts,
    lotes: grupos.map((lote, i) => ({
      documentos: [...new Set(lote.filter((p) => !p.id.startsWith('resultado ')).map((p) => p.id.replace(/#\d+$/, '')))],
      resultados: lote.flatMap((p) => p.resultados),
      secciones: [...new Set(lote.flatMap((p) => p.secciones))].sort(comparar),
      comun: base.length + AVISO_DATOS.length + comun.length + 4,
      caracteres: prompts[i]!.length,
    })),
    recortes,
  };
}

/** The sheet sections (fusionar.ts SECCIONES): the most a batch can touch. */
const SECCIONES_FICHA = ['candidatura', 'lema-y-frases', 'temas', 'por-escrito', 'verificacion', 'historial', 'cambios', 'criticos-defensores', 'encuestas'];

// ---------------------------------------------------------------- search

/** The answer files of a search pass: each source task's (salidaTarea) and each equal search's. */
export const salidasBusqueda = (fuentes: readonly TareaBusqueda[], iguales: readonly Pick<TareaEquidad, 'salida'>[]) => [...fuentes.map(salidaTarea), ...iguales.map((t) => t.salida)];

/**
 * The calls of a search pass, in rounds: first one per kind of equal search
 * with its four parties (searched at the same time, as before), then the
 * source tasks FUENTES_POR_LLAMADA at a time. Same tasks, same calls.
 */
export function llamadasBusqueda(fuentes: readonly TareaBusqueda[], iguales: readonly TareaEquidad[], porLlamada = FUENTES_POR_LLAMADA): { iguales: TareaEquidad[]; fuentes: TareaBusqueda[] }[] {
  const tipos = [...new Set(iguales.map((t) => t.tipo))];
  return [
    ...tipos.map((tipo) => ({ iguales: iguales.filter((t) => t.tipo === tipo), fuentes: [] as TareaBusqueda[] })),
    ...lotesPorTamano(fuentes, () => 1, porLlamada).map((grupo) => ({ iguales: [] as TareaEquidad[], fuentes: grupo })),
  ];
}

/** The prompts of a search pass: one per call, each with only its tasks, and the answer files each may write. */
export function promptsBusqueda(base: string, fuentes: readonly TareaBusqueda[], iguales: readonly TareaEquidad[]): { prompts: string[]; lotes: LotePrompt[] } {
  const llamadas = llamadasBusqueda(fuentes, iguales);
  const prompts = llamadas.map((l) => `${base.trimEnd()}\n\n${seccionJson('TAREAS_EQUIDAD', l.iguales)}\n\n${seccionJson('TAREAS_FUENTES', l.fuentes)}\n`);
  return { prompts, lotes: llamadas.map((l, i) => ({ documentos: [], salidas: salidasBusqueda(l.fuentes, l.iguales), caracteres: prompts[i]!.length })) };
}

/** A reply as the search session returned it, without a surrounding ``` fence: its file, and whether it is valid JSON (else it goes to <salida>.error.txt). */
export function respuestaBusqueda(texto: string): { contenido: string; valida: boolean } {
  const sinCerco = texto.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  try {
    return { contenido: `${sinCerco.trim()}\n`, valida: esObjeto(JSON.parse(sinCerco)) };
  } catch {
    return { contenido: texto, valida: false };
  }
}

/** The reply that counts for each answer file of one call: the last valid one, else the last one (saved as .error.txt); only the call's own files. */
export function respuestasQueCuentan(respuestas: readonly { salida: string; respuesta: string }[], admitidas: ReadonlySet<string>): { porSalida: Map<string, { contenido: string; valida: boolean }>; rechazadas: string[] } {
  const porSalida = new Map<string, { contenido: string; valida: boolean }>();
  const rechazadas: string[] = [];
  for (const r of respuestas) {
    if (!admitidas.has(r.salida)) {
      rechazadas.push(r.salida);
      continue;
    }
    const nueva = respuestaBusqueda(r.respuesta);
    const previa = porSalida.get(r.salida);
    if (!previa || nueva.valida || !previa.valida) porSalida.set(r.salida, nueva);
  }
  return { porSalida, rechazadas };
}
