/**
 * Deterministic glue of the daily run (bin/diario.sh) between the CLI stages
 * and the judgment stages of agentes/08-diario.md. No clock, no randomness:
 * the run date is an argument and every list is sorted.
 *
 *   node src/diario.ts tareas-equidad      --fecha D   equidad-tareas.json: the equal searches, one per kind and party
 *   node src/diario.ts videos              --fecha D   one "video<TAB>oficial<TAB>buzon" line per video to transcribe (buzon: the owner listed it)
 *   node src/diario.ts candidatos-busqueda --fecha D   descubrir.busqueda.json: URLs found by the search agents
 *   node src/diario.ts tareas-clasificar   --fecha D   tareas-clasificar.json: one task per new document and party
 *   node src/diario.ts preparar            --fecha D   fusion/<partido>.json + preparar.json: what fusionar may merge
 *   node src/diario.ts ajustar             --fecha D   en_espera promotion, common corte, the day's busquedas.json runs
 *   node src/diario.ts informe             --fecha D   Markdown appendix of the run for resumen.md
 *   node src/diario.ts claude --dir DIR --pasada P --fecha D   DIR: settings.json, agentes.json, prompt.txt, busquedas-web.txt (WebSearch cap),
 *     herramientas.txt (--tools) and carpetas.txt (--add-dir) of pass P
 *     (--lote NN with --pasada clasificacion; --partido ID with --pasada adjudicacion)
 *   node src/diario.ts sondear             --fecha D   probes each equal-search domain; marks blocked queries in equidad-tareas.json
 *   node src/diario.ts busqueda-completa   --fecha D   exit 1 and busqueda-faltan.txt unless every source term and equal search ran
 *   node src/diario.ts hechos-completo     --fecha D   exit 1 unless hechos.json is a JSON object with a list hechos
 *   node src/diario.ts adjudicacion-completa --fecha D [--partido ID]  exit 1, listing why, unless all four adjudications (or that party's) are complete
 *
 * Paths: $N29_SITIO (the run worktree), $N29_CACHE, $N29_BUZON. The run folder
 * is $N29_CACHE/ejecuciones/<fecha>.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PARTY_IDS, idDocumento, raizCache, rutaDeEntorno, urlCanonica, type Meta, type PartyId } from './cache.ts';
import { accesoDesdeRegistro, leerRegistro, salidaTarea, terminosDe, type Alias, type Candidato, type Descubrimiento, type Emisor, type TareaBusqueda } from './descubrir.ts';
import { clavesDe, urlsEn, VEDA_ENCUESTAS } from './fusionar.ts';
import { citableEn, hostsRegistrados } from './citas.ts';
import { ESQUEMAS, respuestaEstructurada, unirRespuestas, type PasadaJuicio } from './juicio.ts';
import {
  MAX_PROMPT,
  seccionNoFiable,
  MAX_TAREAS_CLASIFICACION,
  OBJETIVO_CLASIFICACION,
  lotesDePiezas,
  llamadasBusqueda,
  promptClasificacion,
  promptsAdjudicacion,
  promptsBusqueda,
  promptsHechos,
  hechosPublicados,
  respuestasQueCuentan,
  salidasBusqueda,
  terminosNeutrales,
  type DocumentoMaterial,
  type LotePrompt,
  type Prompts,
  type Recorte,
} from './material.ts';
import { motivoContexto, motivoPregunta, type Pregunta } from './preguntas.ts';
import { PARTY_SHORT } from './resumen.ts';
import { esVideo } from './transcripciones.ts';
import { Traedor, bloqueosDelDia, escribirBloqueados, guardarVetos, hostDe, hostEn, hostsVetadosRobots, leerBloqueados, leerVetos, type ResultadoEnlace, type VetoGuia } from './traer.ts';
import { SIN_AGENTES_CLAUDE_FIJOS, canonico, cambiosFuentesNoAdmitidos, hostsSinClaude, registrarBloqueos, reglasWebFetch, revisarBloqueos } from './bloqueos.ts';
import { ORIGEN_ENLACES, type AvisoEnlace } from './buzon.ts';

type Objeto = Record<string, unknown>;
const esObjeto = (v: unknown): v is Objeto => typeof v === 'object' && v !== null && !Array.isArray(v);
const esTexto = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const comparar = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const canonicaSegura = (url: string): string | undefined => {
  try {
    return urlCanonica(url);
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------- equal searches

/** Kinds of equal search, in the registry's order (site: src/lib/busquedas.ts). */
export const TIPOS_BUSQUEDA = ['criticos', 'defensores', 'bulos', 'causas'] as const;
export type TipoBusqueda = (typeof TIPOS_BUSQUEDA)[number];

/** Id of the day's run of one kind in busquedas.json. */
export const idDiario = (fecha: string, tipo: TipoBusqueda) => `diario-${fecha}-${tipo}`;

export interface ConsultaRegistro {
  plantilla: string;
  motor: string;
  dominios: string[];
  terminos?: Partial<Record<PartyId, string>>;
}

export interface Busqueda {
  id: string;
  tipo: string;
  fecha: string;
  periodo: { desde: string; hasta: string };
  consultas: ConsultaRegistro[];
  resultados: Record<string, number>;
  /** One disposition per finding (the site's busquedas.ts `Hallazgo`): required on every current run. */
  hallazgos?: Record<PartyId, Hallazgo[]>;
  nota?: string;
  notas?: Partial<Record<PartyId, string>>;
}

/** What happened to one finding: published under refs of the party file, held in its `en_espera`, or discarded with a reason. */
export type Hallazgo = { url: string; publicado: string[] } | { url: string; en_espera: string } | { url: string; descartado: string };

/** The query a run used for one party: the site's `consultaPara`, so only the party (and its {termino}) changes. */
export function consultaPara(consulta: ConsultaRegistro, partido: PartyId): string {
  return consulta.plantilla
    .replace('{partido}', PARTY_SHORT[partido])
    .replace('{termino}', consulta.terminos?.[partido] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The template of a kind: its latest run (by fecha, the later entry on a tie)
 * that is not a run of `fecha` itself. Daily runs copy their template's
 * queries, so the queries never drift.
 */
export function plantillaDe(registro: Busqueda[], tipo: TipoBusqueda, fecha: string): Busqueda | undefined {
  let mejor: Busqueda | undefined;
  for (const busqueda of registro) {
    if (busqueda.tipo !== tipo || busqueda.id === idDiario(fecha, tipo)) continue;
    if (!mejor || busqueda.fecha >= mejor.fecha) mejor = busqueda;
  }
  return mejor;
}

export interface TareaEquidad {
  busqueda: string;
  tipo: TipoBusqueda;
  partido: PartyId;
  nombre: string;
  periodo: { desde: string; hasta: string };
  plantilla: string;
  consultas: ConsultaTarea[];
  salida: string;
}

/** A query found blocked by the script's own probe: skipped for all four parties. */
export interface Bloqueada {
  host: string;
  estado_http: number | null;
  fecha: string;
  motivo: string;
}

export interface ConsultaTarea {
  texto: string;
  motor: string;
  dominios: string[];
  bloqueada?: Bloqueada;
}

/** One task per kind and party, identical but for the party: the queries of the kind's template. */
export function tareasEquidad(registro: Busqueda[], fecha: string, desde: string): TareaEquidad[] {
  const tareas: TareaEquidad[] = [];
  for (const tipo of TIPOS_BUSQUEDA) {
    const plantilla = plantillaDe(registro, tipo, fecha);
    if (!plantilla) continue;
    for (const partido of PARTY_IDS) {
      tareas.push({
        busqueda: idDiario(fecha, tipo),
        tipo,
        partido,
        nombre: PARTY_SHORT[partido],
        periodo: { desde, hasta: fecha },
        plantilla: plantilla.id,
        consultas: plantilla.consultas.map((consulta) => ({ texto: consultaPara(consulta, partido), motor: consulta.motor, dominios: [...consulta.dominios] })),
        salida: `equidad/${tipo}.${partido}.json`,
      });
    }
  }
  return tareas;
}

/** A search agent's result: only the URL is used here; the rest is for the adjudicator. */
export interface SalidaEquidad {
  busqueda?: string;
  tipo?: string;
  partido?: string;
  resultados?: { url?: unknown }[];
  nota?: unknown;
}

/** Distinct canonical https URLs of an agent's results (invalid ones are ignored). */
export function urlsDeResultados(resultados: unknown): string[] {
  const urls = new Set<string>();
  for (const resultado of lista(resultados)) {
    const url = esObjeto(resultado) && typeof resultado.url === 'string' && /^https:\/\/\S+$/.test(resultado.url) ? canonicaSegura(resultado.url) : undefined;
    if (url) urls.add(url);
  }
  return [...urls].sort(comparar);
}

/** Hosts a query reaches: the URL's host for WebFetch, its domain filter for WebSearch (none when unfiltered). */
export function hostsDeConsulta(consulta: Pick<ConsultaTarea, 'texto' | 'motor' | 'dominios'>): string[] {
  const limpio = (host: string) => host.toLowerCase().replace(/^www\./, '');
  if (consulta.motor === 'WebFetch') {
    try {
      return [limpio(new URL(`https://${consulta.texto}`).hostname)];
    } catch {
      return [];
    }
  }
  return consulta.dominios.map(limpio);
}

/** The URLs the script probes before the search: each WebFetch query, and the home page of each domain of a filtered WebSearch. */
export function urlsSondeo(tareas: TareaEquidad[]): string[] {
  const urls = new Set<string>();
  for (const tarea of tareas) {
    for (const consulta of tarea.consultas) {
      if (consulta.motor === 'WebFetch') urls.add(`https://${consulta.texto}`);
      else for (const host of hostsDeConsulta(consulta)) urls.add(`https://${host}/`);
    }
  }
  return [...urls].sort(comparar);
}

/** Why the four tasks of a kind do not reach the same hosts, query by query (empty when they do). */
export function dominiosDistintos(tareas: TareaEquidad[]): string[] {
  const problemas: string[] = [];
  for (const tipo of TIPOS_BUSQUEDA) {
    const deTipo = tareas.filter((t) => t.tipo === tipo);
    if (!deTipo.length) continue;
    const firmas = new Set(deTipo.map((t) => JSON.stringify(t.consultas.map((c) => [c.motor, hostsDeConsulta(c)]))));
    if (firmas.size > 1) problemas.push(`${tipo}: las consultas no llegan a los mismos dominios en los cuatro partidos`);
  }
  return problemas;
}

/**
 * Marks every query whose host the probe found blocked (401, 403, 429, 451, an
 * anti-bot page or a geo-block, recorded with the run date), the same in all
 * four tasks. Agents skip it; nothing from that host counts for any party.
 */
export function marcarBloqueadas(tareas: TareaEquidad[], bloqueados: Record<string, { fecha: string; estado_http: number | null; motivo: string }>): TareaEquidad[] {
  return tareas.map((tarea) => ({
    ...tarea,
    consultas: tarea.consultas.map((consulta) => {
      const { bloqueada: _previa, ...limpia } = consulta;
      const host = hostsDeConsulta(consulta).find((h) => Object.keys(bloqueados).some((b) => hostEn(h, [b])));
      if (!host) return limpia;
      const clave = Object.keys(bloqueados).sort(comparar).find((b) => hostEn(host, [b]))!;
      const bloqueo = bloqueados[clave]!;
      return { ...limpia, bloqueada: { host, estado_http: bloqueo.estado_http, fecha: bloqueo.fecha, motivo: bloqueo.motivo } };
    }),
  }));
}

/**
 * The script's own probe, before any agent searches: each URL of urlsSondeo
 * once, through Traedor (robots.txt, then the page), with its one honest
 * User-Agent, no retries. A block (401, 403, 429, 451, anti-bot page,
 * geo-block) is recorded with the date in traedor.bloqueados; a block already
 * recorded today is not retried. Fails when the four tasks of a kind do not
 * reach the same domains. Returns the tasks with their blocked queries marked.
 */
export async function sondear(tareas: TareaEquidad[], traedor: Traedor): Promise<{ tareas: TareaEquidad[]; sondeo: { url: string; estado: string; estado_http?: number | null; motivo?: string }[] }> {
  const problemas = dominiosDistintos(tareas);
  if (problemas.length) throw new Error(problemas.join('; '));
  const sondeo: { url: string; estado: string; estado_http?: number | null; motivo?: string }[] = [];
  for (const url of urlsSondeo(tareas)) {
    const r = await traedor.traer(url);
    if (r.estado === 'ok') sondeo.push({ url, estado: 'ok', estado_http: r.estado_http });
    else if (r.estado === 'bloqueado') sondeo.push({ url, estado: 'bloqueado', estado_http: r.bloqueo.estado_http, motivo: r.bloqueo.motivo });
    else sondeo.push({ url, estado: r.estado, motivo: r.motivo });
  }
  // A host that blocks the guide (bloqueo in fuentes.json, the fixed list, a robots.txt veto of the day) is blocked for all four too.
  const vetados: Record<string, { fecha: string; estado_http: number | null; motivo: string }> = {};
  for (const host of new Set(tareas.flatMap((t) => t.consultas.flatMap(hostsDeConsulta)))) {
    const motivo = traedor.vetado(host);
    if (motivo && !traedor.bloqueados[host]) vetados[host] = { fecha: traedor.fecha, estado_http: null, motivo };
  }
  return { tareas: marcarBloqueadas(tareas, { ...traedor.bloqueados, ...vetados }), sondeo };
}

const colapsar = (texto: unknown) => (typeof texto === 'string' ? texto.replace(/\s+/g, ' ').trim() : undefined);

export type EstadoSalida = 'completa' | 'incompleta' | 'sin-salida' | 'no-ejecutada';

/**
 * How a search agent ran its task. Queries are matched by position, their
 * text compared after collapsing whitespace. Complete: `resultados` is an
 * array and every query not marked `bloqueada` is reported "ok". A query the
 * script did not find blocked but the agent reports failed (a 403 the script
 * never saw, say) makes the search incomplete. No unblocked query left: not run today.
 */
export function estadoSalida(tarea: Pick<TareaEquidad, 'consultas'>, salida: unknown): EstadoSalida {
  if (tarea.consultas.every((c) => c.bloqueada)) return 'no-ejecutada';
  if (salida === undefined) return 'sin-salida';
  if (!esObjeto(salida) || !Array.isArray(salida.resultados) || !Array.isArray(salida.consultas)) return 'incompleta';
  if (salida.consultas.length !== tarea.consultas.length) return 'incompleta';
  const hechas = salida.consultas;
  const completa = tarea.consultas.every((consulta, i) => {
    if (consulta.bloqueada) return true;
    const hecha = hechas[i];
    return esObjeto(hecha) && colapsar(hecha.texto) === colapsar(consulta.texto) && hecha.estado === 'ok';
  });
  return completa ? 'completa' : 'incompleta';
}

export const salidaCompleta = (tarea: Pick<TareaEquidad, 'consultas'>, salida: unknown) => estadoSalida(tarea, salida) === 'completa';

/**
 * Results at or above which a grouped source query counts as saturated: the
 * agent then runs its two precomputed halves. Claude Code documents no fixed
 * number of results per WebSearch call (one call may run up to eight backend
 * searches), so this is a fixed choice, the same for every party.
 */
export const RESULTADOS_SATURACION = 10;

/** A search answer as the pass saved it: the parsed JSON, or the .error.txt it left instead. */
export type Respuesta = { contenido: unknown } | { error: true } | undefined;

/**
 * What the search pass left undone, one line each, in task order. Every source
 * task needs its answer with `candidatos` and, for each planned query in
 * `busquedas`, a `consultas` entry with the same party and text, estado "ok"
 * and a number of `resultados`; a saturated query (RESULTADOS_SATURACION or
 * more) also needs both halves in `subconsultas` with estado "ok". Every equal
 * search with an unblocked query needs a complete answer (estadoSalida), and
 * each kind needs its four parties. Empty: the search was the same for all.
 */
export interface RevisionBusqueda {
  /** Every gap, one line each, in task order. */
  faltas: string[];
  /** Tasks whose answer is missing, not JSON or incomplete: one more session may redo them, with the same definitions. */
  reintentables: { fuentes: TareaBusqueda[]; iguales: TareaEquidad[] };
  /** Gaps another session cannot fix: a task without its four queries, a kind without its four parties, more searches declared than counted. */
  definitivas: string[];
}

const buscadaEn = (lista: unknown[], texto: string) => lista.find((e) => esObjeto(e) && colapsar(e.texto) === colapsar(texto)) as Record<string, unknown> | undefined;
const sinRespuesta = (ruta: string, respuesta: Respuesta) =>
  respuesta === undefined ? `${ruta}: falta` : 'error' in respuesta ? `${ruta}: la respuesta no es JSON (${ruta}.error.txt)` : undefined;

/** Gaps of one source answer, and the web searches it declares done. */
function revisarFuente(tarea: TareaBusqueda, respuesta: Respuesta): { faltas: string[]; declaradas: number } {
  const ruta = salidaTarea(tarea);
  const falta = sinRespuesta(ruta, respuesta);
  if (falta) return { faltas: [falta], declaradas: 0 };
  const contenido = (respuesta as { contenido: unknown }).contenido;
  if (!esObjeto(contenido) || !Array.isArray(contenido.candidatos) || !Array.isArray(contenido.consultas)) return { faltas: [`${ruta}: sin las listas candidatos y consultas`], declaradas: 0 };
  const faltas: string[] = [];
  let declaradas = 0;
  const hechas = contenido.consultas.filter(esObjeto);
  for (const consulta of tarea.busquedas) {
    const hecha = buscadaEn(hechas.filter((e) => e.partido === consulta.partido), consulta.texto);
    if (hecha?.estado !== 'ok') {
      faltas.push(`${ruta}: ${consulta.partido} «${consulta.texto}» sin buscar${typeof hecha?.estado === 'string' ? ` (${hecha.estado})` : ''}`);
      continue;
    }
    if (!Number.isInteger(hecha.resultados) || (hecha.resultados as number) < 0) {
      faltas.push(`${ruta}: ${consulta.partido} «${consulta.texto}» sin número de resultados (entero mayor o igual que 0)`);
      continue;
    }
    declaradas += 1;
    if ((hecha.resultados as number) < RESULTADOS_SATURACION || !consulta.mitades) continue;
    const subconsultas = Array.isArray(hecha.subconsultas) ? hecha.subconsultas : [];
    for (const mitad of consulta.mitades) {
      if (buscadaEn(subconsultas, mitad)?.estado !== 'ok') faltas.push(`${ruta}: ${consulta.partido} «${mitad}» sin buscar (mitad de una consulta saturada)`);
      else declaradas += 1;
    }
  }
  return { faltas, declaradas };
}

/** Gaps of one equal-search answer, and the web searches it declares done. */
function revisarIgual(tarea: TareaEquidad, respuesta: Respuesta): { faltas: string[]; declaradas: number } {
  const ruta = tarea.salida;
  const contenido = respuesta && 'contenido' in respuesta ? respuesta.contenido : undefined;
  const hechas = esObjeto(contenido) && Array.isArray(contenido.consultas) ? contenido.consultas : [];
  const declaradas = tarea.consultas.filter((c, i) => c.motor === 'WebSearch' && !c.bloqueada && esObjeto(hechas[i]) && hechas[i].estado === 'ok').length;
  const estado = estadoSalida(tarea, contenido);
  if (estado === 'completa' || estado === 'no-ejecutada') return { faltas: [], declaradas };
  const falta = sinRespuesta(ruta, respuesta);
  if (falta) return { faltas: [falta], declaradas };
  const detalle = tarea.consultas.flatMap((consulta, i) => {
    if (consulta.bloqueada) return [];
    const hecha = hechas[i];
    if (esObjeto(hecha) && colapsar(hecha.texto) === colapsar(consulta.texto) && hecha.estado === 'ok') return [];
    return [`consulta ${i + 1} «${consulta.texto}»: ${esObjeto(hecha) && typeof hecha.estado === 'string' ? hecha.estado : 'sin informar'}`];
  });
  return { faltas: [`${ruta}: incompleta${detalle.length ? ` (${detalle.join('; ')})` : ' (resultados o consultas no son listas)'}`], declaradas };
}

/**
 * What the search pass left undone, in task order. Every source task needs
 * exactly one planned query per party and its answer with `candidatos` and,
 * for each planned query, a `consultas` entry with the same party and text,
 * estado "ok" and a whole number of `resultados` (0 or more); a saturated
 * query (RESULTADOS_SATURACION or more) also needs both halves in
 * `subconsultas` with estado "ok". Every equal search with an unblocked query
 * needs a complete answer (estadoSalida), and each kind needs its four
 * parties. The answers may not declare more web searches than Claude Code
 * counted. Each gap is either retryable (the task's answer) or not.
 */
export function revisarBusqueda(entrada: {
  fuentes: TareaBusqueda[];
  /** The saved answer of a source task, at salidaTarea(tarea) (busqueda/<emisor>.json, or the atrasos file). */
  porFuente: (emisor: string, tarea: TareaBusqueda) => Respuesta;
  iguales: TareaEquidad[];
  porIgual: (tarea: TareaEquidad) => Respuesta;
  /** WebSearch calls Claude Code counted for pass 1 (busquedasRegistradas), when its output reports them. */
  busquedasReales?: number;
  /** The retry session, if it ran: the tasks it redid (answer paths of source tasks, or emisores; salidas of equal searches) and the WebSearch calls it counted. Their answers are checked against its count; the rest against pass 1's. */
  reintento?: { fuentes: readonly string[]; iguales: readonly string[]; busquedasReales?: number };
}): RevisionBusqueda {
  const revision: RevisionBusqueda = { faltas: [], reintentables: { fuentes: [], iguales: [] }, definitivas: [] };
  const definitiva = (falta: string) => {
    revision.faltas.push(falta);
    revision.definitivas.push(falta);
  };
  const declaradas = { pasada: 0, reintento: 0 };
  const sesion = (reintentada: boolean) => (reintentada ? 'reintento' : 'pasada');
  for (const tarea of entrada.fuentes) {
    if (tarea.salida !== undefined && tarea.salida !== `busqueda/${tarea.emisor}.atrasos.json`) {
      definitiva(`descubrir.json: la tarea de ${tarea.emisor} tiene una salida no admitida (${String(tarea.salida)})`);
      continue;
    }
    if (!Array.isArray(tarea.busquedas) || !tarea.busquedas.length) {
      definitiva(`descubrir.json: la tarea de ${tarea.emisor} no tiene búsquedas`);
      continue;
    }
    const porPartido = PARTY_IDS.map((p) => tarea.busquedas.filter((b) => b.partido === p).length);
    if (porPartido.some((n) => n !== 1) || tarea.busquedas.length !== PARTY_IDS.length) {
      definitiva(`descubrir.json: la tarea de ${tarea.emisor} no tiene exactamente una búsqueda por partido (${PARTY_IDS.map((p, i) => `${p} ${porPartido[i]}`).join(', ')})`);
      continue;
    }
    const { faltas, declaradas: hechas } = revisarFuente(tarea, entrada.porFuente(tarea.emisor, tarea));
    const redone = entrada.reintento?.fuentes;
    declaradas[sesion(Boolean(redone && (redone.includes(salidaTarea(tarea)) || (!tarea.salida && redone.includes(tarea.emisor)))))] += hechas;
    if (faltas.length) {
      revision.faltas.push(...faltas);
      revision.reintentables.fuentes.push(tarea);
    }
  }
  const tipos = [...new Set(entrada.iguales.map((t) => t.tipo))];
  for (const tipo of tipos) {
    const delTipo = entrada.iguales.filter((t) => t.tipo === tipo);
    const partidos = new Set(delTipo.map((t) => t.partido));
    for (const partido of PARTY_IDS) if (!partidos.has(partido)) definitiva(`equidad: ${tipo} sin tarea para ${partido}`);
    // The same queries blocked for the four parties, query by query.
    const bloqueos = delTipo.map((t) => JSON.stringify(t.consultas.map((c) => c.bloqueada ?? null)));
    if (new Set(bloqueos).size > 1) definitiva(`equidad: ${tipo} no tiene las mismas consultas bloqueadas para los cuatro partidos`);
  }
  const tiposConFaltas = new Set<string>();
  for (const tarea of entrada.iguales) {
    const { faltas, declaradas: hechas } = revisarIgual(tarea, entrada.porIgual(tarea));
    declaradas[sesion(entrada.reintento?.iguales.includes(tarea.salida) ?? false)] += hechas;
    if (faltas.length) {
      revision.faltas.push(...faltas);
      tiposConFaltas.add(tarea.tipo);
    }
  }
  // An equal search is redone for the four parties of its kind together, never for one alone.
  revision.reintentables.iguales = entrada.iguales.filter((t) => tiposConFaltas.has(t.tipo));
  if (entrada.busquedasReales !== undefined && declaradas.pasada > entrada.busquedasReales) {
    definitiva(`claude/busqueda.salida-*.json: las respuestas de la pasada declaran ${declaradas.pasada} búsquedas web hechas, pero Claude Code registró ${entrada.busquedasReales}`);
  }
  const reales = entrada.reintento?.busquedasReales;
  if (reales !== undefined && declaradas.reintento > reales) {
    definitiva(`claude/busqueda-reintento.salida-*.json: las respuestas reintentadas declaran ${declaradas.reintento} búsquedas web hechas, pero Claude Code registró ${reales}`);
  }
  return revision;
}

/** The answer paths a retry session redoes: each source task's own file (busqueda/<emisor>.json or its atrasos file), then each equal search's. */
export const rutasReintento = (reintento: RevisionBusqueda['reintentables']): string[] => [...reintento.fuentes.map(salidaTarea), ...reintento.iguales.map((t) => t.salida)];

/** reintento-rutas.txt: the only files the retry session may create, each answer and its .error.txt. */
export const textoRutasReintento = (rutas: readonly string[]): string => rutas.flatMap((r) => [`./${r}\n`, `./${r}.error.txt\n`]).join('');

/**
 * fuentes.json must be exactly what fuentes-bloqueo writes: registrarBloqueos
 * on the copy taken before the run, with the day's vetos (key order aside).
 * Empty when it is, or when nothing changed.
 */
export function fuentesEsperadas(antes: unknown, despues: unknown, vetos: readonly VetoGuia[], fecha: string): string[] {
  if (!esObjeto(antes) || !Array.isArray(antes.emisores)) return [];
  const esperado = registrarBloqueos(antes as { emisores: Emisor[] }, vetos, fecha).registro;
  return canonico(esperado) === canonico(despues) || canonico(antes) === canonico(despues) ? [] : ['fuentes.json: no es lo que fuentes-bloqueo escribe con la copia de antes/ y bloqueos-guia.json'];
}

export const faltasBusqueda = (entrada: Parameters<typeof revisarBusqueda>[0]): string[] => revisarBusqueda(entrada).faltas;

/**
 * A saved answer the session marked as not JSON: accepted only if it is
 * valid JSON with nothing but whitespace around it (JSON.parse allows exactly
 * that). Anything else, extra characters included, stays an error.
 */
export function respuestaAceptable(texto: string): boolean {
  try {
    JSON.parse(texto);
    return true;
  } catch {
    return false;
  }
}

/**
 * WebSearch requests Claude Code reports for a pass: the sum of
 * `modelUsage.<model>.webSearchRequests` in its --output-format json result,
 * which includes the subagents' models (on 11 Nov 2026: 203 under the Haiku
 * model, 0 in the main session's `usage.server_tool_use`). Undefined when the
 * output has no such numbers, so the check is skipped rather than guessed.
 */
export function busquedasRegistradas(salida: unknown): number | undefined {
  if (!esObjeto(salida) || !esObjeto(salida.modelUsage)) return undefined;
  const cuentas = Object.values(salida.modelUsage).flatMap((uso) => (esObjeto(uso) && Number.isInteger(uso.webSearchRequests) ? [uso.webSearchRequests as number] : []));
  return cuentas.length ? cuentas.reduce((a, b) => a + b, 0) : undefined;
}

/** Canonical URLs of results, without those on hosts blocked for this kind. */
export function urlsPermitidas(resultados: unknown, bloqueados: string[]): string[] {
  return urlsDeResultados(resultados).filter((url) => !hostEn(hostDe(url), bloqueados));
}

// ---------------------------------------------------------------- videos

/** Video pages yt-dlp may be pointed at: the hosts and URL shapes of FUENTES_VIDEO (transcripciones.ts). */
export { esVideo };

/**
 * Videos to transcribe: debate and interview candidates that are video pages
 * (RTVE Play, YouTube), and the lines of the inbox list
 * $N29_BUZON/videos/<fecha>.txt ("VIDEO_URL [OFICIAL_URL]", # comments).
 * Only https URLs on FUENTES_VIDEO; the official transcript must be https too.
 */
export function videosDelDia(descubierto: Pick<Descubrimiento, 'candidatos'> | undefined, listaBuzon: string | undefined): { video: string; oficial?: string; buzon?: true }[] {
  const salida = new Map<string, { video: string; oficial?: string; buzon?: true }>();
  for (const candidato of descubierto?.candidatos ?? []) {
    if (candidato.genero !== 'debate' && candidato.genero !== 'entrevista') continue;
    if (!esVideo(candidato.url)) continue;
    salida.set(candidato.url_canonica, { video: candidato.url });
  }
  for (const linea of (listaBuzon ?? '').split('\n')) {
    const [video, oficial] = linea.replace(/#.*/, '').trim().split(/\s+/);
    if (!video || !esVideo(video)) continue;
    const clave = canonicaSegura(video);
    if (!clave) continue;
    // The owner listed it: its transcript is marked (origen buzon-videos) and may back a published item.
    salida.set(clave, { video, ...(oficial && /^https:\/\/\S+$/.test(oficial) ? { oficial } : {}), buzon: true });
  }
  return [...salida.entries()].sort(([a], [b]) => comparar(a, b)).map(([, video]) => video);
}

// ---------------------------------------------------------------- search candidates

export interface SalidaFuente {
  emisor?: unknown;
  candidatos?: { url?: unknown; titulo?: unknown; fecha?: unknown }[];
}

/** An equal-search result on a host fuentes.json does not list: never fetched, never published, only listed in the summary for the owner. */
export interface ParaRevisar {
  url: string;
  busqueda: string;
  partido: string;
  host: string;
}

/** Why an equal-search result on an unregistered host was left out (busquedas.json hallazgos, the summary). */
export const MOTIVO_SIN_REGISTRAR = 'Host sin registrar en fuentes.json: no se trae ni se publica sin revisión; queda en «Para revisar» del resumen del día.';

/**
 * The URLs the search agents found, as a Descubrimiento for `traer`: per-source
 * results only on that source's hosts, equal-search results only on the hosts
 * of a registered emisor (fuentes.json). An equal-search result on any other
 * host is not fetched: it goes to `para_revisar`, for the owner, and nothing
 * from it can be published (preparar refuses its URL too). URLs already listed
 * by `descubrir` are left out (they were fetched in stage 1).
 */
export function candidatosDeBusqueda(entrada: {
  fecha: string;
  descubierto: Descubrimiento;
  porFuente: { archivo: string; salida: SalidaFuente }[];
  porEquidad: { archivo: string; salida: SalidaEquidad }[];
  emisores: Emisor[];
}): Descubrimiento & { para_revisar: ParaRevisar[] } {
  const ya = new Set(entrada.descubierto.candidatos.map((c) => c.url_canonica));
  const hostsDe = new Map(entrada.descubierto.tareas_busqueda.map((tarea) => [tarea.emisor, tarea.hosts]));
  const emisorDeHost = (url: string) => entrada.emisores.find((emisor) => hostEn(hostDe(url), emisor.hosts))?.id;
  const paraRevisar = new Map<string, ParaRevisar>();
  const nuevos = new Map<string, Candidato>();
  const fallos: Descubrimiento['fallos'] = [];
  const anotar = (url: string, emisor: string, listado: string, extra: { titulo?: unknown; fecha?: unknown } = {}) => {
    const canonica = /^https:\/\/\S+$/.test(url) ? canonicaSegura(url) : undefined;
    if (!canonica || ya.has(canonica) || nuevos.has(canonica)) return;
    const candidato: Candidato = { url, url_canonica: canonica, emisor, metodo: 'web' as Candidato['metodo'], genero: 'articulo', listado };
    if (esTexto(extra.titulo)) candidato.titulo = extra.titulo;
    if (typeof extra.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(extra.fecha)) candidato.fecha = extra.fecha;
    nuevos.set(canonica, candidato);
  };
  for (const { archivo, salida } of [...entrada.porFuente].sort((a, b) => comparar(a.archivo, b.archivo))) {
    const emisor = typeof salida.emisor === 'string' ? salida.emisor : '';
    const hosts = hostsDe.get(emisor);
    if (!hosts) {
      fallos.push({ emisor: emisor || archivo, listado: `busqueda:${archivo}`, motivo: 'emisor sin tarea de búsqueda hoy' });
      continue;
    }
    for (const c of lista(salida.candidatos)) {
      if (!esObjeto(c) || typeof c.url !== 'string') continue;
      let host = '';
      try {
        host = hostDe(c.url);
      } catch {
        continue;
      }
      if (!hostEn(host, hosts)) continue;
      anotar(c.url, emisor, `busqueda:${emisor}`, c);
    }
  }
  for (const { salida } of [...entrada.porEquidad].sort((a, b) => comparar(a.archivo, b.archivo))) {
    const id = typeof salida.busqueda === 'string' ? salida.busqueda : 'equidad';
    for (const url of urlsDeResultados(salida.resultados)) {
      const emisor = emisorDeHost(url);
      if (emisor) anotar(url, emisor, `busqueda:${id}`);
      else paraRevisar.set(`${url} ${id} ${String(salida.partido)}`, { url, busqueda: id, partido: String(salida.partido ?? ''), host: hostDe(url) });
    }
  }
  const candidatos = [...nuevos.values()].sort((a, b) => comparar(a.emisor, b.emisor) || comparar(a.url_canonica, b.url_canonica));
  const para_revisar = [...paraRevisar.values()].sort((a, b) => comparar(a.url, b.url) || comparar(a.busqueda, b.busqueda) || comparar(a.partido, b.partido));
  return { fecha: entrada.fecha, desde: entrada.descubierto.desde, candidatos, tareas_busqueda: [], omitidos: [], solo_buzon: [], fallos, bloqueados: {}, para_revisar };
}

// ---------------------------------------------------------------- classification tasks

/** Lowercase, no accents, one space between words: for alias matching. */
export const plano = (texto: string) =>
  ` ${texto
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;

/**
 * Parties a text mentions, by the same alias rule for all four: any name,
 * regional brand, member or person, as whole words, after removing the
 * `excluir` phrases.
 */
export function partidosEn(texto: string, alias: Partial<Record<PartyId, Alias>>): PartyId[] {
  const limpio = plano(texto);
  return PARTY_IDS.filter((partido) => {
    const a = alias[partido];
    if (!a) return false;
    let base = limpio;
    for (const excluir of a.excluir) base = base.split(plano(excluir)).join(' ');
    return terminosDe(a).some((termino) => plano(termino).trim() && base.includes(plano(termino)));
  });
}

export interface DocumentoCache {
  id: string;
  meta: Meta;
  texto: string;
}

export interface TareaClasificar {
  doc_id: string;
  partido: PartyId;
  url: string;
  url_canonica: string;
  via: string;
  consultado: string;
  origen: string[];
  texto: string;
  meta: string;
  salida: string;
}

/** An index path: a tag, category, section, author, search, pagination, feed or archive segment, last or followed by one more segment only (`/tags/elecciones`, not `/secciones/politica/<titular>`). */
const RUTA_INDICE = /(?:^|\/)(?:tags?|etiquetas?|temas|topics?|category|categories|categoria|categorias|secciones|seccion|author|authors|autor|autores|autora|search|buscar|busqueda|buscador|page|pagina|feed|feeds|rss|archivo|archive|hemeroteca)(?:\/[^/]+)?$/i;
/** JSON-LD types of a single article or document. */
const TIPO_ARTICULO = /"@type"\s*:\s*"(?:NewsArticle|Article|ReportageNewsArticle|OpinionNewsArticle|AnalysisNewsArticle|BackgroundNewsArticle|ReviewNewsArticle|BlogPosting|LiveBlogPosting|Report|ScholarlyArticle|VideoObject|AudioObject|PodcastEpisode)"/;

/**
 * Why a cached page is not a single article or document, or undefined. The
 * same rule for every party and every origin:
 * - its URL: a home page, a feed, or a path segment of an index (tag,
 *   category, section, author, search, pagination, feed, archive) at the
 *   end of the path or followed by one segment, or a search or page query;
 * - its structure: an HTML page that declares no article in JSON-LD, lists
 *   five or more `<article>` elements, and whose last path segment has no
 *   digit and fewer than four words (a section name, not a headline).
 */
export function motivoNoArticulo(doc: { url_canonica: string; ext?: string; html?: string }): string | undefined {
  let url: URL;
  try {
    url = new URL(doc.url_canonica);
  } catch {
    return 'URL no válida';
  }
  const ruta = url.pathname.replace(/\/+$/, '');
  if (!ruta) return 'portada';
  if (doc.ext === 'xml' || doc.ext === 'rss' || /\.(?:xml|rss|atom)$/i.test(ruta)) return 'feed';
  if (RUTA_INDICE.test(ruta)) return 'página de índice (etiqueta, sección, autor, búsqueda o archivo)';
  if (/[?&](?:s|q|query|page|paged|pagina)=/i.test(url.search)) return 'búsqueda o paginación';
  if (doc.html !== undefined) {
    const ultimo = ruta.split('/').at(-1) ?? '';
    const titular = /\d/.test(ultimo) || ultimo.split(/[-_]/).filter(Boolean).length >= 4;
    const articulos = (doc.html.match(/<article\b/gi) ?? []).length;
    if (!TIPO_ARTICULO.test(doc.html) && articulos >= 5 && !titular) return `listado (${articulos} elementos <article>, sin artículo en JSON-LD)`;
  }
  return undefined;
}

export interface DescartePrevio {
  doc_id: string;
  partido: PartyId;
  url_canonica: string;
  motivo: string;
}

/** Drops the tasks of documents that are not single articles (motivoNoArticulo), recording each one with its reason. */
export function prefiltrarTareas(tareas: TareaClasificar[], pagina: (doc_id: string) => { ext?: string; html?: string }): { tareas: TareaClasificar[]; descartados_previos: DescartePrevio[] } {
  const motivos = new Map<string, string | undefined>();
  const quedan: TareaClasificar[] = [];
  const descartados_previos: DescartePrevio[] = [];
  for (const tarea of tareas) {
    if (!motivos.has(tarea.doc_id)) motivos.set(tarea.doc_id, motivoNoArticulo({ url_canonica: tarea.url_canonica, ...pagina(tarea.doc_id) }));
    const motivo = motivos.get(tarea.doc_id);
    if (motivo) descartados_previos.push({ doc_id: tarea.doc_id, partido: tarea.partido, url_canonica: tarea.url_canonica, motivo });
    else quedan.push(tarea);
  }
  return { tareas: quedan, descartados_previos };
}

/** Classification tasks per Claude session. */
export const TAMANO_LOTE_CLASIFICAR = MAX_TAREAS_CLASIFICACION;

/**
 * Batches of classification tasks, one `claude -p` call each: sorted by task
 * id (doc_id, then party); a document's tasks always stay together, and each
 * document counts once (`largo`, the length of its text). A batch closes
 * before passing `tamano` tasks or OBJETIVO_CLASIFICACION characters, so one
 * long document goes alone and cannot crowd many others. Deterministic and
 * blind to the party.
 */
export function lotesClasificar(tareas: TareaClasificar[], tamano = TAMANO_LOTE_CLASIFICAR, largo: (docId: string) => number = () => 0, objetivo = OBJETIVO_CLASIFICACION): TareaClasificar[][] {
  const ordenadas = [...tareas].sort((a, b) => comparar(a.salida, b.salida));
  const grupos: TareaClasificar[][] = [];
  for (const t of ordenadas) {
    const ultimo = grupos.at(-1);
    if (ultimo && ultimo[0]!.doc_id === t.doc_id) ultimo.push(t);
    else grupos.push([t]);
  }
  const lotes: TareaClasificar[][] = [];
  let actual: TareaClasificar[] = [];
  let caracteres = 0;
  for (const grupo of grupos) {
    const n = largo(grupo[0]!.doc_id);
    if (actual.length && (caracteres + n > objetivo || actual.length + grupo.length > tamano)) {
      lotes.push(actual);
      actual = [];
      caracteres = 0;
    }
    actual.push(...grupo);
    caracteres += n;
  }
  if (actual.length) lotes.push(actual);
  return lotes;
}

/** Why a saved classification is not usable, or undefined: it must be a JSON object for the task's doc_id and party. */
export function problemaClasificacion(tarea: Pick<TareaClasificar, 'doc_id' | 'partido' | 'salida'>, texto: string | undefined): string | undefined {
  if (texto === undefined) return `${tarea.salida}: falta`;
  let contenido: unknown;
  try {
    contenido = JSON.parse(texto);
  } catch {
    return `${tarea.salida}: no es JSON`;
  }
  if (!esObjeto(contenido)) return `${tarea.salida}: no es un objeto JSON`;
  if (contenido.doc_id !== tarea.doc_id || contenido.partido !== tarea.partido) return `${tarea.salida}: doc_id o partido no son los de la tarea`;
  return undefined;
}

/**
 * One task per new document (cached or re-versioned on `fecha`) and party it
 * mentions, plus every equal-search result for the party that searched it.
 */
export function tareasClasificar(entrada: {
  fecha: string;
  raizCache: string;
  documentos: DocumentoCache[];
  alias: Partial<Record<PartyId, Alias>>;
  porEquidad: { salida: SalidaEquidad }[];
}): TareaClasificar[] {
  const porId = new Map(entrada.documentos.map((doc) => [doc.id, doc]));
  const tareas = new Map<string, TareaClasificar>();
  const anotar = (doc: DocumentoCache, partido: PartyId, origen: string) => {
    const clave = `${doc.id}.${partido}`;
    const previa = tareas.get(clave);
    if (previa) {
      if (!previa.origen.includes(origen)) previa.origen = [...previa.origen, origen].sort(comparar);
      return;
    }
    const dir = join(entrada.raizCache, 'docs', doc.id);
    tareas.set(clave, {
      doc_id: doc.id,
      partido,
      url: doc.meta.url,
      url_canonica: doc.meta.url_canonica,
      via: doc.meta.via,
      consultado: doc.meta.consultado,
      origen: [origen],
      texto: join(dir, 'texto.txt'),
      meta: join(dir, 'meta.json'),
      salida: `clasificacion/${doc.id}.${partido}.json`,
    });
  };
  for (const doc of entrada.documentos) {
    if (doc.meta.consultado !== entrada.fecha) continue;
    for (const partido of partidosEn(doc.texto, entrada.alias)) anotar(doc, partido, 'alias');
  }
  for (const { salida } of entrada.porEquidad) {
    const partido = salida.partido as PartyId;
    if (!(PARTY_IDS as readonly string[]).includes(partido) || typeof salida.busqueda !== 'string') continue;
    for (const url of urlsDeResultados(salida.resultados)) {
      const doc = porId.get(idDocumento(url));
      if (doc) anotar(doc, partido, salida.busqueda);
    }
  }
  return [...tareas.values()].sort((a, b) => comparar(a.doc_id, b.doc_id) || PARTY_IDS.indexOf(a.partido) - PARTY_IDS.indexOf(b.partido));
}

// ---------------------------------------------------------------- preparar

/** A proposal that went through but cites a URL the party sheet already cites: listed in the summary for review. */
export interface ParaRevisarFicha {
  archivo: string;
  indice: number;
  partido: string;
  url: string;
  /** Where the sheet cites it: "ref N, <sección>". */
  en_ficha: string;
}

export interface Descarte {
  archivo: string;
  indice: number;
  partido: string;
  motivo: string;
}

export interface Hecho {
  hecho: string;
  seccion: string;
  /** The voter question the fact answers (criterios/preguntas.md); checked against seccion, never stored. */
  pregunta?: Pregunta;
  partidos: string[];
  item: Objeto;
}

/** The kind of equal search an item must come from, or undefined when it needs none. */
export function tipoBuscado(seccion: string, item: Objeto): TipoBusqueda | undefined {
  if (item.bulo === true) return 'bulos';
  if (seccion === 'criticos-defensores') return item.postura === 'defensor' ? 'defensores' : 'criticos';
  if (typeof item.busqueda === 'string' && item.busqueda.endsWith('-causas')) return 'causas';
  return undefined;
}

const urlsFuentes = (item: Objeto) =>
  lista(item.fuentes)
    .flatMap((f) => (esObjeto(f) && typeof f.url === 'string' ? [canonicaSegura(f.url) ?? f.url] : []))
    .sort(comparar);

/**
 * What fusionar may merge, per party:
 * - an adjudicator's proposals for its own party only (file name = party id);
 * - no `hecho` from an adjudicator: shared facts come only from hechos.json,
 *   written once and copied identically to every party it names;
 * - critics, defenders, hoaxes and court cases only from the day's equal search
 *   of that kind, complete for all four, and only with a URL that search found
 *   for that party; critics and defenders go to en_espera (`ajustar` promotes
 *   them so that the four keep the same count);
 * - no polls from the ban date;
 * - a `pregunta` (Q1..Q8) that matches the `seccion` (preguntas.ts), and a valid
 *   `contexto` flag (never with a veredicto);
 * - every URL a proposal or a fact names (sources, quotes, perfil documents)
 *   `citable`: on a host of fuentes.json or a document the owner supplied
 *   (citas.ts, citableEn). A page the search found on any other host is never
 *   published without the owner.
 */
export function preparar(entrada: {
  fecha: string;
  adjudicados: { archivo: string; contenido: unknown }[];
  hechos: unknown;
  /** Canonical URLs each kind's search found per party; a party missing means that search has no output. */
  equidad: Partial<Record<TipoBusqueda, Partial<Record<PartyId, string[]>>>>;
  /** Whether a URL may back a published item (citas.ts, citableEn). */
  citable: (url: string) => boolean;
  /** The party sheets as the run read them (antes/): a proposal citing a URL one of their items already cites is held for review. */
  existentes: Partial<Record<PartyId, unknown>>;
}): { porPartido: Record<PartyId, Objeto[]>; descartes: Descarte[]; deHechos: number; revisar: ParaRevisarFicha[] } {
  const porPartido = Object.fromEntries(PARTY_IDS.map((id) => [id, [] as Objeto[]])) as Record<PartyId, Objeto[]>;
  const descartes: Descarte[] = [];
  const completa = (tipo: TipoBusqueda) => PARTY_IDS.every((p) => Array.isArray(entrada.equidad[tipo]?.[p]));
  const revisar: ParaRevisarFicha[] = [];
  const citadasPor = new Map<PartyId, Map<string, string>>();
  const yaCitadas = (partido: PartyId) => {
    let mapa = citadasPor.get(partido);
    if (!mapa) {
      mapa = new Map();
      const ficha = entrada.existentes[partido];
      const items = esObjeto(ficha)
        ? [...lista(ficha.secciones).flatMap((s) => (esObjeto(s) ? lista(s.items).map((i) => [String(s.id), i] as const) : [])), ...lista(ficha.en_espera).map((i) => [`${esObjeto(i) ? String(i.seccion) : ''}, en espera`, i] as const)]
        : [];
      for (const [seccion, item] of items) if (esObjeto(item)) for (const url of urlsFuentes(item)) if (!mapa.has(url)) mapa.set(url, `ref ${String(item.ref)}, ${seccion}`);
      citadasPor.set(partido, mapa);
    }
    return mapa;
  };
  const sinRegistrar = (valor: unknown) => {
    const url = urlsEn(valor).find((u) => !entrada.citable(u));
    return url === undefined ? undefined : `${sinConsulta(url)}: host sin registrar en fuentes.json; no se publica sin revisión`;
  };

  for (const { archivo, contenido } of [...entrada.adjudicados].sort((a, b) => comparar(a.archivo, b.archivo))) {
    const propio = archivo.replace(/\.json$/, '');
    const propuestas = Array.isArray(contenido) ? contenido : esObjeto(contenido) ? lista(contenido.propuestas) : [];
    propuestas.forEach((propuesta, indice) => {
      const descartar = (motivo: string) => descartes.push({ archivo, indice, partido: esObjeto(propuesta) ? String(propuesta.partido) : '', motivo });
      if (!(PARTY_IDS as readonly string[]).includes(propio)) return descartar(`archivo de un partido desconocido "${propio}"`);
      if (!esObjeto(propuesta)) return descartar('propuesta no es un objeto');
      if (propuesta.partido !== propio) return descartar(`propuesta para "${String(propuesta.partido)}" en el archivo de ${propio}: cada adjudicador solo propone para su partido`);
      const ajena = sinRegistrar(propuesta);
      if (ajena) return descartar(ajena);
      // A URL an item of the sheet already cites (any section, held items too): it goes through, and the summary lists it
      // for the owner to review. A source cited by several items (a programme) is normal; only an exact duplicate (URL and
      // claim fingerprint) is dropped, by fusionar.
      const repetida = propuesta.destino === 'perfil' ? undefined : urlsFuentes(esObjeto(propuesta.item) ? propuesta.item : {}).map((u) => [u, yaCitadas(propio as PartyId).get(u)] as const).find(([, ref]) => ref);
      if (repetida) revisar.push({ archivo, indice, partido: propio, url: repetida[0], en_ficha: repetida[1]! });
      if (propuesta.destino === 'perfil') return void porPartido[propio as PartyId].push(propuesta);
      const seccion = String(propuesta.seccion);
      const item = esObjeto(propuesta.item) ? propuesta.item : {};
      if (item.hecho !== undefined) return descartar(`hecho "${String(item.hecho)}": los hechos compartidos solo salen de hechos.json`);
      const pregunta = motivoPregunta(propuesta.pregunta, seccion, item) ?? motivoContexto(seccion, item);
      if (pregunta) return descartar(pregunta);
      if (seccion === 'encuestas' && entrada.fecha >= VEDA_ENCUESTAS) return descartar(`veda de encuestas desde el ${VEDA_ENCUESTAS}`);
      const tipo = tipoBuscado(seccion, item);
      if (tipo) {
        if (item.busqueda !== idDiario(entrada.fecha, tipo)) return descartar(`${tipo}: busqueda debe ser "${idDiario(entrada.fecha, tipo)}"`);
        if (!completa(tipo)) return descartar(`${tipo}: la búsqueda igual del día no tiene salida para los cuatro partidos`);
        const encontradas = new Set(entrada.equidad[tipo]?.[propio as PartyId] ?? []);
        if (!urlsFuentes(item).some((url) => encontradas.has(url))) return descartar(`${tipo}: ninguna fuente sale de la búsqueda igual de ${propio}`);
      } else if (item.busqueda !== undefined) {
        return descartar(`busqueda "${String(item.busqueda)}" en un elemento que no es crítico, defensor, bulo ni causa`);
      }
      const salida: Objeto = { ...propuesta };
      if (seccion === 'criticos-defensores') salida.en_espera = true;
      porPartido[propio as PartyId].push(salida);
    });
  }

  let deHechos = 0;
  const hechos = esObjeto(entrada.hechos) ? lista(entrada.hechos.hechos) : [];
  const vistos = new Set<string>();
  hechos.forEach((hecho, indice) => {
    const descartar = (motivo: string) => descartes.push({ archivo: 'hechos.json', indice, partido: '', motivo });
    if (!esObjeto(hecho) || !esTexto(hecho.hecho) || !/^[a-z0-9-]+$/.test(hecho.hecho)) return descartar('hecho sin clave (slug en minúsculas)');
    if (vistos.has(hecho.hecho)) return descartar(`hecho "${hecho.hecho}" repetido`);
    vistos.add(hecho.hecho);
    const partidos = lista(hecho.partidos).filter((p): p is PartyId => (PARTY_IDS as readonly string[]).includes(p as string));
    if (partidos.length < 2) return descartar(`hecho "${hecho.hecho}": un hecho compartido nombra al menos dos partidos`);
    if (!esObjeto(hecho.item)) return descartar(`hecho "${hecho.hecho}" sin item`);
    const ajena = sinRegistrar(hecho.item);
    if (ajena) return descartar(`hecho "${hecho.hecho}": ${ajena}`);
    const seccion = String(hecho.seccion);
    if (seccion === 'criticos-defensores' || hecho.item.bulo === true || hecho.item.busqueda !== undefined) return descartar(`hecho "${hecho.hecho}": críticos, defensores, bulos y causas salen de la búsqueda igual`);
    if (seccion === 'encuestas' && entrada.fecha >= VEDA_ENCUESTAS) return descartar(`veda de encuestas desde el ${VEDA_ENCUESTAS}`);
    const motivo = motivoPregunta(hecho.pregunta, seccion, hecho.item) ?? motivoContexto(seccion, hecho.item);
    if (motivo) return descartar(`hecho "${hecho.hecho}": ${motivo}`);
    const item = { ...hecho.item, hecho: hecho.hecho };
    const pregunta = hecho.pregunta === undefined ? {} : { pregunta: hecho.pregunta };
    for (const partido of [...new Set(partidos)].sort((a, b) => PARTY_IDS.indexOf(a) - PARTY_IDS.indexOf(b))) {
      porPartido[partido].push({ partido, seccion, ...pregunta, item: structuredClone(item) });
      deHechos++;
    }
  });
  descartes.sort((a, b) => comparar(a.archivo, b.archivo) || a.indice - b.indice);
  return { porPartido, descartes, deHechos, revisar };
}

// ---------------------------------------------------------------- ajustar

interface Ficha extends Objeto {
  corte?: string;
  secciones: { id: string; items: Objeto[] }[];
  en_espera?: Objeto[];
}

/** Numeric parts of a ref for ordering ("12" before "103", "N1" before "N2"). */
const claveRef = (ref: string) => [...ref.matchAll(/\d+/g)].map((m) => Number(m[0]));
const compararRefs = (a: string, b: string) => {
  const [x, y] = [claveRef(a), claveRef(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return comparar(a, b);
};

export interface Promocion {
  partido: PartyId;
  ref: string;
  postura: string;
}

/**
 * Equal count of critics and of defenders: N per postura is the smallest
 * (published + held) count among the four; each party gets held items of that
 * postura into its section, oldest ref first, until it shows N. Mutates `fichas`.
 */
export function promover(fichas: Record<PartyId, Ficha>): { promovidos: Promocion[]; n: Record<string, number> } {
  const promovidos: Promocion[] = [];
  const n: Record<string, number> = {};
  for (const postura of ['critico', 'defensor']) {
    const seccionDe = (ficha: Ficha) => ficha.secciones.find((s) => s.id === 'criticos-defensores');
    const publicados = (ficha: Ficha) => seccionDe(ficha)?.items.filter((item) => item.postura === postura).length ?? 0;
    const retenidos = (ficha: Ficha) =>
      (ficha.en_espera ?? []).filter((item) => item.seccion === 'criticos-defensores' && item.postura === postura).sort((a, b) => compararRefs(String(a.ref), String(b.ref)));
    n[postura] = Math.min(...PARTY_IDS.map((p) => publicados(fichas[p]) + retenidos(fichas[p]).length));
    for (const partido of PARTY_IDS) {
      const ficha = fichas[partido];
      const seccion = seccionDe(ficha);
      if (!seccion) continue;
      const faltan = n[postura]! - publicados(ficha);
      for (const item of retenidos(ficha).slice(0, Math.max(0, faltan))) {
        ficha.en_espera = (ficha.en_espera ?? []).filter((otro) => otro !== item);
        const { seccion: _seccion, ...publicado } = item;
        seccion.items.push(publicado);
        promovidos.push({ partido, ref: String(item.ref), postura });
      }
      if (ficha.en_espera && !ficha.en_espera.length) delete ficha.en_espera;
    }
  }
  return { promovidos, n };
}

/** What the run knows about the day's equal searches, per kind (and party). */
export interface EquidadDia {
  /** Canonical URLs of complete searches only. */
  urls: Partial<Record<TipoBusqueda, Partial<Record<PartyId, string[]>>>>;
  estados: Partial<Record<TipoBusqueda, Partial<Record<PartyId, EstadoSalida>>>>;
  notas: Partial<Record<TipoBusqueda, Partial<Record<PartyId, string>>>>;
  /** Queries blocked for all four, by position. */
  bloqueadas: Partial<Record<TipoBusqueda, (Bloqueada & { indice: number })[]>>;
}

const NOTA_ESTADO: Record<Exclude<EstadoSalida, 'completa'>, string> = {
  'sin-salida': 'La búsqueda no devolvió salida para este partido.',
  incompleta: 'La búsqueda de este partido quedó incompleta: alguna consulta no bloqueada no se completó.',
  'no-ejecutada': 'No se ejecutó: todas las consultas estaban bloqueadas.',
};

const SIN_PROPUESTA = 'No se propuso ningún elemento con esta URL.';

/**
 * The disposition of each finding of one run for one party, after the merge
 * and the promotion: published (the refs of the items that carry the run's id
 * and cite the URL; the finding is named by the URL those items cite), held
 * (the first such item in `en_espera`), or discarded with the reason the run
 * knows (`motivos`, by canonical URL), the item that already had it from
 * another search, or that nothing was proposed.
 */
export function hallazgosDe(entrada: { id: string; urls: string[]; ficha: Ficha | undefined; motivos?: Record<string, string> }): Hallazgo[] {
  // The URL as the item cites it among its fuentes (the site matches it exactly), found by its canonical form.
  const citada = (item: Objeto, url: string) =>
    lista(item.fuentes)
      .map((f) => (esObjeto(f) && typeof f.url === 'string' ? f.url : undefined))
      .find((u) => u !== undefined && (canonicaSegura(u) ?? u) === url);
  const conUrl = (items: Objeto[], url: string) => items.filter((item) => citada(item, url) !== undefined).sort((a, b) => compararRefs(String(a.ref), String(b.ref)));
  const publicados = entrada.ficha?.secciones.flatMap((s) => s.items) ?? [];
  const retenidos = entrada.ficha?.en_espera ?? [];
  return entrada.urls.map((url): Hallazgo => {
    const propios = (items: Objeto[]) => conUrl(items, url).filter((item) => item.busqueda === entrada.id);
    const [primero, ...resto] = propios(publicados);
    if (primero) return { url: citada(primero, url)!, publicado: [primero, ...resto].map((item) => String(item.ref)) };
    const [espera] = propios(retenidos);
    if (espera) return { url: citada(espera, url)!, en_espera: String(espera.ref) };
    const motivo = entrada.motivos?.[url];
    if (motivo) return { url, descartado: motivo };
    const [otro] = conUrl([...publicados, ...retenidos], url);
    if (otro) return { url, descartado: `Ya está en la ficha (${String(otro.ref)}), de otra búsqueda.` };
    return { url, descartado: SIN_PROPUESTA };
  });
}

/**
 * The day's run entries for busquedas.json: the template's queries, the count
 * per party, the queries blocked for all four (host and HTTP status, the same
 * text for the four), which parties' searches did not complete, and one
 * disposition per finding (`hallazgos`, from the merged `fichas`).
 */
export function entradasDelDia(entrada: {
  fecha: string;
  desde: string;
  registro: Busqueda[];
  equidad: EquidadDia;
  /** The party files after the merge and the promotion. */
  fichas?: Partial<Record<PartyId, Ficha>>;
  /** Why a finding was not merged, per party and canonical URL (preparar, fusionar, the adjudication). */
  motivos?: Partial<Record<PartyId, Record<string, string>>>;
}): Busqueda[] {
  const salida: Busqueda[] = [];
  for (const tipo of TIPOS_BUSQUEDA) {
    const id = idDiario(entrada.fecha, tipo);
    const plantilla = plantillaDe(entrada.registro, tipo, entrada.fecha);
    if (!plantilla || entrada.registro.some((b) => b.id === id)) continue;
    const estado = (p: PartyId): EstadoSalida => entrada.equidad.estados[tipo]?.[p] ?? 'sin-salida';
    const noCompletas = PARTY_IDS.filter((p) => estado(p) !== 'completa');
    const notas: Partial<Record<PartyId, string>> = {};
    for (const p of PARTY_IDS) {
      const e = estado(p);
      const propia = entrada.equidad.notas[tipo]?.[p];
      if (e !== 'completa' && e !== 'no-ejecutada') notas[p] = NOTA_ESTADO[e];
      else if (e === 'completa' && esTexto(propia)) notas[p] = propia.trim();
    }
    const bloqueadas = entrada.equidad.bloqueadas[tipo] ?? [];
    const partes = [`Ejecución diaria con las consultas de ${plantilla.id}.`];
    if (bloqueadas.length) {
      partes.push(
        `Consultas bloqueadas para los cuatro partidos (no se sortean ni se fuerzan): ${bloqueadas
          .map((b) => `n.º ${b.indice + 1}, ${b.host}, ${b.motivo === `HTTP ${b.estado_http}` ? b.motivo : `HTTP ${b.estado_http ?? 'sin código'}, ${b.motivo}`}, ${b.fecha}`)
          .join('; ')}.`,
      );
    }
    if (PARTY_IDS.every((p) => estado(p) === 'no-ejecutada')) partes.push('No se ejecutó hoy: todas las consultas estaban bloqueadas.');
    else if (noCompletas.length) partes.push(`Sin salida completa para: ${noCompletas.join(', ')}; lo encontrado de este tipo no se publica hoy para ningún partido.`);
    const run: Busqueda = {
      id,
      tipo,
      fecha: entrada.fecha,
      periodo: { desde: entrada.desde, hasta: entrada.fecha },
      consultas: structuredClone(plantilla.consultas),
      resultados: Object.fromEntries(PARTY_IDS.map((p) => [p, entrada.equidad.urls[tipo]?.[p]?.length ?? 0])),
      hallazgos: Object.fromEntries(
        PARTY_IDS.map((p) => [p, hallazgosDe({ id, urls: entrada.equidad.urls[tipo]?.[p] ?? [], ficha: entrada.fichas?.[p], motivos: entrada.motivos?.[p] })]),
      ) as Record<PartyId, Hallazgo[]>,
      nota: partes.join(' '),
    };
    if (Object.keys(notas).length) run.notas = notas;
    salida.push(run);
  }
  return salida;
}

interface Perfil extends Objeto {
  periodo: { desde: string; hasta: string };
  documentos: Objeto[];
  propuestas: Objeto[];
  mensajes: Objeto[];
  en_espera?: { documentos: Objeto[]; propuestas: Objeto[]; mensajes: Objeto[] };
}

/**
 * A perfil's held documents dated on or before periodo.hasta are published,
 * with the held propuestas and mensajes whose documents are all published now
 * (the site: a document en_espera is dated after the period; published items
 * never cite a held document). Mutates `perfil`.
 */
export function publicarAlcanzados(perfil: Perfil): void {
  const espera = perfil.en_espera;
  if (!esObjeto(espera)) return;
  const alcanzado = (doc: Objeto) => typeof doc.fecha === 'string' && doc.fecha <= perfil.periodo.hasta;
  perfil.documentos.push(...lista(espera.documentos).filter((d): d is Objeto => esObjeto(d) && alcanzado(d)));
  espera.documentos = lista(espera.documentos).filter((d): d is Objeto => !(esObjeto(d) && alcanzado(d)));
  const publicados = new Set(perfil.documentos.map((d) => d.id));
  const listo = (item: Objeto) =>
    lista(item.documentos).every((id) => publicados.has(id)) && (!esObjeto(item.cita) || item.cita.documento === undefined || publicados.has(item.cita.documento));
  for (const campo of ['propuestas', 'mensajes'] as const) {
    const items = lista(espera[campo]).filter(esObjeto);
    perfil[campo].push(...items.filter(listo));
    espera[campo] = items.filter((item) => !listo(item));
  }
  if (!espera.documentos.length && !espera.propuestas.length && !espera.mensajes.length) delete perfil.en_espera;
}

/**
 * corte moves to the run date in all four party files when any party file or
 * perfil changed (the site requires the same corte), and each perfil's
 * periodo.hasta follows its party's corte (the site requires them equal), with
 * the held documents the new corte reaches published.
 */
export function igualarCorte(
  fichas: Record<PartyId, Ficha>,
  antes: Record<PartyId, string>,
  fecha: string,
  perfiles: Partial<Record<PartyId, Perfil>> = {},
  perfilesAntes: Partial<Record<PartyId, string>> = {},
): boolean {
  const cambio =
    PARTY_IDS.some((p) => JSON.stringify(fichas[p]) !== antes[p]) ||
    PARTY_IDS.some((p) => perfiles[p] !== undefined && JSON.stringify(perfiles[p]) !== perfilesAntes[p]);
  if (!cambio) return false;
  for (const p of PARTY_IDS) if (typeof fichas[p].corte !== 'string' || fichas[p].corte! < fecha) fichas[p].corte = fecha;
  for (const p of PARTY_IDS) {
    const perfil = perfiles[p];
    if (!perfil) continue;
    perfil.periodo.hasta = fichas[p].corte!;
    publicarAlcanzados(perfil);
  }
  return true;
}

// ---------------------------------------------------------------- adjudication complete

/**
 * Why the day's adjudication is not complete (empty when it is). Each party
 * needs its own file, with `partido` equal to the file name, arrays
 * `propuestas` and `decisiones`, and a decision for every classified document
 * of the party. Anything missing stops the run: no party is published on a day
 * one of them was not adjudicated. (A single proposal for another party is
 * dropped by `preparar`, not fatal.)
 */
export function problemasAdjudicacion(archivos: Partial<Record<PartyId, unknown>>, clasificadas: Pick<TareaClasificar, 'doc_id' | 'partido' | 'url_canonica'>[]): string[] {
  const problemas: string[] = [];
  for (const partido of PARTY_IDS) {
    const contenido = archivos[partido];
    const donde = `adjudicado/${partido}.json`;
    if (!esObjeto(contenido)) {
      problemas.push(`${donde}: falta o no es un objeto JSON`);
      continue;
    }
    if (contenido.partido !== partido) problemas.push(`${donde}: partido es "${String(contenido.partido)}"`);
    if (!Array.isArray(contenido.propuestas)) problemas.push(`${donde}: propuestas no es una lista`);
    if (!Array.isArray(contenido.decisiones)) {
      problemas.push(`${donde}: decisiones no es una lista`);
      continue;
    }
    const decididas = new Set<string>();
    for (const decision of contenido.decisiones) {
      if (!esObjeto(decision)) continue;
      if (typeof decision.doc_id === 'string') decididas.add(decision.doc_id);
      if (typeof decision.url === 'string') decididas.add(canonicaSegura(decision.url) ?? decision.url);
    }
    const sinDecision = clasificadas.filter((t) => t.partido === partido && !decididas.has(t.doc_id) && !decididas.has(t.url_canonica)).map((t) => t.doc_id);
    if (sinDecision.length) problemas.push(`${donde}: sin decisión para ${[...new Set(sinDecision)].sort(comparar).join(', ')}`);
  }
  return problemas;
}

// ---------------------------------------------------------------- informe

const apartado = (titulo: string, lineas: string[], vacio = '_Ninguno._') => [`### ${titulo} (${lineas.length})`, '', ...(lineas.length ? lineas : [vacio]), ''];

/** Markdown appendix: the stages, what was dropped and why, promotions, and new quote problems. */
export function informe(entrada: {
  fecha: string;
  etapas: string;
  preparar?: { descartes?: Descarte[]; deHechos?: number; revisar?: ParaRevisarFicha[] };
  fusionar?: { rechazados?: { archivo: string; indice: number; motivo: string }[]; cambios?: { partido: string; destino: string; añadidos: unknown[]; duplicados: number }[] };
  ajustar?: { promovidos?: Promocion[]; n?: Record<string, number>; corte?: boolean; busquedas?: string[] };
  citasNuevas?: string;
  /** Classification tasks without a valid output, per party. */
  sinClasificar?: Partial<Record<PartyId, string[]>>;
  /** enlaces.json: the owner's links list, fetched like any article. */
  enlaces?: { enlaces?: ResultadoEnlace[]; avisos?: AvisoEnlace[] };
  /** busqueda-reintentadas.txt and busqueda-aceptadas.txt: the gaps redone in the retry session, and the answers accepted with whitespace around them. */
  reintentadas?: string;
  aceptadas?: string;
  /** tareas-clasificar.json, to say which parties the alias rule found in each link. */
  clasificar?: Pick<TareaClasificar, 'url_canonica' | 'partido'>[];
  /** descubrir.busqueda.json `para_revisar`: equal-search results on hosts fuentes.json does not list, never fetched or published. */
  paraRevisar?: ParaRevisar[];
  /** hechos.json `para_revisar`: what the facts merge kept or left out for the owner to review. */
  hechosRevisar?: string[];
  /** recortes/<sesión>.json: the documents a Claude call got as a party-neutral excerpt (longer than MAX_DOCUMENTO), by session. */
  recortes?: { sesion: string; recorte: Recorte }[];
}): string {
  const etapas = entrada.etapas
    .split('\n')
    .filter(Boolean)
    .map((linea) => {
      const [etapa, estado, ...detalle] = linea.split('\t');
      return `| ${etapa} | ${estado} | ${detalle.join(' ').replace(/\|/g, '\\|')} |`;
    });
  const lineas = ['', '---', '', `# Ejecución del ${entrada.fecha}`, '', '| Etapa | Estado | Detalle |', '|---|---|---|', ...etapas, ''];
  lineas.push(...apartado('Propuestas apartadas antes de fusionar', (entrada.preparar?.descartes ?? []).map((d) => `- \`${d.archivo}\` #${d.indice}${d.partido ? ` (${d.partido})` : ''}: ${d.motivo}`)));
  lineas.push(`Elementos generados desde hechos.json: ${entrada.preparar?.deHechos ?? 0}.`, '');
  lineas.push(...apartado('Hechos para revisar (al unir los lotes de hechos)', (entrada.hechosRevisar ?? []).map((r) => `- ${r}`)));
  lineas.push(
    ...apartado(
      'Para revisar: propuestas que citan una URL que la ficha ya cita (pasan; solo un duplicado exacto se aparta)',
      (entrada.preparar?.revisar ?? []).map((r) => `- \`${r.archivo}\` #${r.indice} (${r.partido}): <${sinConsulta(r.url)}>, ya en la ficha (${r.en_ficha})`),
    ),
  );
  lineas.push(...apartado('Rechazadas por fusionar', (entrada.fusionar?.rechazados ?? []).map((r) => `- \`${r.archivo}\` #${r.indice}: ${r.motivo}`)));
  lineas.push(
    ...apartado(
      'Fusionado por archivo',
      (entrada.fusionar?.cambios ?? []).map((c) => `- ${c.partido} (${c.destino}): ${c.añadidos.length} añadidos, ${c.duplicados} duplicados`),
      '_Nada._',
    ),
  );
  const n = entrada.ajustar?.n ?? {};
  lineas.push(
    ...apartado(
      `Promovidos desde en_espera (N críticos = ${n.critico ?? '—'}, N defensores = ${n.defensor ?? '—'})`,
      (entrada.ajustar?.promovidos ?? []).map((p) => `- ${p.partido} ${p.ref} (${p.postura})`),
    ),
  );
  lineas.push(`Corte movido al ${entrada.fecha} en las cuatro fichas: ${entrada.ajustar?.corte ? 'sí' : 'no'}.`, '');
  lineas.push(...apartado('Búsquedas iguales añadidas a busquedas.json', (entrada.ajustar?.busquedas ?? []).map((id) => `- ${id}`), '_Ninguna._'));
  lineas.push(
    ...apartado(
      'Clasificaciones que faltan',
      PARTY_IDS.flatMap((p) => (entrada.sinClasificar?.[p]?.length ? [`- ${p}: ${entrada.sinClasificar[p]!.join(', ')}`] : [])),
      '_Ninguna._',
    ),
  );
  const citas = (entrada.citasNuevas ?? '').split('\n').filter(Boolean);
  lineas.push(...apartado('Problemas de citas nuevos', citas, '_Ninguno._'));
  const lineasDe = (texto?: string) => (texto ?? '').split('\n').filter(Boolean);
  lineas.push(...apartado('Reintentado en una sesión más (busqueda-reintento), la misma regla para todos los partidos', lineasDe(entrada.reintentadas), '_Nada._'));
  lineas.push(...apartado('Respuestas aceptadas con espacios alrededor del JSON', lineasDe(entrada.aceptadas), '_Ninguna._'));
  lineas.push(...apartadoEnlaces(entrada));
  lineas.push(
    ...apartado(
      'Para revisar: resultados de búsquedas iguales en hosts sin registrar en fuentes.json (no se traen ni se publican)',
      (entrada.paraRevisar ?? []).map((r) => `- ${r.partido} (${r.busqueda}): <${sinConsulta(r.url)}>`),
      '_Ninguno._',
    ),
  );
  lineas.push(
    ...apartado(
      'Documentos reducidos a un extracto (más largos que el máximo; ventanas alrededor de los términos de los cuatro partidos, el mismo extracto para todos)',
      (entrada.recortes ?? []).map(({ sesion, recorte: r }) => `- ${sesion}: \`${r.doc_id}\` <${sinConsulta(r.url)}> (via ${r.via}): ${r.caracteres} caracteres, extracto de ${r.extracto} en ${r.ventanas} ventanas`),
      '_Ninguno: todos los documentos llegaron enteros._',
    ),
  );
  return lineas.join('\n').replace(/\n+$/, '\n');
}

const canonicaOVacia = (url: unknown) => {
  try {
    return typeof url === 'string' ? urlCanonica(url) : '';
  } catch {
    return '';
  }
};

/** A link as shown in the summary: scheme, host and path only, without query string or fragment. */
const sinConsulta = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(URL no válida)';
  }
};

/** The links list in the summary: each link (origin buzon-enlaces), the parties the alias rule found, the items added from it, and the avisos. */
function apartadoEnlaces(entrada: Parameters<typeof informe>[0]): string[] {
  const enlaces = entrada.enlaces?.enlaces ?? [];
  const avisos = entrada.enlaces?.avisos ?? [];
  const lineas = enlaces.map((enlace) => {
    const canonica = enlace.url_canonica ?? canonicaOVacia(enlace.url);
    const partidos = PARTY_IDS.filter((p) => (entrada.clasificar ?? []).some((t) => t.partido === p && t.url_canonica === canonica));
    const elementos = (entrada.fusionar?.cambios ?? []).flatMap((c) =>
      c.añadidos.flatMap((a) => (esObjeto(a) && canonicaOVacia(a.url) === canonica ? [`${c.partido} ${String(a.ref ?? '')} (${String(a.seccion ?? c.destino)})`] : [])),
    );
    const estado = enlace.estado === 'ok' ? 'traído' : `no traído (${enlace.estado})`;
    const detalle = enlace.estado !== 'ok' ? '' : `; partidos por la regla de alias: ${partidos.join(', ') || 'ninguno'}; elementos añadidos: ${elementos.join(', ') || 'ninguno'}`;
    return `- línea ${enlace.linea}: <${sinConsulta(enlace.url)}>${enlace.partido ? ` (nota: ${enlace.partido})` : ''}: ${estado}${detalle}`;
  });
  return [
    ...apartado(`Enlaces del buzón (origen ${ORIGEN_ENLACES})`, lineas, '_Ninguno._'),
    ...apartado('Avisos de la lista de enlaces (detalle en enlaces.json)', avisos.map((a) => `- línea ${a.linea}: ${a.motivo}`), '_Ninguno._'),
  ];
}

// ---------------------------------------------------------------- prompts

/** The ```text block that follows the line `<!-- <marcador> -->` in 08-diario.md. */
export function bloque(markdown: string, marcador: string): string {
  const lineas = markdown.split('\n');
  const inicio = lineas.indexOf(`<!-- ${marcador} -->`);
  if (inicio === -1 || lineas[inicio + 1] !== '```text') throw new Error(`08-diario.md: falta el bloque ${marcador}`);
  const fin = lineas.indexOf('```', inicio + 2);
  if (fin === -1) throw new Error(`08-diario.md: el bloque ${marcador} no se cierra`);
  return `${lineas.slice(inicio + 2, fin).join('\n')}\n`;
}

/** Replaces every {{NAME}} with its value; an unknown {{NAME}} is an error, so no placeholder reaches a model. */
export function sustituir(texto: string, valores: Record<string, string>): string {
  return texto.replace(/\{\{([A-Z_]+)\}\}/g, (marcador, nombre: string) => {
    const valor = valores[nombre];
    if (valor === undefined) throw new Error(`08-diario.md: marcador desconocido ${marcador}`);
    return valor;
  });
}

/** The polls rule of the day. */
export const reglaEncuestas = (fecha: string) =>
  fecha >= VEDA_ENCUESTAS
    ? `From ${VEDA_ENCUESTAS} the law bans publishing polls: propose no encuestas item.`
    : `Polls may be proposed (section encuestas) until ${VEDA_ENCUESTAS}, when the legal ban on publishing them starts.`;

/** Subagents of 08-diario.md: model and tools are fixed here, never chosen by the session. */
export const SUBAGENTES = {
  'buscador-fuente': { model: 'haiku', tools: ['WebSearch', 'WebFetch'], description: 'Searches one news source for the day (Haiku). Returns JSON only.' },
  'buscador-equidad': { model: 'haiku', tools: ['WebSearch', 'WebFetch'], description: 'Runs one equal search for one party exactly as written (Haiku). Returns JSON only.' },
} as const;
// The classification, the shared facts and the adjudication are no subagents: script-driven `claude -p` calls with no tools (juicio.ts).

/** The model of each judgement call. */
export const MODELO_JUICIO = { clasificacion: 'haiku', hechos: 'opus', adjudicacion: 'opus' } as const;

/**
 * The prompts and the --agents definition, with the day's values (PARTIDO: the
 * party of an adjudication call). The search prompt gets its tasks appended by
 * the CLI (tareasDeBusqueda); a judgement prompt gets its material (juicio.ts).
 */
export function prompts(markdown: string, valores: Record<string, string>) {
  const agentes = Object.fromEntries(
    Object.entries(SUBAGENTES).map(([nombre, def]) => [nombre, { ...def, tools: [...def.tools], prompt: sustituir(bloque(markdown, `agente:${nombre}`), valores) }]),
  );
  const busqueda = sustituir(bloque(markdown, 'prompt:busqueda'), valores);
  return {
    // The retry session runs the same prompt on the subset of tasks the gate wrote.
    busqueda,
    'busqueda-reintento': busqueda,
    // One prompt for every classification batch: only the material changes.
    clasificacion: sustituir(bloque(markdown, 'prompt:clasificacion'), valores),
    hechos: sustituir(bloque(markdown, 'prompt:hechos'), valores),
    // One prompt for every party's adjudication session: only the party id changes.
    adjudicacion: sustituir(bloque(markdown, 'prompt:adjudicacion'), { ...valores, PARTIDO: valores.PARTIDO ?? '<partido>' }),
    agentes,
  };
}

/** The Claude passes and what each may write in the run folder: only its own subagents' answers. */
export const ESCRITURA_POR_PASADA = {
  busqueda: ['busqueda/**', 'equidad/**'],
  'busqueda-reintento': ['busqueda/**', 'equidad/**'],
  // Each classification session is allowed only its batch's files (ajustesClaude, `soloRutas`); this is what the others are denied.
  clasificacion: ['clasificacion/**'],
  hechos: ['hechos.json*'],
  // The facts session and each adjudication session (one per party) are allowed only their own answer (ajustesClaude, `soloRutas`).
  adjudicacion: ['adjudicado/**'],
} as const;
export type Pasada = keyof typeof ESCRITURA_POR_PASADA;
export const esPasada = (valor: unknown): valor is Pasada => typeof valor === 'string' && Object.hasOwn(ESCRITURA_POR_PASADA, valor);

/**
 * Claude Code's default cap on WebSearch calls (CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION;
 * code.claude.com/docs/en/tools-reference, "Session search limit"). With `claude -p` it applies
 * to the whole turn, so every subagent of a pass shares it.
 */
export const BUSQUEDAS_WEB_POR_DEFECTO = 200;

/** WebSearch calls the search pass may make at most, without retries: each source query plus its two halves if it has them (all may saturate), and each unblocked WebSearch query of each equal search. */
export function busquedasWebPrevistas(fuentes: TareaBusqueda[], iguales: TareaEquidad[]): number {
  const porFuentes = fuentes.reduce((total, tarea) => total + (tarea.busquedas ?? []).reduce((n, b) => n + 1 + (b.mitades ? 2 : 0), 0), 0);
  const porIguales = iguales.reduce((total, tarea) => total + tarea.consultas.filter((c) => c.motor === 'WebSearch' && !c.bloqueada).length, 0);
  return porFuentes + porIguales;
}

/**
 * The WebSearch cap of a pass. A cap reached halfway leaves some sources or
 * parties unsearched, which breaks equal treatment, so the search pass gets
 * twice its worst case (busquedasWebPrevistas; every subagent may be retried
 * once), never less than the default. The adjudication pass plans no WebSearch: the default.
 */
export function limiteBusquedasWeb(pasada: Pasada, previstas: number): number {
  return pasada !== 'busqueda' && pasada !== 'busqueda-reintento' ? BUSQUEDAS_WEB_POR_DEFECTO : Math.max(BUSQUEDAS_WEB_POR_DEFECTO, 2 * previstas);
}

/** The subagents each pass may launch: agentes.json carries only these. The judgement passes have none (no Agent tool at all). */
export const AGENTES_POR_PASADA: Record<Pasada, readonly (keyof typeof SUBAGENTES)[]> = {
  busqueda: ['buscador-fuente', 'buscador-equidad'],
  'busqueda-reintento': ['buscador-fuente', 'buscador-equidad'],
  clasificacion: [],
  hechos: [],
  adjudicacion: [],
};

/** Claude Code's own subagents: no pass may launch them (they would get every tool of the session). */
export const AGENTES_INTEGRADOS = ['claude-code-guide', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'] as const;

/** The search passes: the only ones that reach the web. */
export const esPasadaBusqueda = (pasada: Pasada) => pasada === 'busqueda' || pasada === 'busqueda-reintento';

/**
 * The built-in tools of each pass (`claude --tools`). The search passes: Agent
 * for their two subagents, and WebFetch and WebSearch for those; no file tool.
 * The judgement passes: none (`--tools ""`); their only tool is Claude Code's
 * StructuredOutput, which returns the answer and nothing else.
 */
export function herramientasDe(pasada: Pasada): string[] {
  return esPasadaBusqueda(pasada) ? ['Agent', 'WebFetch', 'WebSearch'] : [];
}

/** Built-in tools every pass denies by name, on top of `--tools`: nothing reads, writes or runs anything. */
export const HERRAMIENTAS_DENEGADAS = ['Bash', 'Edit', 'Glob', 'Grep', 'LSP', 'Monitor', 'NotebookEdit', 'PowerShell', 'Read', 'Skill', 'TodoWrite', 'Write', 'mcp__*'] as const;

/**
 * The folders each pass may read (`--add-dir`, `additionalDirectories`): none.
 * No pass has a file tool; the script puts everything into the prompt. Kept as
 * a table so a pass that needs one is a reviewed change.
 */
export const CARPETAS_POR_PASADA: Record<Pasada, readonly ('EJ' | 'DOCS' | 'CRITERIOS')[]> = {
  busqueda: [],
  'busqueda-reintento': [],
  clasificacion: [],
  hechos: [],
  adjudicacion: [],
};

/**
 * The only allow rules without a specifier (reviewed): WebSearch takes none
 * (code.claude.com/docs/en/tools-reference, "WebSearch tool behavior": "A bare
 * `WebSearch` entry in `allow` or `deny` is the only form"), and only the
 * search passes have it; StructuredOutput is the tool `--json-schema` adds to
 * return the answer, with no other effect, in every pass.
 */
export const PERMITIDAS_SIN_ESPECIFICADOR: readonly string[] = ['StructuredOutput', 'WebSearch'];

/**
 * Domains WebFetch fetches without any rule (Claude Code's "preapproved
 * documentation domains", read from the 2.1.322 binary; a path-scoped entry
 * by its host). In `dontAsk` mode they would pass, so the search passes deny
 * each one they do not allow: an explicit `WebFetch(domain:…)` rule takes
 * precedence over that set (tools-reference, "WebFetch tool behavior").
 */
/** The Claude Code version WEBFETCH_PREAPROBADOS was read from; diario.sh refuses another one unless N29_CLAUDE_VERSION_OK=1. */
export const CLAUDE_VERIFICADA = '2.1.322';

export const WEBFETCH_PREAPROBADOS: readonly string[] = [
  'agentskills.io', 'angular.io', 'asp.net', 'blazor.net', 'bun.sh', 'claude.ai', 'claude.com', 'cloud.google.com', 'code.claude.com', 'cypress.io', 'd3js.org',
  'dev.mysql.com', 'dev.wix.com', 'devcenter.heroku.com', 'developer.android.com', 'developer.apple.com', 'developer.mozilla.org', 'doc.rust-lang.org', 'docs.aws.amazon.com',
  'docs.djangoproject.com', 'docs.flutter.dev', 'docs.getdbt.com', 'docs.netlify.com', 'docs.oracle.com', 'docs.python.org', 'docs.spring.io', 'docs.stripe.com', 'docs.swift.org',
  'docs.unity.com', 'docs.unrealengine.com', 'dotnet.microsoft.com', 'en.cppreference.com', 'expressjs.com', 'fastapi.tiangolo.com', 'flask.palletsprojects.com', 'getbootstrap.com',
  'git-scm.com', 'github.com', 'go.dev', 'gradle.org', 'graphql.org', 'hibernate.org', 'huggingface.co', 'jestjs.io', 'jquery.com', 'jupyter.org', 'keras.io', 'kotlinlang.org',
  'kubernetes.io', 'laravel.com', 'learn.microsoft.com', 'matplotlib.org', 'maven.apache.org', 'modelcontextprotocol.io', 'nextjs.org', 'nginx.org', 'nodejs.org', 'numpy.org',
  'pandas.pydata.org', 'platform.claude.com', 'preview.claude.ai', 'prisma.io', 'pytorch.org', 'raw.githubusercontent.com', 'react.dev', 'reactnative.dev', 'reactrouter.com',
  'redis.io', 'redux.js.org', 'requests.readthedocs.io', 'ruby-doc.org', 'scikit-learn.org', 'selenium.dev', 'spark.apache.org', 'symfony.com', 'tailwindcss.com', 'threejs.org',
  'tomcat.apache.org', 'vercel.com', 'vuejs.org', 'webpack.js.org', 'wordpress.org', 'www.ansible.com', 'www.claude.ai', 'www.claude.dev', 'www.docker.com', 'www.kaggle.com',
  'www.mongodb.com', 'www.php.net', 'www.postgresql.org', 'www.sqlite.org', 'www.tensorflow.org', 'www.terraform.io', 'www.typescriptlang.org',
];

/**
 * The hosts the search passes may WebFetch: every emisor of fuentes.json and
 * every host of the day's equal-search tasks (hostsDeConsulta), without www.,
 * sorted. Hosts that are not plain names are left out.
 */
export function hostsWebFetch(emisores: readonly Pick<Emisor, 'hosts'>[], tareas: readonly Pick<TareaEquidad, 'consultas'>[]): string[] {
  const hosts = [...emisores.flatMap((e) => e.hosts), ...tareas.flatMap((t) => t.consultas.flatMap(hostsDeConsulta))];
  return [...new Set(hosts.map((h) => h.toLowerCase().replace(/^www\./, '')))].filter((h) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(h)).sort(comparar);
}

/**
 * The settings of one pass from claude-settings.diario.template.json: every
 * __NAME__ replaced (JSON-escaped). The template allows nothing. No pass may
 * read, write or edit a file (HERRAMIENTAS_DENEGADAS, by name): the script puts
 * the material into the prompt and writes the answers. Every pass may return
 * its structured output (StructuredOutput). The search passes add WebSearch,
 * `WebFetch(domain:…)` for `conWebFetch` only, and Agent for their two
 * subagents; the judgement passes are denied Agent, WebFetch and WebSearch
 * outright. Paths with glob, parenthesis or control characters are refused,
 * so a path cannot widen a rule; an allow rule without a specifier other than
 * PERMITIDAS_SIN_ESPECIFICADOR is refused.
 */
export function ajustesClaude(plantilla: string, valores: Record<string, string>, pasada: Pasada, sinWebFetch: readonly string[] = [], conWebFetch: readonly string[] = []): string {
  for (const [nombre, valor] of Object.entries(valores)) {
    if (!valor.startsWith('/') || /[*?()[\]{}\x00-\x1f]/.test(valor)) throw new Error(`ajustes: ruta no admitida en ${nombre}: ${valor}`);
  }
  if (!esPasada(pasada)) throw new Error(`ajustes: pasada desconocida ${String(pasada)}`);
  const texto = plantilla.replace(/__([A-Z0-9_]+)__/g, (marcador, nombre: string) => {
    const valor = valores[nombre];
    if (valor === undefined) throw new Error(`ajustes: marcador desconocido ${marcador}`);
    return JSON.stringify(valor).slice(1, -1);
  });
  const ajustes = JSON.parse(texto) as { permissions: { allow: unknown[]; deny: unknown[]; additionalDirectories?: unknown } };
  if (!valores.EJ) throw new Error('ajustes: falta EJ');
  if (ajustes.permissions.allow.length) throw new Error(`ajustes: la plantilla no puede permitir nada: ${String(ajustes.permissions.allow[0])}`);
  if (ajustes.permissions.additionalDirectories !== undefined) throw new Error('ajustes: las carpetas de cada pasada no van en la plantilla');
  if (!esPasadaBusqueda(pasada) && conWebFetch.length) throw new Error(`ajustes: la pasada ${pasada} no tiene WebFetch`);

  const carpetas = carpetasDe(pasada, valores);
  ajustes.permissions.additionalDirectories = carpetas;
  const allow: string[] = ['StructuredOutput', ...carpetas.map((carpeta) => `Read(/${carpeta}/**)`)];
  const deny: string[] = [...HERRAMIENTAS_DENEGADAS];
  // Sites whose robots.txt excludes Claude's agents: no pass may fetch them (the host and every subdomain), the fixed list always included.
  const vetados = [...new Set([...SIN_AGENTES_CLAUDE_FIJOS, ...sinWebFetch])].sort(comparar);
  deny.push(...reglasWebFetch(vetados));
  if (esPasadaBusqueda(pasada)) {
    // Its two subagents by name; every other subagent, Claude Code's own included, denied.
    const propios = AGENTES_POR_PASADA[pasada];
    allow.push(...propios.map((nombre) => `Agent(${nombre})`));
    deny.push(...AGENTES_INTEGRADOS.map((nombre) => `Agent(${nombre})`));
    // The web only through the listed hosts: unlisted domains fall to "ask", which dontAsk refuses; the preapproved ones are denied by name.
    const permitidos = conWebFetch.filter((host) => !hostEn(host, vetados));
    allow.push('WebSearch', ...reglasWebFetch(permitidos));
    deny.push(...WEBFETCH_PREAPROBADOS.filter((host) => !hostEn(host.replace(/^www\./, ''), permitidos)).map((host) => `WebFetch(domain:${host})`));
  } else {
    // No subagent and no web at all: the bare rules remove the tools from the session.
    deny.push('Agent', 'WebFetch', 'WebSearch');
  }
  for (const regla of allow) {
    if (!/\(.+\)$/.test(regla) && !PERMITIDAS_SIN_ESPECIFICADOR.includes(regla)) throw new Error(`ajustes: regla de allow sin especificador: ${regla}`);
  }
  ajustes.permissions.allow = allow;
  ajustes.permissions.deny = [...new Set([...ajustes.permissions.deny, ...deny])];
  return `${JSON.stringify(ajustes, null, 2)}\n`;
}


/** The absolute folders of a pass (CARPETAS_POR_PASADA), from ajustesClaude's `valores` (EJ, N29_CACHE, T). */
export function carpetasDe(pasada: Pasada, valores: Record<string, string>): string[] {
  const ruta = { EJ: valores.EJ, DOCS: valores.N29_CACHE && `${valores.N29_CACHE}/docs`, CRITERIOS: valores.T && `${valores.T}/criterios` };
  return CARPETAS_POR_PASADA[pasada].map((clave) => {
    const valor = ruta[clave];
    if (!valor) throw new Error(`ajustes: falta la carpeta ${clave}`);
    return valor;
  });
}

// ---------------------------------------------------------------- CLI

const leerJson = (ruta: string): unknown => JSON.parse(readFileSync(ruta, 'utf8'));
const leerJsonSiExiste = (ruta: string): unknown => (existsSync(ruta) ? leerJson(ruta) : undefined);
const escribirJson = (ruta: string, datos: unknown) => {
  mkdirSync(join(ruta, '..'), { recursive: true });
  writeFileSync(ruta, `${JSON.stringify(datos, null, 2)}\n`);
};
const jsonDeCarpeta = (carpeta: string) =>
  (existsSync(carpeta) ? readdirSync(carpeta) : [])
    .filter((archivo) => archivo.endsWith('.json'))
    .sort(comparar)
    .flatMap((archivo) => {
      try {
        return [{ archivo, contenido: leerJson(join(carpeta, archivo)) }];
      } catch {
        return [];
      }
    });

/** Whether an equal-search result's date is a real ISO date no later than the run date. */
export const enPeriodo = (valor: unknown, fecha: string) => typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor) && valor <= fecha;

/** The run's equal searches: tasks (with blocked queries), every output, and the EquidadDia that preparar and ajustar use. */
function leerEquidad(ejecucion: string, fecha: string): EquidadDia & { salidas: { archivo: string; salida: SalidaEquidad }[] } {
  const dia: EquidadDia = { urls: {}, estados: {}, notas: {}, bloqueadas: {} };
  const salidas: { archivo: string; salida: SalidaEquidad }[] = [];
  const tareas = (leerJsonSiExiste(join(ejecucion, 'equidad-tareas.json')) ?? []) as TareaEquidad[];
  const contenidos = new Map(jsonDeCarpeta(join(ejecucion, 'equidad')).map(({ archivo, contenido }) => [archivo, contenido]));
  for (const tarea of tareas) {
    const { tipo, partido } = tarea;
    const archivo = `${tipo}.${partido}.json`;
    const contenido = contenidos.get(archivo);
    const bloqueados = tarea.consultas.flatMap((c) => (c.bloqueada ? [c.bloqueada.host] : []));
    if (partido === PARTY_IDS[0]) {
      dia.bloqueadas[tipo] = tarea.consultas.flatMap((c, indice) => (c.bloqueada ? [{ ...c.bloqueada, indice }] : []));
    }
    const estado = estadoSalida(tarea, contenido);
    (dia.estados[tipo] ??= {})[partido] = estado;
    if (!esObjeto(contenido)) continue;
    // The file name decides kind and party; the content cannot claim another. Nothing from a blocked host counts.
    // Nothing from a blocked host, and nothing dated after the run date (or without a date), for any party.
    const resultados = lista(contenido.resultados)
      .filter((r) => !(esObjeto(r) && typeof r.url === 'string' && urlsPermitidas([r], bloqueados).length === 0))
      .filter((r) => esObjeto(r) && enPeriodo(r.fecha, fecha));
    const salida: SalidaEquidad = { ...contenido, busqueda: idDiario(fecha, tipo), tipo, partido, resultados: resultados as SalidaEquidad['resultados'] };
    salidas.push({ archivo, salida });
    if (esTexto(contenido.nota)) (dia.notas[tipo] ??= {})[partido] = contenido.nota;
    if (estado === 'completa') (dia.urls[tipo] ??= {})[partido] = urlsPermitidas(resultados, bloqueados);
  }
  return { ...dia, salidas };
}

/**
 * Why a URL of a party was not merged, from the run's own records, first reason
 * first: on a host fuentes.json does not list (descubrir.busqueda.json,
 * para_revisar), refused by fusionar (fusionar.json, fusion/<partido>.json), dropped by
 * preparar (preparar.json, adjudicado/<partido>.json), or discarded by the
 * party's adjudicator (its `decisiones`). By party and canonical URL.
 */
function motivosDescarte(ejecucion: string): Partial<Record<PartyId, Record<string, string>>> {
  const motivos: Partial<Record<PartyId, Record<string, string>>> = {};
  const anotar = (partido: unknown, url: unknown, motivo: string) => {
    if (!(PARTY_IDS as readonly unknown[]).includes(partido) || typeof url !== 'string') return;
    const canonica = canonicaSegura(url) ?? url;
    (motivos[partido as PartyId] ??= {})[canonica] ??= motivo;
  };
  const propuestasDe = (ruta: string) => {
    const contenido = leerJsonSiExiste(ruta);
    return Array.isArray(contenido) ? contenido : esObjeto(contenido) ? lista(contenido.propuestas) : [];
  };
  const urlsDe = (propuesta: unknown) => (esObjeto(propuesta) && esObjeto(propuesta.item) ? lista(propuesta.item.fuentes).map((f) => (esObjeto(f) ? f.url : undefined)) : []);
  const descartes = (archivo: string, carpeta: string, campo: string, prefijo: string) => {
    const registro = leerJsonSiExiste(join(ejecucion, archivo));
    for (const d of esObjeto(registro) ? lista(registro[campo]) : []) {
      if (!esObjeto(d) || typeof d.archivo !== 'string' || typeof d.indice !== 'number' || !/^[a-z-]+\.json$/.test(d.archivo)) continue;
      const propuesta = propuestasDe(join(ejecucion, carpeta, d.archivo))[d.indice];
      for (const url of urlsDe(propuesta)) anotar(esObjeto(propuesta) ? propuesta.partido : undefined, url, `${prefijo}: ${String(d.motivo)}`);
    }
  };
  // Equal-search results on an unregistered host were never fetched: that reason first.
  const busqueda = leerJsonSiExiste(join(ejecucion, 'descubrir.busqueda.json'));
  for (const r of esObjeto(busqueda) ? lista(busqueda.para_revisar) : []) if (esObjeto(r)) anotar(r.partido, r.url, MOTIVO_SIN_REGISTRAR);
  descartes('fusionar.json', 'fusion', 'rechazados', 'Rechazado al fusionar');
  descartes('preparar.json', 'adjudicado', 'descartes', 'Apartado al preparar');
  for (const p of PARTY_IDS) {
    const adjudicado = leerJsonSiExiste(join(ejecucion, 'adjudicado', `${p}.json`));
    for (const d of esObjeto(adjudicado) ? lista(adjudicado.decisiones) : []) {
      if (esObjeto(d) && d.decision !== 'propuesto' && esTexto(d.motivo)) anotar(p, d.url, `Descartado en la adjudicación: ${d.motivo.trim()}`);
    }
  }
  return motivos;
}

const rutaDeEntornoHome = () => {
  const home = process.env.HOME;
  if (!home) throw new Error('Falta HOME');
  return home;
};

/** Name of the n-th classification batch (two digits, three from 100; diario.sh takes both). */
export const nombreLote = (n: number) => String(n).padStart(2, '0');
/** A classification batch name: nn, nnn, or reintento-nn(n) for the retry. */
export const NOMBRE_LOTE = /^(?:reintento-)?\d{2,3}$/;

/** The length of a cached document's text (0 when not cached). */
const largoDocumento = (cache: string) => (id: string) => {
  const ruta = join(cache, 'docs', id, 'texto.txt');
  return existsSync(ruta) ? readFileSync(ruta, 'utf8').length : 0;
};

/** A batch's tasks (lotes/clasificar-<nombre>.json) and the only files its session may create (.rutas.txt, as `find` prints them). */
function escribirLote(ejecucion: string, nombre: string, tareas: TareaClasificar[]) {
  escribirJson(join(ejecucion, 'lotes', `clasificar-${nombre}.json`), tareas);
  writeFileSync(join(ejecucion, 'lotes', `clasificar-${nombre}.rutas.txt`), tareas.map((t) => `./${t.salida}\n`).join(''));
}

/** Classification tasks of the run split into those with a valid JSON output and those without, per party. */
function clasificadas(ejecucion: string) {
  const tareas = (leerJsonSiExiste(join(ejecucion, 'tareas-clasificar.json')) ?? []) as TareaClasificar[];
  const hechas: TareaClasificar[] = [];
  const faltan: Partial<Record<PartyId, string[]>> = {};
  for (const tarea of tareas) {
    let valida = false;
    try {
      valida = esObjeto(leerJsonSiExiste(join(ejecucion, tarea.salida)));
    } catch {
      valida = false;
    }
    if (valida) hechas.push(tarea);
    else (faltan[tarea.partido] ??= []).push(tarea.doc_id);
  }
  return { hechas, faltan };
}

/** --pasada, and --lote (classification) or --partido (adjudication), checked. */
function sesionDeArgs(args: string[]): { pasada: Pasada; lote?: string; partido?: PartyId } {
  const valor = (opcion: string) => {
    const i = args.indexOf(opcion);
    return i === -1 ? undefined : args[i + 1];
  };
  const pasada = valor('--pasada');
  if (!esPasada(pasada)) throw new Error('Falta --pasada busqueda|busqueda-reintento|clasificacion|hechos|adjudicacion');
  const lote = valor('--lote');
  if ((pasada === 'clasificacion') !== (lote !== undefined) || (lote !== undefined && !NOMBRE_LOTE.test(lote))) throw new Error('--lote <nn|reintento-nn> va con --pasada clasificacion y solo con ella');
  const partido = valor('--partido');
  if ((pasada === 'adjudicacion') !== (partido !== undefined) || (partido !== undefined && !(PARTY_IDS as readonly string[]).includes(partido))) throw new Error(`--partido <${PARTY_IDS.join('|')}> va con --pasada adjudicacion y solo con ella`);
  return { pasada, ...(lote ? { lote } : {}), ...(partido ? { partido: partido as PartyId } : {}) };
}

/** The tasks of a search session: all of the day's, or the retry subset. Empty for the other passes. */
function tareasDeBusqueda(ejecucion: string, pasada: Pasada): { fuentes: TareaBusqueda[]; iguales: TareaEquidad[] } {
  if (!esPasadaBusqueda(pasada)) return { fuentes: [], iguales: [] };
  const [archivoFuentes, archivoIguales] = pasada === 'busqueda-reintento' ? ['reintento-fuentes.json', 'reintento-equidad.json'] : ['descubrir.json', 'equidad-tareas.json'];
  return {
    fuentes: ((leerJsonSiExiste(join(ejecucion, archivoFuentes)) ?? {}) as { tareas_busqueda?: TareaBusqueda[] }).tareas_busqueda ?? [],
    iguales: (leerJsonSiExiste(join(ejecucion, archivoIguales)) ?? []) as TareaEquidad[],
  };
}

/** A cached document by id: its meta and text, if cached. */
function documentoCache(cache: string, id: string): { meta?: Objeto; texto?: string } {
  const dir = join(cache, 'docs', id);
  const meta = leerJsonSiExiste(join(dir, 'meta.json'));
  return { ...(esObjeto(meta) ? { meta } : {}), ...(existsSync(join(dir, 'texto.txt')) ? { texto: readFileSync(join(dir, 'texto.txt'), 'utf8') } : {}) };
}

/**
 * Everything a judgement call needs, read by the script, as its prompts and
 * batches (material.ts): a classification batch's tasks and documents; the
 * shared-fact candidates by event; a party's documents, equal-search results,
 * sheet, perfil, registry, searches, facts and criteria.
 */
export function materialJuicio(e: { fecha: string; pasada: Pasada; lote?: string; partido?: PartyId; ejecucion: string; cache: string; t: string; datos: string; emisores: Emisor[]; base: string; objetivo?: number }): Prompts {
  const antes = join(e.ejecucion, 'antes');
  const alias = (leerJsonSiExiste(join(e.datos, 'partidos-alias.json')) ?? {}) as Partial<Record<PartyId, Alias>>;
  const terminos = terminosNeutrales(alias);
  const documento = (id: string): DocumentoMaterial => ({ id, ...documentoCache(e.cache, id) });
  if (e.pasada === 'clasificacion') {
    const tareas = leerJson(join(e.ejecucion, 'lotes', `clasificar-${e.lote}.json`)) as TareaClasificar[];
    return promptClasificacion(e.base, tareas, new Map([...new Set(tareas.map((t) => t.doc_id))].map((id) => [id, documento(id)])), terminos);
  }
  const clasificaciones = clasificadas(e.ejecucion).hechas.map((t) => ({ tarea: t, respuesta: leerJson(join(e.ejecucion, t.salida)) as Objeto }));
  const fichas = Object.fromEntries(PARTY_IDS.map((p) => [p, leerJsonSiExiste(join(antes, 'partidos', `${p}.json`))]));
  if (e.pasada === 'hechos') {
    const relevantes = (id: string) => clasificaciones.filter((c) => c.tarea.doc_id === id && c.respuesta.relevante === true);
    const ids = [...new Set(clasificaciones.map((c) => c.tarea.doc_id))].sort(comparar).filter((id) => {
      const r = relevantes(id);
      return r.length >= 2 || r.some((x) => x.respuesta.hecho_compartido === true || lista(x.respuesta.otros_partidos).length > 0);
    });
    const candidatos = ids.map((id) => ({ ...documento(id), clasificaciones: clasificaciones.filter((c) => c.tarea.doc_id === id).map((c) => c.respuesta) }));
    return promptsHechos(e.base, { fuentes: e.emisores, publicados: hechosPublicados(fichas), candidatos, terminos }, e.objetivo);
  }
  const p = e.partido!;
  const criterios = ['preguntas.md', 'verificacion.md', 'enlaces.md', 'neutralidad.md', 'equidad.md'].map((f) => `### ${f}\n${readFileSync(join(e.t, 'criterios', f), 'utf8')}`).join('\n\n');
  // The party's equal-search results (the run's own reading: in period, not blocked), each with its kind, by its document.
  const resultados = leerEquidad(e.ejecucion, e.fecha)
    .salidas.filter(({ salida }) => salida.partido === p)
    .flatMap(({ salida }) => lista(salida.resultados).flatMap((r): Objeto[] => (esObjeto(r) && typeof r.url === 'string' ? [{ ...r, tipo: salida.tipo, busqueda: salida.busqueda }] : [])));
  const documentos = documentosAdjudicacion(p, clasificaciones, resultados, documento, (id) => existsSync(join(e.cache, 'docs', id, 'meta.json')));
  return promptsAdjudicacion(e.base, {
    partido: p,
    criterios,
    ficha: fichas[p],
    perfil: leerJsonSiExiste(join(antes, 'perfiles', `${p}.json`)),
    fuentes: e.emisores,
    busquedas: leerJsonSiExiste(join(antes, 'busquedas.json')),
    hechos: leerJsonSiExiste(join(e.ejecucion, 'hechos.json')),
    documentos: documentos.documentos,
    resultadosSueltos: documentos.sueltos,
    terminos,
  }, e.objetivo);
}

/**
 * A party's adjudication documents: each document classified for it, with its
 * classification, and each cached document its equal searches found, with
 * those results; every one with its whole text, whatever its classification
 * (the same for the four parties). Results whose document is not cached are
 * returned apart (`sueltos`).
 */
export function documentosAdjudicacion(
  partido: PartyId,
  clasificaciones: readonly { tarea: Pick<TareaClasificar, 'doc_id' | 'partido'>; respuesta: Objeto }[],
  resultados: readonly Objeto[],
  documento: (id: string) => DocumentoMaterial,
  enCache: (id: string) => boolean,
): { documentos: (DocumentoMaterial & { clasificacion?: Objeto; resultados: Objeto[] })[]; sueltos: Objeto[] } {
  const porDoc = new Map<string, Objeto[]>();
  const sueltos: Objeto[] = [];
  for (const r of resultados) {
    const canonica = canonicaSegura(String(r.url));
    const id = canonica ? idDocumento(canonica) : undefined;
    if (id && enCache(id)) porDoc.set(id, [...(porDoc.get(id) ?? []), r]);
    else sueltos.push(r);
  }
  const suyas = new Map(clasificaciones.filter((c) => c.tarea.partido === partido).map((c) => [c.tarea.doc_id, c.respuesta]));
  const ids = [...new Set([...suyas.keys(), ...porDoc.keys()])].sort(comparar);
  return { documentos: ids.map((id) => ({ ...documento(id), ...(suyas.has(id) ? { clasificacion: suyas.get(id)! } : {}), resultados: porDoc.get(id) ?? [] })), sueltos };
}

/**
 * What an adjudication batch's answer leaves out: another party, or a
 * document it carried with a classification (by doc_id) or an equal-search
 * result (by canonical URL, or the doc_id of its document) with no decision.
 */
export function decisionesQueFaltan(respuesta: Objeto, partido: string, lote: Pick<LotePrompt, 'clasificados' | 'resultados'>): string[] {
  if (respuesta.partido !== partido) return [`la respuesta es de ${String(respuesta.partido)}, no de ${partido}`];
  const decisiones = lista(respuesta.decisiones).filter(esObjeto);
  const ids = new Set(decisiones.flatMap((d) => (typeof d.doc_id === 'string' ? [d.doc_id] : [])));
  const urls = new Set(decisiones.flatMap((d) => (typeof d.url === 'string' ? [canonicaSegura(d.url) ?? d.url] : [])));
  return [
    ...(lote.clasificados ?? []).filter((id) => !ids.has(id)).map((id) => `sin decisión para el documento ${id}`),
    ...(lote.resultados ?? []).filter((url) => {
      const canonica = canonicaSegura(url) ?? url;
      return !urls.has(canonica) && !ids.has(idDocumento(canonica));
    }).map((url) => `sin decisión para el resultado ${url}`),
  ];
}

/** The name of a Claude session: the pass, with its batch or party (diario.sh: busqueda, clasificacion-01, adjudicacion-pp…). */
const nombreSesion = (pasada: Pasada, lote?: string, partido?: string) => (lote ? `${pasada}-${lote}` : partido ? `${pasada}-${partido}` : pasada);

/**
 * WebSearch calls Claude Code registered for a search session, summed over
 * every call of it (claude/<sesión>.salida-<n>.json, and the single file of
 * older runs). An output that cannot be read or has no count is listed in
 * `ilegibles` and counts 0: the check stays on (a missing count can only make
 * it stricter). `total` is undefined only when the session left no output.
 */
export function busquedasDeSesion(ejecucion: string, sesion: string): { total?: number; ilegibles: string[] } {
  const carpeta = join(ejecucion, 'claude');
  const archivos = (existsSync(carpeta) ? readdirSync(carpeta) : []).filter((f) => f === `${sesion}.salida.json` || new RegExp(`^${sesion}\\.salida-\\d+\\.json$`).test(f)).sort(comparar);
  if (!archivos.length) return { ilegibles: [] };
  let total = 0;
  const ilegibles: string[] = [];
  for (const archivo of archivos) {
    let n: number | undefined;
    try {
      n = busquedasRegistradas(leerJson(join(carpeta, archivo)));
    } catch {
      n = undefined;
    }
    if (n === undefined) ilegibles.push(`claude/${archivo}`);
    else total += n;
  }
  return { total, ilegibles };
}

async function main(args: string[]): Promise<number> {
  const [paso] = args;
  const i = args.indexOf('--fecha');
  const fecha = i === -1 ? undefined : args[i + 1];
  if (!paso || !fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    process.stderr.write('Uso: node src/diario.ts <paso> --fecha AAAA-MM-DD\n');
    return 2;
  }
  const cache = raizCache();
  const ejecucion = join(cache, 'ejecuciones', fecha);
  const datos = join(rutaDeEntorno('N29_SITIO'), 'apps', '29n', 'src', 'data');
  const registro = () => (leerJson(join(datos, 'busquedas.json')) as { busquedas: Busqueda[] }).busquedas;
  const descubierto = () => leerJsonSiExiste(join(ejecucion, 'descubrir.json')) as Descubrimiento | undefined;
  const fichas = () => Object.fromEntries(PARTY_IDS.map((p) => [p, leerJson(join(datos, 'partidos', `${p}.json`))])) as Record<PartyId, Ficha>;

  switch (paso) {
    case 'tareas-equidad': {
      const desde = descubierto()?.desde ?? fecha;
      escribirJson(join(ejecucion, 'equidad-tareas.json'), tareasEquidad(registro(), fecha, desde));
      return 0;
    }
    case 'sondear': {
      const ruta = join(cache, 'bloqueados.json');
      const todos = await leerBloqueados(ruta);
      const { emisores } = await leerRegistro(rutaDeEntorno('N29_SITIO'));
      const acceso = accesoDesdeRegistro(emisores);
      const noTraer = [...new Set([...acceso.noTraer, ...hostsVetadosRobots(await leerVetos(join(ejecucion, 'bloqueos-guia.json')))])].sort();
      const traedor = new Traedor({ fecha, bloqueados: bloqueosDelDia(todos, fecha), ...acceso, noTraer });
      const { tareas, sondeo } = await sondear((leerJson(join(ejecucion, 'equidad-tareas.json')) ?? []) as TareaEquidad[], traedor);
      await escribirBloqueados(ruta, { ...todos, ...traedor.bloqueados });
      await guardarVetos(join(ejecucion, 'bloqueos-guia.json'), traedor.vetos, todos);
      escribirJson(join(ejecucion, 'equidad-tareas.json'), tareas);
      escribirJson(join(ejecucion, 'sondeo.json'), sondeo);
      for (const s of sondeo) process.stdout.write(`${s.estado}\t${s.estado_http ?? ''}\t${s.url}\n`);
      return 0;
    }
    case 'videos': {
      const ruta = join(rutaDeEntorno('N29_BUZON'), 'videos', `${fecha}.txt`);
      for (const v of videosDelDia(descubierto(), existsSync(ruta) ? readFileSync(ruta, 'utf8') : undefined)) process.stdout.write(`${v.video}\t${v.oficial ?? ''}\t${v.buzon ? 'buzon' : ''}\n`);
      return 0;
    }
    case 'candidatos-busqueda': {
      const d = descubierto();
      if (!d) throw new Error('Falta descubrir.json');
      const porFuente = jsonDeCarpeta(join(ejecucion, 'busqueda')).map(({ archivo, contenido }) => ({ archivo, salida: (esObjeto(contenido) ? contenido : {}) as SalidaFuente }));
      const { emisores } = leerJson(join(datos, 'fuentes.json')) as { emisores: Emisor[] };
      escribirJson(join(ejecucion, 'descubrir.busqueda.json'), candidatosDeBusqueda({ fecha, descubierto: d, porFuente, porEquidad: leerEquidad(ejecucion, fecha).salidas, emisores }));
      return 0;
    }
    case 'tareas-clasificar': {
      const docs = join(cache, 'docs');
      const documentos: DocumentoCache[] = (existsSync(docs) ? readdirSync(docs) : []).sort(comparar).flatMap((id) => {
        const meta = leerJsonSiExiste(join(docs, id, 'meta.json')) as Meta | undefined;
        const texto = join(docs, id, 'texto.txt');
        return meta && existsSync(texto) ? [{ id, meta, texto: readFileSync(texto, 'utf8') }] : [];
      });
      const alias = leerJson(join(datos, 'partidos-alias.json')) as Partial<Record<PartyId, Alias>>;
      const todas = tareasClasificar({ fecha, raizCache: cache, documentos, alias, porEquidad: leerEquidad(ejecucion, fecha).salidas });
      // Pages that are not single articles are dropped before any model reads them, by the same rule for all.
      const pagina = (docId: string) => {
        const raw = (existsSync(join(docs, docId)) ? readdirSync(join(docs, docId)) : []).find((archivo) => archivo.startsWith('raw.'));
        const ext = raw?.slice(4);
        return { ext, html: ext === 'html' || ext === 'htm' ? readFileSync(join(docs, docId, raw!), 'utf8') : undefined };
      };
      const { tareas, descartados_previos } = prefiltrarTareas(todas, pagina);
      escribirJson(join(ejecucion, 'tareas-clasificar.json'), tareas);
      escribirJson(join(ejecucion, 'clasificar-descartados.json'), { descartados_previos });
      // One Claude session per batch; each may create only its own answer files.
      // Batches by size too: each call carries its documents' whole text, each document once.
      const largo = new Map(documentos.map((doc) => [doc.id, doc.texto.length + 600]));
      const lotes = lotesClasificar(tareas, TAMANO_LOTE_CLASIFICAR, (id) => largo.get(id) ?? 600);
      rmSync(join(ejecucion, 'lotes'), { recursive: true, force: true });
      lotes.forEach((lote, i) => escribirLote(ejecucion, nombreLote(i + 1), lote));
      process.stdout.write(`${todas.length} tareas, ${descartados_previos.length} descartadas antes (no son artículos), ${tareas.length} en ${lotes.length} lotes (hasta ${TAMANO_LOTE_CLASIFICAR} tareas y ${OBJETIVO_CLASIFICACION} caracteres; un documento más largo, solo)\n`);
      return 0;
    }
    case 'clasificacion-completa': {
      // The gate after the classification sessions: every task needs its valid answer file.
      // With --preparar-reintento, missing or invalid answers get one more session (exit 3).
      const preparar = args.includes('--preparar-reintento');
      // --lote <nn>: only that batch, read-only (exit 0 when all its answers are there and valid).
      const l = args.indexOf('--lote');
      const lote = l === -1 ? undefined : args[l + 1];
      if (lote !== undefined && (!NOMBRE_LOTE.test(lote) || preparar)) throw new Error('--lote <nn|reintento-nn> sin --preparar-reintento');
      const tareas = (leerJsonSiExiste(join(ejecucion, lote === undefined ? 'tareas-clasificar.json' : join('lotes', `clasificar-${lote}.json`))) ?? []) as TareaClasificar[];
      const faltas = tareas.flatMap((tarea) => {
        const ruta = join(ejecucion, tarea.salida);
        const problema = problemaClasificacion(tarea, existsSync(ruta) ? readFileSync(ruta, 'utf8') : undefined);
        return problema ? [{ tarea, problema }] : [];
      });
      if (lote !== undefined) return faltas.length ? 1 : 0;
      if (preparar && faltas.length) {
        for (const { tarea } of faltas) {
          if (!existsSync(join(ejecucion, tarea.salida))) continue;
          mkdirSync(join(ejecucion, 'reintento-anterior', 'clasificacion'), { recursive: true });
          renameSync(join(ejecucion, tarea.salida), join(ejecucion, 'reintento-anterior', tarea.salida));
        }
        // The retry is batched like the first round: by document, each document once.
        for (const viejo of existsSync(join(ejecucion, 'lotes')) ? readdirSync(join(ejecucion, 'lotes')) : []) if (viejo.startsWith('clasificar-reintento')) rmSync(join(ejecucion, 'lotes', viejo));
        const largo = largoDocumento(cache);
        lotesClasificar(faltas.map((f) => f.tarea), TAMANO_LOTE_CLASIFICAR, (id) => largo(id) + 600).forEach((l, n) => escribirLote(ejecucion, `reintento-${nombreLote(n + 1)}`, l));
        writeFileSync(join(ejecucion, 'clasificacion-reintentadas.txt'), faltas.map((f) => `- ${f.problema}\n`).join(''));
        process.stdout.write(`${faltas.length} clasificaciones que faltan o no valen: se reintentan en una sesión más\n`);
        return 3;
      }
      const ruta = join(ejecucion, 'clasificacion-faltan.txt');
      if (faltas.length) writeFileSync(ruta, faltas.map((f) => `- ${f.problema}\n`).join(''));
      else if (existsSync(ruta)) rmSync(ruta);
      process.stdout.write(faltas.length ? `${faltas.length} clasificaciones que faltan o no valen (clasificacion-faltan.txt)\n` : `${tareas.length} clasificaciones completas\n`);
      return faltas.length ? 1 : 0;
    }
    case 'preparar': {
      const { porPartido, descartes, deHechos, revisar } = preparar({
        fecha,
        adjudicados: jsonDeCarpeta(join(ejecucion, 'adjudicado')),
        hechos: leerJsonSiExiste(join(ejecucion, 'hechos.json')),
        equidad: leerEquidad(ejecucion, fecha).urls,
        // The registry as the run read it (antes/), and the owner's own documents in the cache.
        citable: citableEn(cache, hostsRegistrados(leerJson(join(ejecucion, 'antes', 'fuentes.json')))),
        existentes: Object.fromEntries(PARTY_IDS.map((p) => [p, leerJsonSiExiste(join(ejecucion, 'antes', 'partidos', `${p}.json`))])),
      });
      for (const p of PARTY_IDS) escribirJson(join(ejecucion, 'fusion', `${p}.json`), { propuestas: porPartido[p] });
      escribirJson(join(ejecucion, 'preparar.json'), { fecha, descartes, deHechos, revisar });
      return 0;
    }
    case 'ajustar': {
      const actuales = fichas();
      const antes = Object.fromEntries(PARTY_IDS.map((p) => [p, JSON.stringify(leerJson(join(ejecucion, 'antes', 'partidos', `${p}.json`)))])) as Record<PartyId, string>;
      const sinCambios = Object.fromEntries(PARTY_IDS.map((p) => [p, JSON.stringify(actuales[p])]));
      // The perfiles that exist (the site has all four or none), and their snapshot of the day.
      const perfiles = Object.fromEntries(PARTY_IDS.flatMap((p) => (existsSync(join(datos, 'perfiles', `${p}.json`)) ? [[p, leerJson(join(datos, 'perfiles', `${p}.json`))]] : []))) as Partial<Record<PartyId, Perfil>>;
      const perfilesAntes = Object.fromEntries(PARTY_IDS.map((p) => [p, JSON.stringify(leerJsonSiExiste(join(ejecucion, 'antes', 'perfiles', `${p}.json`)))]));
      const perfilesSinCambios = Object.fromEntries(PARTY_IDS.map((p) => [p, JSON.stringify(perfiles[p])]));
      const { promovidos, n } = promover(actuales);
      const corte = igualarCorte(actuales, antes, fecha, perfiles, perfilesAntes);
      for (const p of PARTY_IDS) if (JSON.stringify(actuales[p]) !== sinCambios[p]) escribirJson(join(datos, 'partidos', `${p}.json`), actuales[p]);
      for (const p of PARTY_IDS) if (perfiles[p] && JSON.stringify(perfiles[p]) !== perfilesSinCambios[p]) escribirJson(join(datos, 'perfiles', `${p}.json`), perfiles[p]);
      const reg = leerJson(join(datos, 'busquedas.json')) as { busquedas: Busqueda[] };
      const equidad = leerEquidad(ejecucion, fecha);
      const nuevas = entradasDelDia({ fecha, desde: descubierto()?.desde ?? fecha, registro: reg.busquedas, equidad, fichas: actuales, motivos: motivosDescarte(ejecucion) });
      if (nuevas.length) escribirJson(join(datos, 'busquedas.json'), { ...reg, busquedas: [...reg.busquedas, ...nuevas] });
      escribirJson(join(ejecucion, 'ajustar.json'), { fecha, n, promovidos, corte, busquedas: nuevas.map((b) => b.id) });
      return 0;
    }
    case 'claude': {
      // Everything one Claude pass reads as configuration and material, built fresh into a folder outside every writable one.
      const d = args.indexOf('--dir');
      const dir = d === -1 ? undefined : args[d + 1];
      const { pasada, lote, partido } = sesionDeArgs(args);
      if (!dir) throw new Error('Falta --dir');
      const recogida = join(import.meta.dirname, '..');
      const t = join(recogida, '..');
      const md = readFileSync(join(t, 'agentes', '08-diario.md'), 'utf8');
      const salida = prompts(md, { FECHA: fecha, EJECUCION: ejecucion, CACHE: cache, DATOS: join(ejecucion, 'antes'), CRITERIOS: join(t, 'criterios'), ENCUESTAS: reglaEncuestas(fecha), SATURACION: String(RESULTADOS_SATURACION), ...(partido ? { PARTIDO: partido } : {}) });
      const plantilla = readFileSync(join(recogida, 'claude-settings.diario.template.json'), 'utf8');
      // WebFetch denials from the registry (every emisor with bloqueo) and today's robots.txt vetos.
      // Without a registry (a bare worktree) the fixed list still applies.
      const emisores = ((leerJsonSiExiste(join(datos, 'fuentes.json')) ?? {}) as { emisores?: Emisor[] }).emisores ?? [];
      const vetos = Object.values((leerJsonSiExiste(join(ejecucion, 'bloqueos-guia.json')) ?? {}) as Record<string, VetoGuia>);
      const { fuentes, iguales } = tareasDeBusqueda(ejecucion, pasada);
      const valoresAjustes = { EJ: ejecucion, N29_CACHE: cache, T: t, HOME: rutaDeEntornoHome(), CONF: dir };
      writeFileSync(join(dir, 'settings.json'), ajustesClaude(plantilla, valoresAjustes, pasada, hostsSinClaude(emisores, vetos), esPasadaBusqueda(pasada) ? hostsWebFetch(emisores, iguales) : []));
      // The prompts, one per call (prompt-1.txt…), their batches, and the documents reduced (recortes/<sesión>.json, for the summary).
      const material: Prompts = esPasadaBusqueda(pasada)
        ? { ...promptsBusqueda(salida[pasada], fuentes, iguales), recortes: [] }
        : materialJuicio({ fecha, pasada, lote, partido, ejecucion, cache, t, datos, emisores, base: salida[pasada] });
      material.prompts.forEach((texto, n) => writeFileSync(join(dir, `prompt-${n + 1}.txt`), texto));
      escribirJson(join(dir, 'lotes.json'), material.lotes.map((l, n) => ({ prompt: `prompt-${n + 1}.txt`, ...l })));
      const sesion = nombreSesion(pasada, lote, partido);
      const rutaRecortes = join(ejecucion, 'recortes', `${sesion}.json`);
      if (material.recortes.length) escribirJson(rutaRecortes, material.recortes);
      else if (existsSync(rutaRecortes)) rmSync(rutaRecortes);
      writeFileSync(join(dir, 'esquema.json'), `${JSON.stringify(ESQUEMAS[esPasadaBusqueda(pasada) ? 'busqueda' : (pasada as PasadaJuicio)])}\n`);
      writeFileSync(join(dir, 'modelo.txt'), `${esPasadaBusqueda(pasada) ? 'opus' : MODELO_JUICIO[pasada as keyof typeof MODELO_JUICIO]}\n`);
      // Only the pass's own subagents are defined (the judgement calls have none).
      const agentes = Object.fromEntries(Object.entries(salida.agentes).filter(([nombre]) => (AGENTES_POR_PASADA[pasada] as readonly string[]).includes(nombre)));
      writeFileSync(join(dir, 'agentes.json'), `${JSON.stringify(agentes, null, 2)}\n`);
      // `claude --tools` and `--add-dir` of the pass (diario.sh reads them from here and checks them).
      writeFileSync(join(dir, 'herramientas.txt'), `${herramientasDe(pasada).join(',')}\n`);
      writeFileSync(join(dir, 'carpetas.txt'), carpetasDe(pasada, valoresAjustes).map((c) => `${c}\n`).join(''));
      // The WebSearch cap of each call: its own tasks' worst case (diario.sh gives it to every call of the pass, so the largest).
      const previstas = esPasadaBusqueda(pasada) ? Math.max(0, ...llamadasBusqueda(fuentes, iguales).map((l) => busquedasWebPrevistas(l.fuentes, l.iguales))) : 0;
      writeFileSync(join(dir, 'busquedas-web.txt'), `${limiteBusquedasWeb(pasada, previstas)}\n`);
      // A prompt over MAX_PROMPT is not sent (diario.sh skips it): said here, so the log shows why.
      const largos = material.prompts.flatMap((x, n) => (x.length > MAX_PROMPT ? [`prompt-${n + 1}.txt`] : []));
      writeFileSync(join(dir, 'saltar.txt'), largos.map((x) => `${x}\n`).join(''));
      process.stdout.write(`${material.prompts.length} llamadas: ${material.prompts.map((x) => x.length).join(', ')} caracteres${material.recortes.length ? `; ${material.recortes.length} documentos reducidos a extractos` : ''}\n`);
      for (const largo of largos) process.stdout.write(`demasiado largo, no se envía: ${largo} (más de ${MAX_PROMPT} caracteres)\n`);
      return 0;
    }
    case 'juicio-guardar': {
      // The answers of one pass, from the `claude -p --output-format json` outputs given after --salidas, one per call in
      // order (a missing call: an empty argument): checked against the schema and written by the script to the only
      // files the pass may produce. Missing answers are the gate's business.
      const { pasada, lote, partido } = sesionDeArgs(args);
      const s = args.indexOf('--salidas');
      // Every argument after --salidas up to the next option (an empty one: a call not made).
      const resto = s === -1 ? [] : args.slice(s + 1);
      const fin = resto.findIndex((a) => a.startsWith('--'));
      const archivos = fin === -1 ? resto : resto.slice(0, fin);
      if (!archivos.length) throw new Error('Faltan --salidas');
      const tipo: PasadaJuicio = esPasadaBusqueda(pasada) ? 'busqueda' : (pasada as PasadaJuicio);
      const valores: (Objeto | undefined)[] = [];
      const errores: string[] = [];
      for (const archivo of archivos) {
        let salidaClaude: unknown;
        try {
          salidaClaude = archivo ? leerJson(archivo) : undefined;
        } catch (error) {
          salidaClaude = undefined;
          errores.push(`${archivo}: ${(error as Error).message}`);
        }
        const r = salidaClaude === undefined ? { errores: [`${archivo || '(llamada no hecha)'}: sin salida`] } : respuestaEstructurada(tipo, salidaClaude);
        valores.push(r.valor);
        if (!r.valor) errores.push(...r.errores.slice(0, 20).map((e) => (e.startsWith(archivo) ? e : `${archivo}: ${e}`)));
      }
      const avisos = valores.flatMap((v) => lista(v?.avisos).filter(esTexto));
      for (const aviso of avisos) process.stdout.write(`aviso del modelo: ${aviso.slice(0, 300)}\n`);
      for (const error of errores) process.stdout.write(`no vale: ${error}\n`);
      const escribir = (relativa: string, contenido: string) => {
        mkdirSync(join(ejecucion, relativa, '..'), { recursive: true });
        writeFileSync(join(ejecucion, relativa), contenido);
      };
      if (tipo === 'busqueda') {
        // Each call may answer only its own tasks; the last valid reply for a file wins.
        const { fuentes, iguales } = tareasDeBusqueda(ejecucion, pasada);
        const llamadas = llamadasBusqueda(fuentes, iguales);
        let guardadas = 0;
        valores.forEach((v, n) => {
          const llamada = llamadas[n];
          if (!v || !llamada) return;
          const { porSalida, rechazadas } = respuestasQueCuentan(lista(v.respuestas) as { salida: string; respuesta: string }[], new Set(salidasBusqueda(llamada.fuentes, llamada.iguales)));
          for (const r of rechazadas) process.stdout.write(`salida no admitida en la llamada ${n + 1}: ${JSON.stringify(r).slice(0, 200)}\n`);
          for (const [salida, { contenido, valida }] of porSalida) {
            if (valida && existsSync(join(ejecucion, `${salida}.error.txt`))) rmSync(join(ejecucion, `${salida}.error.txt`));
            escribir(valida ? salida : `${salida}.error.txt`, contenido);
            guardadas++;
          }
        });
        process.stdout.write(`${guardadas} de ${salidasBusqueda(fuentes, iguales).length} respuestas guardadas en ${llamadas.length} llamadas\n`);
        return errores.length ? 1 : 0;
      }
      if (tipo === 'clasificacion') {
        const tareas = leerJson(join(ejecucion, 'lotes', `clasificar-${lote}.json`)) as TareaClasificar[];
        const porClave = new Map(tareas.map((t) => [`${t.doc_id}.${t.partido}`, t]));
        let n = 0;
        for (const v of valores) {
          for (const r of lista(v?.respuestas) as Objeto[]) {
            const tarea = porClave.get(`${String(r.doc_id)}.${String(r.partido)}`);
            if (!tarea) {
              process.stdout.write(`respuesta sin tarea en el lote: ${String(r.doc_id)}.${String(r.partido)}\n`);
              continue;
            }
            porClave.delete(`${tarea.doc_id}.${tarea.partido}`);
            escribir(tarea.salida, `${JSON.stringify(r, null, 2)}\n`);
            n++;
          }
        }
        process.stdout.write(`${n} de ${tareas.length} clasificaciones guardadas\n`);
        return errores.length ? 1 : 0;
      }
      // Facts and adjudication: every batch must be valid, or nothing is written (the gate then retries or fails).
      const destino = tipo === 'hechos' ? 'hechos.json' : `adjudicado/${partido}.json`;
      if (errores.length || valores.some((v) => !v)) {
        escribir(`${destino}.error.txt`, `${errores.join('\n')}\n`);
        return 1;
      }
      const validos = valores as Objeto[];
      if (tipo === 'adjudicacion' && validos.some((v) => v.partido !== partido)) {
        escribir(`${destino}.error.txt`, `una respuesta es de otro partido que ${partido}\n`);
        return 1;
      }
      const { valor, conflictos } = unirRespuestas(tipo, validos);
      if (conflictos.length) {
        for (const c of conflictos) process.stdout.write(`no vale: ${c}\n`);
        escribir(`${destino}.error.txt`, `${conflictos.join('\n')}\n`);
        return 1;
      }
      escribir(destino, `${JSON.stringify(valor, null, 2)}\n`);
      return 0;
    }
    case 'juicio-valida': {
      // Exit 0 when one `claude -p` output (--salida) is a complete answer of one adjudication batch (--lotes lotes.json,
      // --indice n, from 1): valid against the schema, for the session's party, and with a decision for every document
      // and equal-search result the batch carried. Only then does diario.sh keep it for a second round.
      const { pasada, partido } = sesionDeArgs(args);
      const valor = (opcion: string) => {
        const k = args.indexOf(opcion);
        return k === -1 ? undefined : args[k + 1];
      };
      const archivo = valor('--salida');
      const lotes = valor('--lotes');
      const indice = Number(valor('--indice'));
      if (pasada !== 'adjudicacion' || !partido || !archivo || !existsSync(archivo) || !lotes || !Number.isInteger(indice) || indice < 1) return 1;
      try {
        const respuesta = respuestaEstructurada('adjudicacion', leerJson(archivo)).valor;
        const lote = (leerJson(lotes) as LotePrompt[])[indice - 1];
        const faltan = respuesta && lote ? decisionesQueFaltan(respuesta, partido, lote) : ['sin respuesta o sin lote'];
        for (const f of faltan) process.stdout.write(`${f}\n`);
        return faltan.length ? 1 : 0;
      } catch {
        return 1;
      }
    }
    case 'juicio-previos': {
      // The facts the earlier batches of the facts pass wrote today (their valid outputs after --salidas), as the
      // section diario.sh appends to the next batch's prompt: untrusted, model-written data.
      const s = args.indexOf('--salidas');
      const resto = s === -1 ? [] : args.slice(s + 1);
      const fin = resto.findIndex((a) => a.startsWith('--'));
      const archivos = (fin === -1 ? resto : resto.slice(0, fin)).filter(Boolean);
      const valores = archivos.flatMap((archivo) => {
        try {
          const r = respuestaEstructurada('hechos', leerJson(archivo));
          return r.valor ? [r.valor] : [];
        } catch {
          return [];
        }
      });
      const hechos = lista(unirRespuestas('hechos', valores).valor.hechos);
      process.stdout.write(`\n${seccionNoFiable('HECHOS YA ESCRITOS HOY (por los lotes anteriores de esta pasada)', hechos)}\n`);
      return 0;
    }
    case 'juicio-ensayo': {
      // --seco: the answers a pass would give, built from the fixture's answer files (--fijos DIR, repeatable), as
      // `claude -p --output-format json` outputs, one per call (--llamadas N), written to <--salida>-<n>.json, so the
      // same checks and writes as a live run apply. A facts or adjudication answer goes whole in the first call.
      const { pasada, lote, partido } = sesionDeArgs(args);
      const fijos = args.flatMap((a, n) => (a === '--fijos' && args[n + 1] ? [args[n + 1]!] : []));
      const o = args.indexOf('--salida');
      const base = o === -1 ? undefined : args[o + 1];
      const l = args.indexOf('--llamadas');
      const llamadas = l === -1 ? 1 : Number(args[l + 1]);
      if (!base || !Number.isInteger(llamadas) || llamadas < 1) throw new Error('Faltan --salida y --llamadas');
      const buscar = (relativa: string) => fijos.map((f) => join(f, relativa)).find((ruta) => existsSync(ruta));
      const vacia = (): Objeto =>
        esPasadaBusqueda(pasada) || pasada === 'clasificacion' ? { respuestas: [], avisos: [] } : pasada === 'hechos' ? { hechos: [], descartados: [], avisos: [] } : { partido, propuestas: [], decisiones: [], objeciones_hechos: [], hosts_sin_registrar: [], avisos: [] };
      const valores: Objeto[] = Array.from({ length: llamadas }, vacia);
      if (esPasadaBusqueda(pasada)) {
        const { fuentes, iguales } = tareasDeBusqueda(ejecucion, pasada);
        llamadasBusqueda(fuentes, iguales).forEach((llamada, n) => {
          if (n >= llamadas) return;
          valores[n] = {
            respuestas: salidasBusqueda(llamada.fuentes, llamada.iguales).flatMap((s) => {
              const ruta = buscar(s) ?? buscar(`${s}.error.txt`);
              return ruta ? [{ salida: s, respuesta: readFileSync(ruta, 'utf8') }] : [];
            }),
            avisos: [],
          };
        });
      } else if (pasada === 'clasificacion') {
        const tareas = leerJson(join(ejecucion, 'lotes', `clasificar-${lote}.json`)) as TareaClasificar[];
        valores[0] = { respuestas: tareas.flatMap((t) => (buscar(t.salida) ? [leerJson(buscar(t.salida)!)] : [])), avisos: [] };
      } else {
        const ruta = buscar(pasada === 'hechos' ? 'hechos.json' : `adjudicado/${partido}.json`);
        const fijo: Objeto = { ...vacia(), ...(ruta ? (leerJson(ruta) as Objeto) : {}), avisos: [] };
        if (pasada === 'hechos') for (const clave of ['objeciones_hechos', 'hosts_sin_registrar', 'partido', 'propuestas', 'decisiones']) delete fijo[clave];
        valores[0] = fijo;
      }
      valores.forEach((valor, n) => writeFileSync(`${base}-${n + 1}.json`, `${JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0, structured_output: valor })}\n`));
      return 0;
    }
    case 'busqueda-completa': {
      // The gate after the search pass: anything unsearched stops the day, listed in busqueda-faltan.txt for resumen.md.
      // With --preparar-reintento, retryable gaps instead prepare one more session for just those tasks (exit 3).
      const preparar = args.includes('--preparar-reintento');
      // Without its task files the gate has nothing to compare with: that is a failure, never "complete".
      const sinTareas = ['descubrir.json', 'equidad-tareas.json'].filter((archivo) => !existsSync(join(ejecucion, archivo)));
      if (sinTareas.length) {
        writeFileSync(join(ejecucion, 'busqueda-faltan.txt'), sinTareas.map((archivo) => `- falta ${archivo}\n`).join(''));
        process.stdout.write(`faltan ${sinTareas.join(' y ')}\n`);
        return 1;
      }
      const fuentes = descubierto()?.tareas_busqueda ?? [];
      const iguales = (leerJsonSiExiste(join(ejecucion, 'equidad-tareas.json')) ?? []) as TareaEquidad[];
      const rutas = [...fuentes.map(salidaTarea), ...iguales.map((t) => t.salida)];
      // An answer saved as .error.txt that is valid JSON with only whitespace around it is accepted as it is.
      for (const relativa of rutas) {
        const ruta = join(ejecucion, relativa);
        if (!existsSync(ruta) && existsSync(`${ruta}.error.txt`) && respuestaAceptable(readFileSync(`${ruta}.error.txt`, 'utf8'))) {
          renameSync(`${ruta}.error.txt`, ruta);
          writeFileSync(join(ejecucion, 'busqueda-aceptadas.txt'), `- ${relativa}\n`, { flag: 'a' });
          process.stdout.write(`aceptada: ${relativa} (JSON válido con espacios alrededor)\n`);
        }
      }
      const leer = (relativa: string): Respuesta => {
        const ruta = join(ejecucion, relativa);
        if (existsSync(ruta)) {
          try {
            return { contenido: leerJson(ruta) };
          } catch {
            return { error: true };
          }
        }
        return existsSync(`${ruta}.error.txt`) ? { error: true } : undefined;
      };
      // Summed over every call of the session (the search runs in several calls).
      const registradas = (pasada: string) => {
        const { total, ilegibles } = busquedasDeSesion(ejecucion, pasada);
        for (const archivo of ilegibles) process.stdout.write(`${archivo}: sin recuento de búsquedas web legible; cuenta 0\n`);
        return total;
      };
      // After a retry, its answers are checked against its own count, the rest against pass 1's.
      const reintentoHecho = existsSync(join(ejecucion, 'busqueda-reintento.iniciado'));
      const revision = revisarBusqueda({
        fuentes,
        porFuente: (_emisor, tarea) => leer(salidaTarea(tarea)),
        iguales,
        porIgual: (tarea) => leer(tarea.salida),
        busquedasReales: registradas('busqueda'),
        ...(reintentoHecho
          ? {
              reintento: {
                fuentes: (((leerJsonSiExiste(join(ejecucion, 'reintento-fuentes.json')) ?? {}) as { tareas_busqueda?: TareaBusqueda[] }).tareas_busqueda ?? []).map(salidaTarea),
                iguales: ((leerJsonSiExiste(join(ejecucion, 'reintento-equidad.json')) ?? []) as TareaEquidad[]).map((t) => t.salida),
                busquedasReales: registradas('busqueda-reintento'),
              },
            }
          : {}),
      });
      const ruta = join(ejecucion, 'busqueda-faltan.txt');
      const { faltas } = revision;
      const reintento = revision.reintentables;
      if (preparar && faltas.length && !revision.definitivas.length) {
        // The same task definitions, verbatim, for just these tasks; the old answers are kept aside for the audit.
        escribirJson(join(ejecucion, 'reintento-fuentes.json'), { tareas_busqueda: reintento.fuentes });
        escribirJson(join(ejecucion, 'reintento-equidad.json'), reintento.iguales);
        const reintentadas = rutasReintento(reintento);
        for (const relativa of reintentadas) {
          for (const archivo of [relativa, `${relativa}.error.txt`]) {
            if (!existsSync(join(ejecucion, archivo))) continue;
            mkdirSync(join(ejecucion, 'reintento-anterior', archivo, '..'), { recursive: true });
            renameSync(join(ejecucion, archivo), join(ejecucion, 'reintento-anterior', archivo));
          }
        }
        // What was missing, and what is redone: an equal search with its four parties.
        writeFileSync(join(ejecucion, 'busqueda-reintentadas.txt'), [...faltas.map((falta) => `- ${falta}\n`), `- se rehacen: ${reintentadas.join(', ')}\n`].join(''));
        // The only files the retry session may create: diario.sh seals everything else in the run folder.
        writeFileSync(join(ejecucion, 'reintento-rutas.txt'), textoRutasReintento(reintentadas));
        process.stdout.write(`${faltas.length} faltas: se reintentan ${reintentadas.length} tareas en una sesión más (busqueda-reintentadas.txt)\n`);
        return 3;
      }
      if (faltas.length) writeFileSync(ruta, faltas.map((falta) => `- ${falta}\n`).join(''));
      else if (existsSync(ruta)) rmSync(ruta);
      // Gaps another session cannot fix: the day is not offered a resume.
      if (revision.definitivas.length) writeFileSync(join(ejecucion, 'busqueda-definitivas.txt'), revision.definitivas.map((falta) => `- ${falta}\n`).join(''));
      process.stdout.write(faltas.length ? `${faltas.length} faltas en la búsqueda (busqueda-faltan.txt)\n` : 'búsqueda completa\n');
      return faltas.length ? 1 : 0;
    }
    case 'fuentes-bloqueo': {
      // The blocks found today go into the site registry (bloqueo, recogida omitir, or a minimal new emisor); recorded ones are reread, never removed.
      const ruta = join(datos, 'fuentes.json');
      const registro = leerJson(ruta) as { emisores: Emisor[] };
      const vetos = Object.values((leerJsonSiExiste(join(ejecucion, 'bloqueos-guia.json')) ?? {}) as Record<string, VetoGuia>);
      const { registro: nuevo, informe, cambiado } = registrarBloqueos(registro, vetos, fecha);
      const traedor = new Traedor({ fecha, ...accesoDesdeRegistro(registro.emisores) });
      Object.assign(informe, await revisarBloqueos(registro.emisores, traedor));
      if (cambiado) escribirJson(ruta, nuevo);
      escribirJson(join(ejecucion, 'fuentes-bloqueo.json'), informe);
      process.stdout.write(`${informe.nuevos.length} emisores nuevos, ${informe.actualizados.length} actualizados, ${informe.sin_registrar.length} sin registrar, ${informe.ya_no_bloquean.length} ya no bloquean\n`);
      return 0;
    }
    case 'alcance-fuentes': {
      // The allowlist of fuentes.json: only the changes fuentes-bloqueo makes, recomputed from the copy before the run and the day's vetos.
      const antes = leerJsonSiExiste(join(ejecucion, 'antes', 'fuentes.json'));
      const despues = leerJsonSiExiste(join(datos, 'fuentes.json'));
      const vetos = Object.values((leerJsonSiExiste(join(ejecucion, 'bloqueos-guia.json')) ?? {}) as Record<string, VetoGuia>);
      const problemas = [...cambiosFuentesNoAdmitidos(antes, despues), ...fuentesEsperadas(antes, despues, vetos, fecha)];
      for (const problema of problemas) process.stdout.write(`${problema}\n`);
      return problemas.length ? 1 : 0;
    }
    case 'hechos-completo': {
      // The shared facts are complete when hechos.json is a JSON object with a list `hechos`; every party's adjudicator reads that same file.
      let contenido: unknown;
      try {
        contenido = leerJsonSiExiste(join(ejecucion, 'hechos.json'));
      } catch {
        contenido = undefined;
      }
      const completo = esObjeto(contenido) && Array.isArray(contenido.hechos);
      process.stdout.write(completo ? 'hechos.json completo\n' : 'hechos.json: falta o no es un objeto JSON con una lista hechos\n');
      return completo ? 0 : 1;
    }
    case 'adjudicacion-completa': {
      // With --partido, only that party's file (a resumed day keeps the parties already complete).
      const pa = args.indexOf('--partido');
      const soloPartido = pa === -1 ? undefined : args[pa + 1];
      if (soloPartido !== undefined && !(PARTY_IDS as readonly string[]).includes(soloPartido)) throw new Error(`--partido debe ser ${PARTY_IDS.join(', ')}`);
      const archivos = Object.fromEntries(PARTY_IDS.map((p) => [p, (() => {
        try {
          return leerJsonSiExiste(join(ejecucion, 'adjudicado', `${p}.json`));
        } catch {
          return undefined;
        }
      })()]));
      const problemas = problemasAdjudicacion(archivos, clasificadas(ejecucion).hechas).filter((problema) => soloPartido === undefined || problema.startsWith(`adjudicado/${soloPartido}.json:`));
      for (const problema of problemas) process.stdout.write(`${problema}\n`);
      return problemas.length ? 1 : 0;
    }
    case 'informe': {
      const leerTexto = (nombre: string) => (existsSync(join(ejecucion, nombre)) ? readFileSync(join(ejecucion, nombre), 'utf8') : '');
      process.stdout.write(
        informe({
          fecha,
          etapas: leerTexto('etapas.tsv'),
          preparar: leerJsonSiExiste(join(ejecucion, 'preparar.json')) as never,
          fusionar: leerJsonSiExiste(join(ejecucion, 'fusionar.json')) as never,
          ajustar: leerJsonSiExiste(join(ejecucion, 'ajustar.json')) as never,
          citasNuevas: leerTexto('citas-nuevas.txt'),
          reintentadas: leerTexto('busqueda-reintentadas.txt'),
          aceptadas: leerTexto('busqueda-aceptadas.txt'),
          sinClasificar: clasificadas(ejecucion).faltan,
          enlaces: leerJsonSiExiste(join(ejecucion, 'enlaces.json')) as never,
          clasificar: (leerJsonSiExiste(join(ejecucion, 'tareas-clasificar.json')) ?? []) as TareaClasificar[],
          paraRevisar: lista((leerJsonSiExiste(join(ejecucion, 'descubrir.busqueda.json')) as { para_revisar?: unknown } | undefined)?.para_revisar) as ParaRevisar[],
          hechosRevisar: lista((leerJsonSiExiste(join(ejecucion, 'hechos.json')) as { para_revisar?: unknown } | undefined)?.para_revisar).filter(esTexto),
          recortes: (existsSync(join(ejecucion, 'recortes')) ? readdirSync(join(ejecucion, 'recortes')).filter((f) => f.endsWith('.json')).sort(comparar) : []).flatMap((f) =>
            (lista(leerJson(join(ejecucion, 'recortes', f))) as Recorte[]).map((recorte) => ({ sesion: f.replace(/\.json$/, ''), recorte })),
          ),
        }),
      );
      return 0;
    }
    default:
      process.stderr.write(`Paso desconocido: ${paso}\n`);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (codigo) => {
      process.exitCode = codigo;
    },
    (error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
