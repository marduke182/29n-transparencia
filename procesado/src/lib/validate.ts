/**
 * Publication rules for the party files (see /metodologia/). `validatePartido`
 * returns one readable message per broken rule; an empty list means the file
 * can be published. partidos.test.ts runs it, and the build fails on any issue
 * ([partido].astro's getStaticPaths).
 */
import { EMISORES, type Emisor } from '../data/fuentes';
import { hostDe } from './fuentes';
import { ESTADOS, PERFILES, SECCIONES, VEREDICTOS } from './partidos';

/** Literal quotes (and the slogan) must stay under this many words. */
export const MAX_QUOTE_WORDS = 15;
/** "Qué propone en una frase": at most this many words. */
export const MAX_PROPUESTA_WORDS = 20;

/** Words in a text: runs of letters or digits (punctuation and symbols alone don't count). */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** Text inside «…», “…”, "…" and ‘…’ quotation marks (an outer pair swallows any inner one). */
export function quotedFragments(text: string): string[] {
  return [...text.matchAll(/«([^»]*)»|“([^”]*)”|"([^"]*)"|‘([^’]*)’/g)].map(
    (match) => match.slice(1).find((group) => group !== undefined) ?? '',
  );
}

const isHttps = (url: unknown) => typeof url === 'string' && /^https:\/\/\S+$/.test(url);

/** Last path segments that name a section index, not an article. */
export const INDEX_SEGMENTS = [
  'noticias',
  'actualidad',
  'news',
  'blog',
  'category',
  'categoria',
  'tag',
  'etiqueta',
  'seccion',
  'politica',
  'opinion',
  'home',
  'inicio',
  'portada',
];
/** Link shorteners: the link must name the article itself. */
const SHORTENER_HOSTS = ['bit.ly', 't.co', 'goo.gl', 'ow.ly', 'tinyurl.com', 'lnkd.in'];

/**
 * Why a source URL does not point at one article or document (a home page,
 * a section index or a short link), or undefined when it does. Statements must
 * link to the exact page they come from.
 */
export function notArticleUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'is not a valid URL';
  }
  const host = parsed.hostname.replace(/^www\./, '');
  if (SHORTENER_HOSTS.includes(host)) return `is a short link (${host})`;
  if (host === 'eldiario.es' && /^\/1_[0-9a-f]+\/?$/.test(parsed.pathname)) return 'is an eldiario.es short link';
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (!segments.length) return 'is a home page';
  const last = segments.at(-1)!.toLowerCase();
  if (INDEX_SEGMENTS.includes(last)) return `is a section index ("${last}")`;
  return undefined;
}

/** Where a party file's URLs are checked: the file, and the party's own website hosts. */
interface UrlScope {
  id: string;
  ownHosts: string[];
}

/** Sections whose items are the party speaking about itself (its slogan and campaign lines). */
const SELF_STATEMENT_SECTIONS = ['lema-y-frases'];

/**
 * Pushes an issue naming the file and JSON path when an https `url` is not
 * article-level. A self-statement (the slogan, the lema-y-frases items) may
 * link the party's own home page: what a party says about itself is verified
 * by its own site. Section indexes and short links are rejected everywhere.
 */
function checkArticleUrl(scope: UrlScope, path: string, url: unknown, issues: string[], selfStatement = false) {
  if (!isHttps(url)) return;
  const reason = notArticleUrl(url as string);
  if (!reason) return;
  if (reason === 'is a home page' && selfStatement && scope.ownHosts.includes(hostDe(url as string))) return;
  issues.push(`src/data/partidos/${scope.id}.json ${path}: ${String(url)} ${reason}; link the exact article`);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Item fields whose free text may contain quotes. */
const TEXT_FIELDS = ['texto', 'matiz', 'afirmacion', 'antes', 'ahora', 'atribucion'] as const;

/** Fields allowed only in one section. */
const ONLY_IN: Record<string, string> = {
  veredicto: 'verificacion',
  afirmacion: 'verificacion',
  bulo: 'verificacion',
  postura: 'criticos-defensores',
  perfil: 'criticos-defensores',
  antes: 'cambios',
  ahora: 'cambios',
};

function checkQuotes(where: string, text: unknown, issues: string[]) {
  if (typeof text !== 'string') return;
  for (const quote of quotedFragments(text)) {
    const words = countWords(quote);
    if (words >= MAX_QUOTE_WORDS) issues.push(`${where}: quote of ${words} words («${quote.slice(0, 60)}…»)`);
  }
}

function validateItem(where: string, seccion: string, item: Record<string, unknown>, issues: string[], file: UrlScope & { path: string }) {
  if (!isText(item.texto)) issues.push(`${where}: missing texto`);
  if (!ESTADOS.includes(item.estado as never)) issues.push(`${where}: estado "${String(item.estado)}" is not publishable`);
  if (item.estado === 'PARCIAL' && !isText(item.matiz)) issues.push(`${where}: PARCIAL without matiz`);

  const self = SELF_STATEMENT_SECTIONS.includes(seccion);
  const fuentes = Array.isArray(item.fuentes) ? item.fuentes : [];
  if (!fuentes.some((fuente) => isObject(fuente) && isHttps(fuente.url))) issues.push(`${where}: no https source`);
  fuentes.forEach((fuente, index) => {
    if (!isObject(fuente) || !isHttps(fuente.url)) issues.push(`${where}: source ${index + 1} is not an https URL`);
    else if (!isText(fuente.medio)) issues.push(`${where}: source ${index + 1} has no medio`);
    else checkQuotes(`${where}.fuentes[${index + 1}].medio`, fuente.medio, issues);
    if (isObject(fuente)) checkArticleUrl(file, `${file.path}.fuentes[${index}].url`, fuente.url, issues, self);
  });

  if (item.cita !== undefined) {
    const cita = isObject(item.cita) ? item.cita : {};
    const words = typeof cita.texto === 'string' ? countWords(cita.texto) : 0;
    if (!words) issues.push(`${where}: empty cita`);
    if (words >= MAX_QUOTE_WORDS) issues.push(`${where}: cita of ${words} words`);
    if (!isHttps(cita.url)) issues.push(`${where}: cita without https URL`);
    checkArticleUrl(file, `${file.path}.cita.url`, cita.url, issues, self);
  }
  for (const field of TEXT_FIELDS) checkQuotes(`${where}.${field}`, item[field], issues);

  for (const [field, only] of Object.entries(ONLY_IN)) {
    if (item[field] !== undefined && seccion !== only) issues.push(`${where}: ${field} is only allowed in ${only}`);
  }
  if (item.veredicto !== undefined && !VEREDICTOS.includes(item.veredicto as never)) {
    issues.push(`${where}: veredicto "${String(item.veredicto)}" is not one of ${VEREDICTOS.join(', ')}`);
  }
  if (item.bulo !== undefined && item.bulo !== true) issues.push(`${where}: bulo must be true when present`);
  if (seccion === 'verificacion') {
    if (item.veredicto === undefined) issues.push(`${where}: verificacion item without veredicto`);
    if (!item.bulo && !isText(item.afirmacion)) issues.push(`${where}: verificacion item without afirmacion`);
  }
  if (seccion === 'cambios' && (!isText(item.antes) || !isText(item.ahora))) issues.push(`${where}: cambios item without antes/ahora`);
  if (seccion === 'criticos-defensores') {
    if (item.postura !== 'critico' && item.postura !== 'defensor') issues.push(`${where}: postura "${String(item.postura)}"`);
    if (item.perfil !== undefined && !PERFILES.includes(item.perfil as never)) issues.push(`${where}: perfil "${String(item.perfil)}"`);
  }
}

function validateTarjeta(scope: UrlScope, tarjeta: Record<string, unknown>, issues: string[]) {
  const { id } = scope;
  for (const field of ['candidato', 'lema', 'que_propone'] as const) {
    if (!isText(tarjeta[field])) issues.push(`${id}.tarjeta: missing ${field}`);
  }
  for (const field of ['fuente_lema', 'fuente_propuesta'] as const) {
    if (!isHttps(tarjeta[field])) issues.push(`${id}.tarjeta: ${field} is not an https URL`);
    checkArticleUrl(scope, `.tarjeta.${field}`, tarjeta[field], issues, field === 'fuente_lema');
  }
  if (tarjeta.fuentes_propuesta !== undefined) {
    const urls = Array.isArray(tarjeta.fuentes_propuesta) ? tarjeta.fuentes_propuesta : [null];
    if (!urls.every(isHttps)) issues.push(`${id}.tarjeta: fuentes_propuesta must be https URLs`);
    urls.forEach((url, index) => checkArticleUrl(scope, `.tarjeta.fuentes_propuesta[${index}]`, url, issues));
  }
  if (typeof tarjeta.que_propone === 'string') {
    const words = countWords(tarjeta.que_propone);
    if (words > MAX_PROPUESTA_WORDS) issues.push(`${id}.tarjeta: que_propone has ${words} words (max ${MAX_PROPUESTA_WORDS})`);
    checkQuotes(`${id}.tarjeta.que_propone`, tarjeta.que_propone, issues);
  }
  if (typeof tarjeta.lema === 'string') {
    const words = countWords(tarjeta.lema);
    if (words >= MAX_QUOTE_WORDS) issues.push(`${id}.tarjeta: lema of ${words} words`);
    checkQuotes(`${id}.tarjeta.lema`, tarjeta.lema, issues);
  }
}

export function validatePartido(id: string, raw: unknown, emisores: Emisor[] = EMISORES): string[] {
  const issues: string[] = [];
  if (!isObject(raw)) return [`${id}: not an object`];
  const ownHosts = emisores.filter((emisor) => emisor.tipo === 'partido' && emisor.partido === id).flatMap((emisor) => emisor.hosts);
  const scope: UrlScope = { id, ownHosts };
  if (raw.id !== id) issues.push(`${id}: id is "${String(raw.id)}"`);
  if (typeof raw.corte !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.corte)) issues.push(`${id}: corte is not an ISO date`);
  validateTarjeta(scope, isObject(raw.tarjeta) ? raw.tarjeta : {}, issues);

  const secciones = Array.isArray(raw.secciones) ? raw.secciones : [];
  const ids = secciones.map((seccion) => (isObject(seccion) ? seccion.id : undefined));
  if (ids.join() !== SECCIONES.map((seccion) => seccion.id).join()) {
    issues.push(`${id}: sections are [${ids.join(', ')}], expected the nine in schema order`);
  }
  const refs = new Map<string, number>();
  secciones.forEach((seccion, index) => {
    if (!isObject(seccion)) return;
    const expected = SECCIONES[index];
    if (expected && seccion.titulo !== expected.titulo) issues.push(`${id}.${String(seccion.id)}: title "${String(seccion.titulo)}"`);
    if (seccion.nota_bulos !== undefined && seccion.id !== 'verificacion')
      issues.push(`${id}.${String(seccion.id)}: nota_bulos outside verificacion`);
    checkQuotes(`${id}.${String(seccion.id)}.nota_bulos`, seccion.nota_bulos, issues);
    const items = Array.isArray(seccion.items) ? seccion.items : [];
    items.forEach((item, itemIndex) => {
      const ref = isObject(item) && typeof item.ref === 'string' ? item.ref : `#${itemIndex + 1}`;
      if (isObject(item) && typeof item.ref === 'string') refs.set(ref, (refs.get(ref) ?? 0) + 1);
      validateItem(`${id}.${String(seccion.id)}[${ref}]`, String(seccion.id), isObject(item) ? item : {}, issues, {
        ...scope,
        path: `.secciones[${index}].items[${itemIndex}]`,
      });
    });
  });
  for (const [ref, count] of refs) if (count > 1) issues.push(`${id}: ref "${ref}" is used ${count} times`);

  if (!Array.isArray(raw.pendientes) || !raw.pendientes.every((p) => typeof p === 'string')) {
    issues.push(`${id}: pendientes must be strings`);
  } else {
    raw.pendientes.forEach((pendiente, index) => checkQuotes(`${id}.pendientes[${index + 1}]`, pendiente, issues));
  }
  return issues;
}
