/**
 * Deterministic glue of the daily run (bin/diario.sh) between the CLI stages
 * and the judgment stages of agentes/08-diario.md. No clock, no randomness:
 * the run date is an argument and every list is sorted.
 *
 *   node src/diario.ts tareas-equidad      --fecha D   equidad-tareas.json: the equal searches, one per kind and party
 *   node src/diario.ts videos              --fecha D   one "video<TAB>oficial" line per video to transcribe
 *   node src/diario.ts candidatos-busqueda --fecha D   descubrir.busqueda.json: URLs found by the search agents
 *   node src/diario.ts tareas-clasificar   --fecha D   tareas-clasificar.json: one task per new document and party
 *   node src/diario.ts preparar            --fecha D   fusion/<partido>.json + preparar.json: what fusionar may merge
 *   node src/diario.ts ajustar             --fecha D   en_espera promotion, common corte, the day's busquedas.json runs
 *   node src/diario.ts informe             --fecha D   Markdown appendix of the run for resumen.md
 *   node src/diario.ts claude --dir DIR --pasada P --fecha D   DIR: settings.json, agentes.json and prompt.txt of pass P
 *   node src/diario.ts sondear             --fecha D   probes each equal-search domain; marks blocked queries in equidad-tareas.json
 *   node src/diario.ts adjudicacion-completa --fecha D  exit 1, listing why, unless all five adjudications are complete
 *
 * Paths: $N29_SITIO (the run worktree), $N29_CACHE, $N29_BUZON. The run folder
 * is $N29_CACHE/ejecuciones/<fecha>.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PARTY_IDS, idDocumento, raizCache, rutaDeEntorno, urlCanonica, type Meta, type PartyId } from './cache.ts';
import { accesoDesdeRegistro, leerRegistro, terminosDe, type Alias, type Candidato, type Descubrimiento, type Emisor } from './descubrir.ts';
import { clavesDe, VEDA_ENCUESTAS } from './fusionar.ts';
import { PARTY_SHORT } from './resumen.ts';
import { Traedor, bloqueosDelDia, escribirBloqueados, hostDe, hostEn, leerBloqueados } from './traer.ts';

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
  nota?: string;
  notas?: Partial<Record<PartyId, string>>;
}

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

/** A query found blocked by the script's own probe: skipped for all five parties. */
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

/** Why the five tasks of a kind do not reach the same hosts, query by query (empty when they do). */
export function dominiosDistintos(tareas: TareaEquidad[]): string[] {
  const problemas: string[] = [];
  for (const tipo of TIPOS_BUSQUEDA) {
    const deTipo = tareas.filter((t) => t.tipo === tipo);
    if (!deTipo.length) continue;
    const firmas = new Set(deTipo.map((t) => JSON.stringify(t.consultas.map((c) => [c.motor, hostsDeConsulta(c)]))));
    if (firmas.size > 1) problemas.push(`${tipo}: las consultas no llegan a los mismos dominios en los cinco partidos`);
  }
  return problemas;
}

/**
 * Marks every query whose host the probe found blocked (401, 403, 429, 451, an
 * anti-bot page or a geo-block, recorded with the run date), the same in all
 * five tasks. Agents skip it; nothing from that host counts for any party.
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
 * recorded today is not retried. Fails when the five tasks of a kind do not
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
  return { tareas: marcarBloqueadas(tareas, traedor.bloqueados), sondeo };
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

/** Canonical URLs of results, without those on hosts blocked for this kind. */
export function urlsPermitidas(resultados: unknown, bloqueados: string[]): string[] {
  return urlsDeResultados(resultados).filter((url) => !hostEn(hostDe(url), bloqueados));
}

// ---------------------------------------------------------------- videos

/** Video hosts yt-dlp may be pointed at, exact (after dropping www.). */
export const HOSTS_VIDEO = ['rtve.es', 'youtube.com', 'youtu.be'] as const;

/** Whether a URL is an https video page on an allowed host. */
export function esVideo(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'rtve.es') return parsed.pathname.startsWith('/play/videos/');
  if (host === 'youtube.com') return parsed.pathname === '/watch' && /^[\w-]{6,}$/.test(parsed.searchParams.get('v') ?? '');
  if (host === 'youtu.be') return /^\/[\w-]{6,}$/.test(parsed.pathname);
  return false;
}

/**
 * Videos to transcribe: debate and interview candidates that are video pages
 * (RTVE Play, YouTube), and the lines of the inbox list
 * $N29_BUZON/videos/<fecha>.txt ("VIDEO_URL [OFICIAL_URL]", # comments).
 * Only https URLs on HOSTS_VIDEO; the official transcript must be https too.
 */
export function videosDelDia(descubierto: Pick<Descubrimiento, 'candidatos'> | undefined, listaBuzon: string | undefined): { video: string; oficial?: string }[] {
  const salida = new Map<string, { video: string; oficial?: string }>();
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
    salida.set(clave, { video, ...(oficial && /^https:\/\/\S+$/.test(oficial) ? { oficial } : {}) });
  }
  return [...salida.entries()].sort(([a], [b]) => comparar(a, b)).map(([, video]) => video);
}

// ---------------------------------------------------------------- search candidates

export interface SalidaFuente {
  emisor?: unknown;
  candidatos?: { url?: unknown; titulo?: unknown; fecha?: unknown }[];
}

/**
 * The URLs the search agents found, as a Descubrimiento for `traer`: per-source
 * results only on that source's hosts, equal-search results on any host. URLs
 * already listed by `descubrir` are left out (they were fetched in stage 1).
 */
export function candidatosDeBusqueda(entrada: {
  fecha: string;
  descubierto: Descubrimiento;
  porFuente: { archivo: string; salida: SalidaFuente }[];
  porEquidad: { archivo: string; salida: SalidaEquidad }[];
  emisores: Emisor[];
}): Descubrimiento {
  const ya = new Set(entrada.descubierto.candidatos.map((c) => c.url_canonica));
  const hostsDe = new Map(entrada.descubierto.tareas_busqueda.map((tarea) => [tarea.emisor, tarea.hosts]));
  const emisorDeHost = (url: string) => entrada.emisores.find((emisor) => hostEn(hostDe(url), emisor.hosts))?.id ?? 'sin-registrar';
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
    for (const url of urlsDeResultados(salida.resultados)) anotar(url, emisorDeHost(url), `busqueda:${id}`);
  }
  const candidatos = [...nuevos.values()].sort((a, b) => comparar(a.emisor, b.emisor) || comparar(a.url_canonica, b.url_canonica));
  return { fecha: entrada.fecha, desde: entrada.descubierto.desde, candidatos, tareas_busqueda: [], omitidos: [], solo_buzon: [], fallos, bloqueados: {} };
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
 * Parties a text mentions, by the same alias rule for all five: any name,
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

export interface Descarte {
  archivo: string;
  indice: number;
  partido: string;
  motivo: string;
}

export interface Hecho {
  hecho: string;
  seccion: string;
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
 *   of that kind, complete for all five, and only with a URL that search found
 *   for that party; critics and defenders go to en_espera (`ajustar` promotes
 *   them so that the five keep the same count);
 * - no polls from the ban date.
 */
export function preparar(entrada: {
  fecha: string;
  adjudicados: { archivo: string; contenido: unknown }[];
  hechos: unknown;
  /** Canonical URLs each kind's search found per party; a party missing means that search has no output. */
  equidad: Partial<Record<TipoBusqueda, Partial<Record<PartyId, string[]>>>>;
}): { porPartido: Record<PartyId, Objeto[]>; descartes: Descarte[]; deHechos: number } {
  const porPartido = Object.fromEntries(PARTY_IDS.map((id) => [id, [] as Objeto[]])) as Record<PartyId, Objeto[]>;
  const descartes: Descarte[] = [];
  const completa = (tipo: TipoBusqueda) => PARTY_IDS.every((p) => Array.isArray(entrada.equidad[tipo]?.[p]));

  for (const { archivo, contenido } of [...entrada.adjudicados].sort((a, b) => comparar(a.archivo, b.archivo))) {
    const propio = archivo.replace(/\.json$/, '');
    const propuestas = Array.isArray(contenido) ? contenido : esObjeto(contenido) ? lista(contenido.propuestas) : [];
    propuestas.forEach((propuesta, indice) => {
      const descartar = (motivo: string) => descartes.push({ archivo, indice, partido: esObjeto(propuesta) ? String(propuesta.partido) : '', motivo });
      if (!(PARTY_IDS as readonly string[]).includes(propio)) return descartar(`archivo de un partido desconocido "${propio}"`);
      if (!esObjeto(propuesta)) return descartar('propuesta no es un objeto');
      if (propuesta.partido !== propio) return descartar(`propuesta para "${String(propuesta.partido)}" en el archivo de ${propio}: cada adjudicador solo propone para su partido`);
      if (propuesta.destino === 'perfil') return void porPartido[propio as PartyId].push(propuesta);
      const seccion = String(propuesta.seccion);
      const item = esObjeto(propuesta.item) ? propuesta.item : {};
      if (item.hecho !== undefined) return descartar(`hecho "${String(item.hecho)}": los hechos compartidos solo salen de hechos.json`);
      if (seccion === 'encuestas' && entrada.fecha >= VEDA_ENCUESTAS) return descartar(`veda de encuestas desde el ${VEDA_ENCUESTAS}`);
      const tipo = tipoBuscado(seccion, item);
      if (tipo) {
        if (item.busqueda !== idDiario(entrada.fecha, tipo)) return descartar(`${tipo}: busqueda debe ser "${idDiario(entrada.fecha, tipo)}"`);
        if (!completa(tipo)) return descartar(`${tipo}: la búsqueda igual del día no tiene salida para los cinco partidos`);
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
    const seccion = String(hecho.seccion);
    if (seccion === 'criticos-defensores' || hecho.item.bulo === true || hecho.item.busqueda !== undefined) return descartar(`hecho "${hecho.hecho}": críticos, defensores, bulos y causas salen de la búsqueda igual`);
    if (seccion === 'encuestas' && entrada.fecha >= VEDA_ENCUESTAS) return descartar(`veda de encuestas desde el ${VEDA_ENCUESTAS}`);
    const item = { ...hecho.item, hecho: hecho.hecho };
    for (const partido of [...new Set(partidos)].sort((a, b) => PARTY_IDS.indexOf(a) - PARTY_IDS.indexOf(b))) {
      porPartido[partido].push({ partido, seccion, item: structuredClone(item) });
      deHechos++;
    }
  });
  descartes.sort((a, b) => comparar(a.archivo, b.archivo) || a.indice - b.indice);
  return { porPartido, descartes, deHechos };
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
 * (published + held) count among the five; each party gets held items of that
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
  /** Queries blocked for all five, by position. */
  bloqueadas: Partial<Record<TipoBusqueda, (Bloqueada & { indice: number })[]>>;
}

const NOTA_ESTADO: Record<Exclude<EstadoSalida, 'completa'>, string> = {
  'sin-salida': 'La búsqueda no devolvió salida para este partido.',
  incompleta: 'La búsqueda de este partido quedó incompleta: alguna consulta no bloqueada no se completó.',
  'no-ejecutada': 'No se ejecutó: todas las consultas estaban bloqueadas.',
};

/**
 * The day's run entries for busquedas.json: the template's queries, the count
 * per party, the queries blocked for all five (host and HTTP status, the same
 * text for the five), and which parties' searches did not complete.
 */
export function entradasDelDia(entrada: { fecha: string; desde: string; registro: Busqueda[]; equidad: EquidadDia }): Busqueda[] {
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
        `Consultas bloqueadas para los cinco partidos (no se sortean ni se fuerzan): ${bloqueadas
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
      nota: partes.join(' '),
    };
    if (Object.keys(notas).length) run.notas = notas;
    salida.push(run);
  }
  return salida;
}

/** corte moves to the run date in all five when any party file changed (the site requires the same corte). */
export function igualarCorte(fichas: Record<PartyId, Ficha>, antes: Record<PartyId, string>, fecha: string): boolean {
  const cambio = PARTY_IDS.some((p) => JSON.stringify(fichas[p]) !== antes[p]);
  if (!cambio) return false;
  for (const p of PARTY_IDS) if (typeof fichas[p].corte !== 'string' || fichas[p].corte! < fecha) fichas[p].corte = fecha;
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
  preparar?: { descartes?: Descarte[]; deHechos?: number };
  fusionar?: { rechazados?: { archivo: string; indice: number; motivo: string }[]; cambios?: { partido: string; destino: string; añadidos: unknown[]; duplicados: number }[] };
  ajustar?: { promovidos?: Promocion[]; n?: Record<string, number>; corte?: boolean; busquedas?: string[] };
  citasNuevas?: string;
  /** Classification tasks without a valid output, per party. */
  sinClasificar?: Partial<Record<PartyId, string[]>>;
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
  lineas.push(`Corte movido al ${entrada.fecha} en las cinco fichas: ${entrada.ajustar?.corte ? 'sí' : 'no'}.`, '');
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
  return lineas.join('\n').replace(/\n+$/, '\n');
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
  clasificador: { model: 'haiku', tools: ['Read'], description: 'Classifies one cached document for one party (Haiku). Returns JSON only.' },
  'redactor-hechos': { model: 'opus', tools: ['Read', 'Glob', 'Grep', 'WebFetch'], description: 'Writes the shared facts of the day once for every party (Opus). Returns JSON only.' },
  adjudicador: { model: 'opus', tools: ['Read', 'Glob', 'Grep', 'WebFetch'], description: 'Adjudicates the new material for one party (Opus). Returns JSON only.' },
} as const;

/** The two session prompts and the --agents definition, with the day's values. */
export function prompts(markdown: string, valores: Record<string, string>) {
  const agentes = Object.fromEntries(
    Object.entries(SUBAGENTES).map(([nombre, def]) => [nombre, { ...def, tools: [...def.tools], prompt: sustituir(bloque(markdown, `agente:${nombre}`), valores) }]),
  );
  return {
    busqueda: sustituir(bloque(markdown, 'prompt:busqueda'), valores),
    adjudicacion: sustituir(bloque(markdown, 'prompt:adjudicacion'), valores),
    agentes,
  };
}

/** The two Claude passes and what each may write in the run folder: only its own subagents' answers. */
export const ESCRITURA_POR_PASADA = {
  busqueda: ['busqueda/**', 'equidad/**'],
  adjudicacion: ['clasificacion/**', 'adjudicado/**', 'hechos.json*'],
} as const;
export type Pasada = keyof typeof ESCRITURA_POR_PASADA;
export const esPasada = (valor: unknown): valor is Pasada => typeof valor === 'string' && Object.hasOwn(ESCRITURA_POR_PASADA, valor);

/**
 * The settings of one pass from claude-settings.diario.template.json: every
 * __NAME__ replaced (JSON-escaped). The template may allow no write and no
 * Bash; this adds Write and Edit for the pass's own answers in the run folder
 * only, and denies the other pass's. Paths with glob, parenthesis or control
 * characters are refused, so a path cannot widen a rule.
 */
export function ajustesClaude(plantilla: string, valores: Record<string, string>, pasada: Pasada): string {
  for (const [nombre, valor] of Object.entries(valores)) {
    if (!valor.startsWith('/') || /[*?()[\]{}\x00-\x1f]/.test(valor)) throw new Error(`ajustes: ruta no admitida en ${nombre}: ${valor}`);
  }
  if (!esPasada(pasada)) throw new Error(`ajustes: pasada desconocida ${String(pasada)}`);
  const texto = plantilla.replace(/__([A-Z0-9_]+)__/g, (marcador, nombre: string) => {
    const valor = valores[nombre];
    if (valor === undefined) throw new Error(`ajustes: marcador desconocido ${marcador}`);
    return JSON.stringify(valor).slice(1, -1);
  });
  const ajustes = JSON.parse(texto) as { permissions: { allow: unknown[]; deny: unknown[] } };
  const ej = valores.EJ;
  if (!ej) throw new Error('ajustes: falta EJ');
  for (const regla of ajustes.permissions.allow) {
    if (typeof regla !== 'string') throw new Error('ajustes: regla no es texto');
    if (/^(Bash|NotebookEdit|Write|Edit|MultiEdit)\b/.test(regla)) throw new Error(`ajustes: la plantilla no puede permitir escritura ni ejecución: ${regla}`);
  }
  const reglas = (rutas: readonly string[]) => rutas.flatMap((ruta) => ['Write', 'Edit'].map((tool) => `${tool}(/${ej}/${ruta})`));
  const otra = (Object.keys(ESCRITURA_POR_PASADA) as Pasada[]).filter((p) => p !== pasada).flatMap((p) => ESCRITURA_POR_PASADA[p]);
  ajustes.permissions.allow.push(...reglas(ESCRITURA_POR_PASADA[pasada]));
  ajustes.permissions.deny.push(...reglas(otra));
  return `${JSON.stringify(ajustes, null, 2)}\n`;
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
    const resultados = lista(contenido.resultados).filter((r) => !(esObjeto(r) && typeof r.url === 'string' && urlsPermitidas([r], bloqueados).length === 0));
    const salida: SalidaEquidad = { ...contenido, busqueda: idDiario(fecha, tipo), tipo, partido, resultados: resultados as SalidaEquidad['resultados'] };
    salidas.push({ archivo, salida });
    if (esTexto(contenido.nota)) (dia.notas[tipo] ??= {})[partido] = contenido.nota;
    if (estado === 'completa') (dia.urls[tipo] ??= {})[partido] = urlsPermitidas(resultados, bloqueados);
  }
  return { ...dia, salidas };
}

const rutaDeEntornoHome = () => {
  const home = process.env.HOME;
  if (!home) throw new Error('Falta HOME');
  return home;
};

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
      const traedor = new Traedor({ fecha, bloqueados: bloqueosDelDia(todos, fecha), ...accesoDesdeRegistro(emisores) });
      const { tareas, sondeo } = await sondear((leerJson(join(ejecucion, 'equidad-tareas.json')) ?? []) as TareaEquidad[], traedor);
      await escribirBloqueados(ruta, { ...todos, ...traedor.bloqueados });
      escribirJson(join(ejecucion, 'equidad-tareas.json'), tareas);
      escribirJson(join(ejecucion, 'sondeo.json'), sondeo);
      for (const s of sondeo) process.stdout.write(`${s.estado}\t${s.estado_http ?? ''}\t${s.url}\n`);
      return 0;
    }
    case 'videos': {
      const ruta = join(rutaDeEntorno('N29_BUZON'), 'videos', `${fecha}.txt`);
      for (const v of videosDelDia(descubierto(), existsSync(ruta) ? readFileSync(ruta, 'utf8') : undefined)) process.stdout.write(`${v.video}\t${v.oficial ?? ''}\n`);
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
      escribirJson(join(ejecucion, 'tareas-clasificar.json'), tareasClasificar({ fecha, raizCache: cache, documentos, alias, porEquidad: leerEquidad(ejecucion, fecha).salidas }));
      return 0;
    }
    case 'preparar': {
      const { porPartido, descartes, deHechos } = preparar({
        fecha,
        adjudicados: jsonDeCarpeta(join(ejecucion, 'adjudicado')),
        hechos: leerJsonSiExiste(join(ejecucion, 'hechos.json')),
        equidad: leerEquidad(ejecucion, fecha).urls,
      });
      for (const p of PARTY_IDS) escribirJson(join(ejecucion, 'fusion', `${p}.json`), { propuestas: porPartido[p] });
      escribirJson(join(ejecucion, 'preparar.json'), { fecha, descartes, deHechos });
      return 0;
    }
    case 'ajustar': {
      const actuales = fichas();
      const antes = Object.fromEntries(PARTY_IDS.map((p) => [p, JSON.stringify(leerJson(join(ejecucion, 'antes', 'partidos', `${p}.json`)))])) as Record<PartyId, string>;
      const sinCambios = Object.fromEntries(PARTY_IDS.map((p) => [p, JSON.stringify(actuales[p])]));
      const { promovidos, n } = promover(actuales);
      const corte = igualarCorte(actuales, antes, fecha);
      for (const p of PARTY_IDS) if (JSON.stringify(actuales[p]) !== sinCambios[p]) escribirJson(join(datos, 'partidos', `${p}.json`), actuales[p]);
      const reg = leerJson(join(datos, 'busquedas.json')) as { busquedas: Busqueda[] };
      const equidad = leerEquidad(ejecucion, fecha);
      const nuevas = entradasDelDia({ fecha, desde: descubierto()?.desde ?? fecha, registro: reg.busquedas, equidad });
      if (nuevas.length) escribirJson(join(datos, 'busquedas.json'), { ...reg, busquedas: [...reg.busquedas, ...nuevas] });
      escribirJson(join(ejecucion, 'ajustar.json'), { fecha, n, promovidos, corte, busquedas: nuevas.map((b) => b.id) });
      return 0;
    }
    case 'claude': {
      // Everything one Claude pass reads as configuration, built fresh into a folder outside every writable one.
      const d = args.indexOf('--dir');
      const dir = d === -1 ? undefined : args[d + 1];
      const q = args.indexOf('--pasada');
      const pasada = q === -1 ? undefined : args[q + 1];
      if (!dir || !esPasada(pasada)) throw new Error('Faltan --dir y --pasada busqueda|adjudicacion');
      const recogida = join(import.meta.dirname, '..');
      const t = join(recogida, '..');
      const md = readFileSync(join(t, 'agentes', '08-diario.md'), 'utf8');
      const salida = prompts(md, { FECHA: fecha, EJECUCION: ejecucion, CACHE: cache, DATOS: join(ejecucion, 'antes'), CRITERIOS: join(t, 'criterios'), ENCUESTAS: reglaEncuestas(fecha) });
      const plantilla = readFileSync(join(recogida, 'claude-settings.diario.template.json'), 'utf8');
      writeFileSync(join(dir, 'settings.json'), ajustesClaude(plantilla, { EJ: ejecucion, N29_CACHE: cache, T: t, HOME: rutaDeEntornoHome(), CONF: dir }, pasada));
      writeFileSync(join(dir, 'prompt.txt'), salida[pasada]);
      writeFileSync(join(dir, 'agentes.json'), `${JSON.stringify(salida.agentes, null, 2)}\n`);
      return 0;
    }
    case 'adjudicacion-completa': {
      const archivos = Object.fromEntries(PARTY_IDS.map((p) => [p, (() => {
        try {
          return leerJsonSiExiste(join(ejecucion, 'adjudicado', `${p}.json`));
        } catch {
          return undefined;
        }
      })()]));
      const problemas = problemasAdjudicacion(archivos, clasificadas(ejecucion).hechas);
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
          sinClasificar: clasificadas(ejecucion).faltan,
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
