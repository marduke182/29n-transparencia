/**
 * Discovery: lists candidate URLs for the day from the source registry
 * ($N29_SITIO/apps/29n/src/data/fuentes.json) and the fixed debate and
 * interview listings.
 *
 * - rss / sitemap / api / seccion are read directly (through Traedor).
 * - busqueda (the default when `recogida` is absent) becomes a task for the
 *   LLM search stage, with every alias of every party.
 * - omitir is skipped; inbox-only hosts (from `acceso` in fuentes.json) are
 *   listed apart, never fetched. Hosts whose pages block but whose feed works
 *   keep the feed text on each candidate (`contenido_feed`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { PARTY_IDS, urlCanonica } from './cache.ts';
import { decodificarEntidades } from './buzon.ts';
import { decodificarCuerpo, hostDe, hostEn, type Bloqueo, type Traedor } from './traer.ts';

export type Metodo = 'rss' | 'sitemap' | 'api' | 'seccion' | 'busqueda' | 'omitir';

export interface Emisor {
  id: string;
  nombre: string;
  hosts: string[];
  tipo: string;
  partido?: string;
  acceso?: { estado: 'abierto' | 'parcial' | 'bloqueado'; comprobado: string; detalle: string };
  recogida?: { metodo: Metodo; url?: string; nota?: string };
  /** It blocks the guide (the site's `Bloqueo`): its robots.txt excludes Claude's agents, or it answered with an anti-bot block. Never fetched, by this pipeline or by Claude. */
  bloqueo?: { tipo: 'robots' | 'antibots'; evidencia: string; consultado: string; robots?: string; agentes?: string[] };
}

/** Methods that read a listing directly. */
const METODOS_DIRECTOS: readonly Metodo[] = ['rss', 'sitemap', 'api', 'seccion'];

export interface AccesoHosts {
  /** Never fetched: inbox only. */
  soloBuzon: string[];
  /** Pages block, but the listed method works: only these URLs are fetched. */
  soloListado: Record<string, string[]>;
  /** Hosts of emisores with recogida `omitir` or a `bloqueo`: never fetched, whatever points at them (a search result, a link of the inbox list). */
  noTraer: string[];
}

/**
 * Access per host from fuentes.json. A host with `acceso` parcial or bloqueado
 * is `soloListado` when its `recogida` gives a direct method with a URL (its
 * pages are never requested; the listing is read politely, and a block on it
 * still stops the host), and `soloBuzon` otherwise.
 */
export function accesoDesdeRegistro(emisores: Emisor[]): AccesoHosts {
  const acceso: AccesoHosts = { soloBuzon: [], soloListado: {}, noTraer: [] };
  for (const emisor of emisores) {
    if (emisor.recogida?.metodo === 'omitir' || emisor.bloqueo) acceso.noTraer.push(...emisor.hosts);
    if (emisor.acceso?.estado !== 'parcial' && emisor.acceso?.estado !== 'bloqueado') continue;
    const metodo = emisor.recogida?.metodo;
    const url = emisor.recogida?.url;
    for (const host of emisor.hosts) {
      if (metodo && METODOS_DIRECTOS.includes(metodo) && url) acceso.soloListado[host] = [url];
      else acceso.soloBuzon.push(host);
    }
  }
  acceso.soloBuzon.sort();
  acceso.noTraer = [...new Set(acceso.noTraer)].sort();
  return acceso;
}

export interface Alias {
  nombres: string[];
  marcas_regionales: string[];
  miembros: string[];
  personas: string[];
  excluir: string[];
}

export type Genero = 'articulo' | 'documento' | 'debate' | 'entrevista' | 'transcripcion';

export interface Candidato {
  url: string;
  url_canonica: string;
  emisor: string;
  metodo: Exclude<Metodo, 'busqueda' | 'omitir'>;
  genero: Genero;
  titulo?: string;
  /** ISO date from the listing (pubDate, lastmod…), when it has one. */
  fecha?: string;
  listado: string;
  /** Feed text (content:encoded or description) for hosts whose pages block: stored instead of fetching the page. */
  contenido_feed?: string;
}

export interface TareaBusqueda {
  emisor: string;
  nombre: string;
  hosts: string[];
  /** Per party, the names to search for, and the ones to exclude. */
  consultas: { partido: string; terminos: string[]; excluir: string[] }[];
  /** The WebSearch queries the agent runs verbatim, built by consultasFuente. */
  busquedas: ConsultaFuente[];
  desde: string;
  hasta: string;
  nota?: string;
  /** Answer path in the run folder, when not busqueda/<emisor>.json: an atrasos task writes busqueda/<emisor>.atrasos.json. */
  salida?: string;
}

/** Answer path of a source search task, relative to the run folder. */
export const salidaTarea = (tarea: Pick<TareaBusqueda, 'emisor' | 'salida'>) => tarea.salida ?? `busqueda/${tarea.emisor}.json`;

/**
 * Atrasos (backfill): named sources searched once more, in the same run, for
 * an earlier window. Not the same as recovering a missed day (`--fecha` of
 * that day): only these sources, only the search, one query per party.
 */
export interface Atrasos {
  desde: string;
  hasta: string;
  emisores: string[];
}

const esFechaIso = (valor: string) => /^\d{4}-\d{2}-\d{2}$/.test(valor) && new Date(`${valor}T00:00:00Z`).toISOString().slice(0, 10) === valor;

/**
 * Checks an atrasos request against the registry and the run date: known ids,
 * none repeated, none with recogida omitir or inbox only, real ISO dates,
 * desde <= hasta <= fecha. Throws with the reason.
 */
export function comprobarAtrasos(atrasos: Atrasos, emisores: Emisor[], acceso: AccesoHosts, fecha: string): void {
  if (!esFechaIso(atrasos.desde) || !esFechaIso(atrasos.hasta)) throw new Error(`atrasos: las fechas deben ser AAAA-MM-DD reales (${atrasos.desde}, ${atrasos.hasta})`);
  if (atrasos.desde > atrasos.hasta) throw new Error(`atrasos: desde (${atrasos.desde}) es posterior a hasta (${atrasos.hasta})`);
  if (atrasos.hasta > fecha) throw new Error(`atrasos: hasta (${atrasos.hasta}) es posterior a la fecha de la ejecución (${fecha})`);
  if (!atrasos.emisores.length) throw new Error('atrasos: falta al menos un emisor');
  const vistos = new Set<string>();
  for (const id of atrasos.emisores) {
    if (vistos.has(id)) throw new Error(`atrasos: ${id} está repetido`);
    vistos.add(id);
    const emisor = emisores.find((e) => e.id === id);
    if (!emisor) throw new Error(`atrasos: ${id} no es un emisor de fuentes.json`);
    if (emisor.recogida?.metodo === 'omitir') throw new Error(`atrasos: ${id} tiene recogida omitir`);
    if (emisor.bloqueo) throw new Error(`atrasos: ${id} tiene bloqueo (su robots.txt no admite agentes de Claude)`);
    if (emisor.hosts.every((host) => hostEn(host, acceso.soloBuzon))) throw new Error(`atrasos: ${id} es solo buzón`);
  }
}

/** The fixed note of an atrasos task. */
export const notaAtrasos = (atrasos: Pick<Atrasos, 'desde' | 'hasta'>) => `Atrasos: devuelve solo lo publicado del ${atrasos.desde} al ${atrasos.hasta}.`;

/** The one source query of a party: its terms joined with OR, the terms left out for length, and the two halves to run if it saturates. */
export interface ConsultaFuente {
  partido: string;
  texto: string;
  terminos: string[];
  /** Terms that did not fit under LONGITUD_MAXIMA_CONSULTA: left out of the web search only; the alias rule still uses them on every fetched page. */
  terminos_omitidos: string[];
  mitades?: [string, string];
}

/** Longest query string. */
export const LONGITUD_MAXIMA_CONSULTA = 300;

/**
 * The text of one query: `site:host ("t1" OR "t2" …)`, or
 * `(site:a OR site:b) (…)` for a source with several hosts. Double quotes in
 * a term are dropped, so a term cannot break the phrase.
 */
export function textoConsulta(hosts: string[], terminos: string[]): string {
  const sitio = hosts.length === 1 ? `site:${hosts[0]}` : `(${hosts.map((h) => `site:${h}`).join(' OR ')})`;
  return `${sitio} (${terminos.map((t) => `"${t.replace(/"/g, '').trim()}"`).join(' OR ')})`;
}

/**
 * The terms of one party's single query: in list order, each added while the
 * query stays within the limit; the first term always goes in, even if too
 * long alone. The rest are left out of the web search.
 */
export function terminosQueCaben(hosts: string[], terminos: string[], maximo = LONGITUD_MAXIMA_CONSULTA): { terminos: string[]; omitidos: string[] } {
  const dentro: string[] = [];
  const omitidos: string[] = [];
  for (const termino of terminos) {
    if (dentro.length && (omitidos.length || textoConsulta(hosts, [...dentro, termino]).length > maximo)) omitidos.push(termino);
    else dentro.push(termino);
  }
  return { terminos: dentro, omitidos };
}

/** The two halves of a query's terms: the first ceil(n/2) terms and the rest. None for a single term. */
export function mitadesDe(terminos: string[]): [string[], string[]] | undefined {
  if (terminos.length < 2) return undefined;
  const corte = Math.ceil(terminos.length / 2);
  return [terminos.slice(0, corte), terminos.slice(corte)];
}

/**
 * The queries of one source: exactly one per party, in party order, by the
 * same rule for all four (terminosQueCaben). `excluir` is not in the query:
 * it is applied to the text of each fetched page (partidosEn), as for every
 * other document, and so are the omitted terms.
 */
export function consultasFuente(hosts: string[], consultas: { partido: string; terminos: string[] }[]): ConsultaFuente[] {
  return consultas.map(({ partido, terminos }) => {
    const elegidos = terminosQueCaben(hosts, terminos.filter((t) => t.replace(/"/g, '').trim()));
    const mitades = mitadesDe(elegidos.terminos);
    return {
      partido,
      texto: textoConsulta(hosts, elegidos.terminos),
      terminos: elegidos.terminos,
      terminos_omitidos: elegidos.omitidos,
      ...(mitades ? { mitades: [textoConsulta(hosts, mitades[0]), textoConsulta(hosts, mitades[1])] as [string, string] } : {}),
    };
  });
}

export interface Descubrimiento {
  fecha: string;
  desde: string;
  /** Only when the run was asked for atrasos. */
  atrasos?: Atrasos;
  candidatos: Candidato[];
  tareas_busqueda: TareaBusqueda[];
  omitidos: { emisor: string; nota?: string }[];
  solo_buzon: { emisor: string; hosts: string[] }[];
  fallos: { emisor: string; listado: string; motivo: string }[];
  bloqueados: Record<string, Bloqueo>;
}

/** Fixed listings of debates, interviews and official transcripts, read every day. */
export interface Listado {
  id: string;
  emisor: string;
  metodo: 'rss' | 'seccion';
  url: string;
  genero: Genero;
  /** For seccion: only links whose path matches are candidates. */
  enlaces?: RegExp;
}

export const LISTADOS_DEBATES: Listado[] = [
  // Checked on 2026-11-10 with one polite request each (200): the index lists
  // /presidente/intervenciones/Paginas/<year>/<date>-<slug>.aspx.
  {
    id: 'moncloa-intervenciones',
    emisor: 'la-moncloa-gobierno',
    metodo: 'seccion',
    url: 'https://www.lamoncloa.gob.es/presidente/intervenciones/Paginas/index.aspx',
    genero: 'transcripcion',
    enlaces: /^\/presidente\/intervenciones\/Paginas\/\d{4}\/[^/]+\.aspx$/i,
  },
  // Checked on 2026-11-10 (200): /consejodeministros/ruedas/Paginas/<year>/<date>-transcripcion-….aspx.
  {
    id: 'moncloa-ruedas-de-prensa',
    emisor: 'la-moncloa-gobierno',
    metodo: 'seccion',
    url: 'https://www.lamoncloa.gob.es/consejodeministros/ruedas/Paginas/index.aspx',
    genero: 'transcripcion',
    enlaces: /^\/consejodeministros\/ruedas\/Paginas\/\d{4}\/[^/]+\.aspx$/i,
  },
  // Checked on 2026-11-10 (200): the elections page links news and RTVE Play videos
  // (/noticias/<yyyymmdd>/<slug>/<id>.shtml, /play/videos/<programme>/<slug>/<id>/).
  // It also carries the interviews, so the 404 "la-entrevista-de-la-1" listing was dropped.
  {
    id: 'rtve-debates-y-entrevistas',
    emisor: 'rtve',
    metodo: 'seccion',
    url: 'https://www.rtve.es/noticias/elecciones/generales/',
    genero: 'debate',
    enlaces: /^\/(noticias\/\d{8}\/[^/]*(debate|entrevista|cara-a-cara)[^/]*\/\d+\.shtml|play\/videos\/[^/]+\/[^/]*(debate|entrevista|cara-a-cara)[^/]*\/\d+\/?)$/i,
  },
  // TODO(congreso): no static listing of the Diario de Sesiones found. On 2026-11-10
  // /es/publicaciones-oficiales/diario-sesiones answered 404, and
  // /es/ultimas-publicaciones-oficiales (200) renders its list with JavaScript (no
  // /public_oficiales/…/DS/… links in the HTML). The PDFs look like
  // /public_oficiales/L15/CONG/DS/PL/DSCD-15-PL-<n>.PDF; robots.txt disallows only some
  // BOCG PDFs. Until a static listing or feed is found, pass Congreso PDFs to
  // `transcribir --oficial`.
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', processEntities: true, htmlEntities: true, isArray: (nombre) => ['item', 'entry', 'url', 'sitemap', 'link'].includes(nombre) });

const comoLista = <T>(valor: T | T[] | undefined): T[] => (valor === undefined ? [] : Array.isArray(valor) ? valor : [valor]);
const texto = (valor: unknown): string | undefined => {
  if (typeof valor === 'string') return valor.trim();
  if (typeof valor === 'number') return String(valor);
  if (valor && typeof valor === 'object' && '#text' in valor) return texto((valor as Record<string, unknown>)['#text']);
  return undefined;
};

/** ISO date (YYYY-MM-DD, UTC) of an RFC 822 / ISO 8601 date, or undefined. */
export function fechaIso(valor: string | undefined): string | undefined {
  if (!valor) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(valor)) return valor.slice(0, 10);
  const ms = Date.parse(valor);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().slice(0, 10);
}

const enVentana = (fecha: string | undefined, desde: string, hasta: string) => fecha === undefined || (fecha >= desde && fecha <= hasta);

/** Items of an RSS 2.0 or Atom feed: url, title and date. */
export function leerFeed(xml: string): { url: string; titulo?: string; fecha?: string; contenido?: string }[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const rss = comoLista(doc.rss?.channel?.item ?? doc['rdf:RDF']?.item).map((item: any) => ({
    url: texto(comoLista(item.link)[0]) ?? texto(item.guid) ?? '',
    titulo: texto(item.title),
    fecha: fechaIso(texto(item.pubDate) ?? texto(item['dc:date'])),
    contenido: texto(item['content:encoded']) ?? texto(item.description),
  }));
  const atom = comoLista(doc.feed?.entry).map((entry: any) => {
    const enlaces = comoLista(entry.link) as any[];
    const enlace = enlaces.find((l) => !l['@rel'] || l['@rel'] === 'alternate') ?? enlaces[0];
    return { url: enlace?.['@href'] ?? '', titulo: texto(entry.title), fecha: fechaIso(texto(entry.published) ?? texto(entry.updated)), contenido: texto(entry.content) ?? texto(entry.summary) };
  });
  return [...rss, ...atom]
    .filter((item) => /^https?:\/\//.test(item.url))
    .map((item) => Object.fromEntries(Object.entries(item).filter(([, valor]) => valor !== undefined)) as typeof item);
}

/** A sitemap: either an index (child sitemaps) or a urlset (pages), with lastmod. */
export function leerSitemap(xml: string): { indice: { url: string; fecha?: string }[]; urls: { url: string; fecha?: string }[] } {
  const doc = parser.parse(xml) as Record<string, any>;
  const indice = comoLista(doc.sitemapindex?.sitemap).map((s: any) => ({ url: texto(s.loc) ?? '', fecha: fechaIso(texto(s.lastmod)) }));
  const urls = comoLista(doc.urlset?.url).map((u: any) => ({
    url: texto(u.loc) ?? '',
    fecha: fechaIso(texto(u.lastmod) ?? texto(u['news:news']?.['news:publication_date'])),
  }));
  return { indice: indice.filter((s) => s.url), urls: urls.filter((u) => u.url) };
}

/** Same-host article links of a section page (deduplicated, in page order). */
export function leerSeccion(html: string, base: string, enlaces?: RegExp): string[] {
  const hostBase = hostDe(base);
  const vistos = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const href = decodificarEntidades((match[1] ?? match[2] ?? '').trim());
    if (!href || href.startsWith('#') || /^(mailto|javascript|tel):/i.test(href)) continue;
    let absoluta: URL;
    try {
      absoluta = new URL(href, base);
    } catch {
      continue;
    }
    if (hostDe(absoluta.toString()) !== hostBase) continue;
    absoluta.hash = '';
    const segmentos = absoluta.pathname.split('/').filter(Boolean);
    if (!segmentos.length) continue;
    if (enlaces ? !enlaces.test(absoluta.pathname) : segmentos.length < 2) continue;
    vistos.add(absoluta.toString());
  }
  return [...vistos];
}

/** Every URL with a title or url field in a BOE-style JSON summary. */
export function leerApiBoe(json: unknown, filtro: RegExp): { url: string; titulo?: string }[] {
  const salida: { url: string; titulo?: string }[] = [];
  const visitar = (nodo: unknown) => {
    if (Array.isArray(nodo)) return nodo.forEach(visitar);
    if (!nodo || typeof nodo !== 'object') return;
    const objeto = nodo as Record<string, unknown>;
    const titulo = typeof objeto.titulo === 'string' ? objeto.titulo : undefined;
    const url = texto(objeto.url_html) ?? texto(objeto.url_pdf);
    if (titulo && url && filtro.test(titulo)) salida.push({ url, titulo });
    Object.values(objeto).forEach(visitar);
  };
  visitar(json);
  return salida;
}

/** BOE items kept: the electoral administration and the election itself. */
const FILTRO_BOE = /junta electoral|elecci[oó]n|electoral|candidatur|escrutinio/i;
const MAX_SUBSITEMAPS = 5;


/** Search terms of one party: names, regional brands, members and people. */
export const terminosDe = (alias: Alias) => [...alias.nombres, ...alias.marcas_regionales, ...alias.miembros, ...alias.personas];

/** The ISO date `dias` days before `fecha` (calendar arithmetic, no clock). */
export function restarDias(fecha: string, dias: number): string {
  const [anio, mes, dia] = fecha.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(anio, mes - 1, dia - dias)).toISOString().slice(0, 10);
}

export async function leerRegistro(sitio: string): Promise<{ emisores: Emisor[]; alias: Record<string, Alias> }> {
  const datos = join(sitio, 'apps', '29n', 'src', 'data');
  const fuentes = JSON.parse(await readFile(join(datos, 'fuentes.json'), 'utf8')) as { emisores: Emisor[] };
  const alias = JSON.parse(await readFile(join(datos, 'partidos-alias.json'), 'utf8')) as Record<string, Alias>;
  return { emisores: fuentes.emisores, alias };
}

/**
 * The main candidate of each party, from tarjeta.candidato in the site's
 * partidos/<id>.json. A party without one is an error: its search query must
 * start with its candidate, like the others'.
 */
export async function leerCandidatos(sitio: string, partidos: readonly string[] = PARTY_IDS): Promise<Record<string, string>> {
  const datos = join(sitio, 'apps', '29n', 'src', 'data', 'partidos');
  const candidatos: Record<string, string> = {};
  for (const partido of partidos) {
    const ficha = JSON.parse(await readFile(join(datos, `${partido}.json`), 'utf8')) as { tarjeta?: { candidato?: unknown } };
    const candidato = ficha.tarjeta?.candidato;
    if (typeof candidato !== 'string' || !candidato.trim()) throw new Error(`partidos/${partido}.json: falta tarjeta.candidato (el candidato principal va primero en la consulta de búsqueda de cada partido)`);
    candidatos[partido] = candidato.trim();
  }
  return candidatos;
}

/**
 * A party's search terms with its main candidate first and the rest in list
 * order (the candidate is not repeated). The same rule for the four parties.
 * The candidate goes first even when it is not one of the alias terms; the
 * alias rule for classification stays as it is.
 */
export function candidatoPrimero(candidato: string | undefined, terminos: string[], partido: string): string[] {
  if (!candidato?.trim()) throw new Error(`descubrir: falta el candidato principal de ${partido} (tarjeta.candidato en partidos/${partido}.json)`);
  const clave = (t: string) => t.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase();
  return [candidato.trim(), ...terminos.filter((t) => clave(t) !== clave(candidato))];
}

/** Reads one listing and turns it into candidates within the date window. */
async function leerListado(
  traedor: Traedor,
  listado: { emisor: string; metodo: Candidato['metodo']; url: string; genero: Genero; enlaces?: RegExp },
  ventana: { desde: string; hasta: string },
  salida: Descubrimiento,
  acceso?: AccesoHosts,
): Promise<void> {
  const soloListado = Boolean(acceso && Object.keys(acceso.soloListado).some((host) => hostEn(hostDe(listado.url), [host])));
  const anotar = (url: string, extra: { titulo?: string; fecha?: string; contenido?: string } = {}) => {
    let canonica: string;
    try {
      canonica = urlCanonica(url);
    } catch {
      return;
    }
    if (!enVentana(extra.fecha, ventana.desde, ventana.hasta)) return;
    const candidato: Candidato = { url, url_canonica: canonica, emisor: listado.emisor, metodo: listado.metodo, genero: listado.genero, listado: listado.url };
    if (extra.titulo) candidato.titulo = extra.titulo;
    if (extra.fecha) candidato.fecha = extra.fecha;
    if (soloListado && extra.contenido) candidato.contenido_feed = extra.contenido;
    salida.candidatos.push(candidato);
  };
  const fallo = (motivo: string): void => {
    salida.fallos.push({ emisor: listado.emisor, listado: listado.url, motivo });
  };

  let url = listado.url;
  if (listado.metodo === 'api') url = `${url.replace(/\/?$/, '/')}${ventana.hasta.replaceAll('-', '')}`;
  const respuesta = await traedor.traer(url, listado.metodo === 'api' ? 'application/json' : 'application/rss+xml,application/xml,text/xml,text/html;q=0.8');
  if (respuesta.estado === 'bloqueado') return fallo(`bloqueado: ${respuesta.bloqueo.motivo}`);
  if (respuesta.estado !== 'ok') return fallo(respuesta.motivo);
  const cuerpo = decodificarCuerpo(respuesta.tipo, respuesta.cuerpo);

  try {
    if (listado.metodo === 'rss') for (const item of leerFeed(cuerpo)) anotar(item.url, item);
    else if (listado.metodo === 'seccion') for (const enlace of leerSeccion(cuerpo, respuesta.url_final, listado.enlaces)) anotar(enlace);
    else if (listado.metodo === 'api') for (const item of leerApiBoe(JSON.parse(cuerpo), FILTRO_BOE)) anotar(item.url, { titulo: item.titulo, fecha: ventana.hasta });
    else {
      const sitemap = leerSitemap(cuerpo);
      for (const item of sitemap.urls) anotar(item.url, item);
      const hijos = sitemap.indice
        .filter((hijo) => hijo.fecha === undefined || hijo.fecha >= ventana.desde)
        .sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? '') || a.url.localeCompare(b.url))
        .slice(0, MAX_SUBSITEMAPS);
      for (const hijo of hijos) {
        const sub = await traedor.traer(hijo.url, 'application/xml,text/xml');
        if (sub.estado !== 'ok') {
          fallo(sub.estado === 'bloqueado' ? `bloqueado: ${sub.bloqueo.motivo}` : sub.motivo);
          if (sub.estado === 'bloqueado') break;
          continue;
        }
        for (const item of leerSitemap(decodificarCuerpo(sub.tipo, sub.cuerpo)).urls) anotar(item.url, item);
      }
    }
  } catch (error) {
    fallo(`no se pudo leer el listado: ${(error as Error).message}`);
  }
}

/**
 * Builds the day's discovery. `fecha` is the run date; `dias` the window
 * (default 2 days back, inclusive). Output is sorted for stable diffs.
 */
export async function descubrir(
  registro: { emisores: Emisor[]; alias: Record<string, Alias>; candidatos: Record<string, string> },
  traedor: Traedor,
  opciones: { fecha: string; dias?: number; listados?: Listado[]; atrasos?: Atrasos },
): Promise<Descubrimiento> {
  const desde = restarDias(opciones.fecha, opciones.dias ?? 2);
  const ventana = { desde, hasta: opciones.fecha };
  const acceso = accesoDesdeRegistro(registro.emisores);
  const { atrasos } = opciones;
  if (atrasos) comprobarAtrasos(atrasos, registro.emisores, acceso, opciones.fecha);
  const salida: Descubrimiento = { fecha: opciones.fecha, desde, ...(atrasos ? { atrasos } : {}), candidatos: [], tareas_busqueda: [], omitidos: [], solo_buzon: [], fallos: [], bloqueados: {} };
  for (const partido of PARTY_IDS) {
    if (!registro.alias[partido]) throw new Error(`descubrir: falta la entrada de ${partido} en partidos-alias.json (cada partido necesita sus términos de búsqueda)`);
  }
  const consultas = PARTY_IDS.map((partido) => ({
    partido,
    terminos: candidatoPrimero(registro.candidatos[partido], terminosDe(registro.alias[partido]!), partido),
    excluir: registro.alias[partido]!.excluir,
  }));

  for (const emisor of registro.emisores) {
    const metodo = emisor.recogida?.metodo ?? 'busqueda';
    if (emisor.hosts.every((host) => hostEn(host, acceso.soloBuzon))) {
      salida.solo_buzon.push({ emisor: emisor.id, hosts: emisor.hosts });
      continue;
    }
    if (metodo === 'omitir') {
      salida.omitidos.push({ emisor: emisor.id, ...(emisor.recogida?.nota ? { nota: emisor.recogida.nota } : {}) });
      continue;
    }
    if (metodo === 'busqueda' || !emisor.recogida?.url) {
      const tarea: TareaBusqueda = { emisor: emisor.id, nombre: emisor.nombre, hosts: emisor.hosts, consultas, busquedas: consultasFuente(emisor.hosts, consultas), desde, hasta: opciones.fecha };
      if (emisor.recogida?.nota) tarea.nota = emisor.recogida.nota;
      salida.tareas_busqueda.push(tarea);
      continue;
    }
    const genero: Genero = emisor.tipo === 'partido' || emisor.tipo === 'oficial' ? 'documento' : 'articulo';
    await leerListado(traedor, { emisor: emisor.id, metodo, url: emisor.recogida.url, genero }, ventana, salida, acceso);
  }
  for (const listado of opciones.listados ?? LISTADOS_DEBATES) {
    await leerListado(traedor, { ...listado }, ventana, salida, acceso);
  }
  // Atrasos: one more search task per named source, built like any other, with its own window and answer file.
  for (const emisor of registro.emisores) {
    if (!atrasos?.emisores.includes(emisor.id)) continue;
    salida.tareas_busqueda.push({
      emisor: emisor.id,
      nombre: emisor.nombre,
      hosts: emisor.hosts,
      consultas,
      busquedas: consultasFuente(emisor.hosts, consultas),
      desde: atrasos.desde,
      hasta: atrasos.hasta,
      nota: notaAtrasos(atrasos),
      salida: `busqueda/${emisor.id}.atrasos.json`,
    });
  }

  // One candidate per canonical URL (the first listing wins), then a fixed order.
  const unicos = new Map<string, Candidato>();
  for (const candidato of salida.candidatos) if (!unicos.has(candidato.url_canonica)) unicos.set(candidato.url_canonica, candidato);
  salida.candidatos = [...unicos.values()].sort((a, b) => a.emisor.localeCompare(b.emisor) || a.url_canonica.localeCompare(b.url_canonica));
  salida.tareas_busqueda.sort((a, b) => a.emisor.localeCompare(b.emisor) || Number(Boolean(a.salida)) - Number(Boolean(b.salida)));
  salida.omitidos.sort((a, b) => a.emisor.localeCompare(b.emisor));
  salida.solo_buzon.sort((a, b) => a.emisor.localeCompare(b.emisor));
  salida.bloqueados = Object.fromEntries(Object.entries(traedor.bloqueados).sort(([a], [b]) => a.localeCompare(b)));
  return salida;
}
