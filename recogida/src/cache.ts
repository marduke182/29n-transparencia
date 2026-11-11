/**
 * Local document cache of the daily collection. One folder per canonical URL:
 *
 *   $N29_CACHE/docs/<sha256(url_canonica)[:16]>/{meta.json, raw.<ext>, texto.txt}
 *
 * New content under the same URL is a new version of the same document: the
 * previous files move to `versiones/<consultado>-<sha[:8]>/` and the top level
 * always holds the latest one. The cache never lives inside a repository.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** The four parties, alphabetical as in the site's src/config.ts: the fixed processing order. */
export const PARTY_IDS = ['frente-amplio', 'pp', 'psoe', 'vox'] as const;
export type PartyId = (typeof PARTY_IDS)[number];

/** How a document reached the cache. */
export type Via = 'rss' | 'sitemap' | 'api' | 'seccion' | 'web' | 'buzon' | 'transcripcion';

/** meta.json of one cached version. Extra fields (transcripts) are allowed. */
export interface Meta {
  url: string;
  url_canonica: string;
  /** ISO date of the run (or the inbox folder date). */
  consultado: string;
  via: Via;
  sha256_contenido: string;
  /** HTTP status of the response; null when the document did not come over HTTP. */
  estado_http: number | null;
  [campo: string]: unknown;
}

/** Query parameters that only track the click, never select the content. */
const PARAMETROS_SEGUIMIENTO = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^_ga$/i,
  /^igshid$/i,
  /^ocid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^s_cid$/i,
  /^int_campaign$/i,
  /^cmpid$/i,
];

/**
 * The URL used for caching and deduplication: https, lowercase host without
 * `www.`, no fragment, no tracking parameters, the rest sorted, no trailing
 * slash (except the root). Throws on an invalid URL.
 */
export function urlCanonica(url: string): string {
  const parsed = new URL(url.trim());
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';
  const params = [...parsed.searchParams.entries()]
    .filter(([clave]) => !PARAMETROS_SEGUIMIENTO.some((patron) => patron.test(clave)))
    .sort(([a, va], [b, vb]) => (a === b ? (va < vb ? -1 : va > vb ? 1 : 0) : a < b ? -1 : 1));
  parsed.search = '';
  for (const [clave, valor] of params) parsed.searchParams.append(clave, valor);
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

export const sha256 = (contenido: string | Uint8Array) => createHash('sha256').update(contenido).digest('hex');

/** Folder name of a document: the first 16 hex characters of sha256(url_canonica). */
export const idDocumento = (canonica: string) => sha256(canonica).slice(0, 16);

/** True when `ruta` or one of its parents holds a `.git` folder or file. */
export function dentroDeRepo(ruta: string): boolean {
  let actual = resolve(ruta);
  for (;;) {
    if (existsSync(join(actual, '.git'))) return true;
    const padre = dirname(actual);
    if (padre === actual) return false;
    actual = padre;
  }
}

/** Reads a required path env var (N29_SITIO, N29_CACHE, N29_BUZON). */
export function rutaDeEntorno(nombre: 'N29_SITIO' | 'N29_CACHE' | 'N29_BUZON', env: NodeJS.ProcessEnv = process.env): string {
  const valor = env[nombre];
  if (!valor) throw new Error(`Falta la variable de entorno ${nombre}`);
  return resolve(valor);
}

/** The cache root from N29_CACHE; refuses a folder inside a repository. */
export function raizCache(env: NodeJS.ProcessEnv = process.env): string {
  const raiz = rutaDeEntorno('N29_CACHE', env);
  if (dentroDeRepo(raiz)) throw new Error('N29_CACHE está dentro de un repositorio: la caché nunca va en un repo');
  return raiz;
}

export interface Entrada {
  url: string;
  /** Defaults to urlCanonica(url). */
  url_canonica?: string;
  consultado: string;
  via: Via;
  estado_http: number | null;
  /** Original bytes or text, stored as raw.<ext>. */
  raw: string | Uint8Array;
  /** Extension of the raw file, without the dot (html, pdf, txt, vtt, xml, json). */
  ext: string;
  /** Extracted plain text, stored as texto.txt. */
  texto: string;
  /** Extra meta fields (transcripts: fuente_transcripcion, video_url, idioma…). */
  extra?: Record<string, unknown>;
}

export interface Guardado {
  id: string;
  dir: string;
  /** nuevo: first version; version: content changed; sin-cambios: same content already cached. */
  estado: 'nuevo' | 'version' | 'sin-cambios';
  meta: Meta;
}

const ISO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Stores one fetched document; same content under the same URL is a no-op. */
export async function guardar(raiz: string, entrada: Entrada): Promise<Guardado> {
  if (!ISO_FECHA.test(entrada.consultado)) throw new Error(`consultado no es una fecha ISO: ${entrada.consultado}`);
  if (!/^[a-z0-9]{1,8}$/.test(entrada.ext)) throw new Error(`Extensión no válida: ${entrada.ext}`);
  const canonica = entrada.url_canonica ?? urlCanonica(entrada.url);
  const id = idDocumento(canonica);
  const dir = join(raiz, 'docs', id);
  const meta: Meta = {
    url: entrada.url,
    url_canonica: canonica,
    consultado: entrada.consultado,
    via: entrada.via,
    sha256_contenido: sha256(entrada.raw),
    estado_http: entrada.estado_http,
    ...entrada.extra,
  };

  const anterior = await leerMeta(raiz, id);
  if (anterior?.sha256_contenido === meta.sha256_contenido) return { id, dir, estado: 'sin-cambios', meta: anterior };

  let estado: Guardado['estado'] = 'nuevo';
  if (anterior) {
    estado = 'version';
    const destino = join(dir, 'versiones', `${anterior.consultado}-${anterior.sha256_contenido.slice(0, 8)}`);
    await mkdir(destino, { recursive: true });
    for (const archivo of await readdir(dir)) {
      if (archivo !== 'versiones') await rename(join(dir, archivo), join(destino, archivo));
    }
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `raw.${entrada.ext}`), entrada.raw);
  await writeFile(join(dir, 'texto.txt'), entrada.texto.endsWith('\n') ? entrada.texto : `${entrada.texto}\n`);
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return { id, dir, estado, meta };
}

/** meta.json of the latest cached version, or undefined. */
export async function leerMeta(raiz: string, id: string): Promise<Meta | undefined> {
  try {
    return JSON.parse(await readFile(join(raiz, 'docs', id, 'meta.json'), 'utf8')) as Meta;
  } catch {
    return undefined;
  }
}

/** Plain text of a PDF with pdfjs-dist (no external binary). Pages are separated by a blank line. */
export async function textoDePdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const tarea = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const documento = await tarea.promise;
  const paginas: string[] = [];
  for (let numero = 1; numero <= documento.numPages; numero++) {
    const pagina = await documento.getPage(numero);
    const contenido = await pagina.getTextContent();
    const texto = contenido.items
      .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    paginas.push(texto);
  }
  await tarea.destroy();
  return paginas.join('\n\n');
}
