/**
 * Manual inbox: pages the owner saved by hand from sites that block automated
 * clients (psoe.es, voxespana.es, podemos.info…).
 *
 *   $N29_BUZON/<partido>/<YYYY-MM-DD>/<archivo>.html|.pdf|.txt  (+ optional <archivo>.url)
 *
 * The canonical URL comes from link[rel=canonical] or og:url, or from the .url
 * sidecar (required for .pdf and .txt). Everything except the article text is
 * dropped: scripts, styles, forms, meta tags, and anything that looks like an
 * account email, token or session id. `consultado` is the folder date.
 */
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PARTY_IDS, guardar, textoDePdf, urlCanonica, type Guardado } from './cache.ts';

const ENTIDADES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', euro: '€', copy: '©', iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ccedil: 'ç', agrave: 'à', egrave: 'è', ograve: 'ò',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü', Ccedil: 'Ç',
};

export function decodificarEntidades(texto: string): string {
  return texto.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entidad, cuerpo: string) => {
    if (cuerpo[0] === '#') {
      const codigo = cuerpo[1]?.toLowerCase() === 'x' ? parseInt(cuerpo.slice(2), 16) : parseInt(cuerpo.slice(1), 10);
      return Number.isFinite(codigo) && codigo > 0 && codigo < 0x110000 ? String.fromCodePoint(codigo) : entidad;
    }
    return ENTIDADES[cuerpo] ?? ENTIDADES[cuerpo.toLowerCase()] ?? entidad;
  });
}

/** Value of one attribute in a tag's source, or undefined. */
function atributo(etiqueta: string, nombre: string): string | undefined {
  const match = new RegExp(`\\s${nombre}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(etiqueta);
  const valor = match?.[1] ?? match?.[2] ?? match?.[3];
  return valor === undefined ? undefined : decodificarEntidades(valor.trim());
}

/** The page's canonical URL from link[rel=canonical] or og:url (https/http only), or undefined. */
export function urlDeHtml(html: string): string | undefined {
  const candidatas: string[] = [];
  for (const [etiqueta] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/^canonical$/i.test(atributo(etiqueta, 'rel') ?? '')) candidatas.push(atributo(etiqueta, 'href') ?? '');
  }
  for (const [etiqueta] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (/^og:url$/i.test(atributo(etiqueta, 'property') ?? atributo(etiqueta, 'name') ?? '')) candidatas.push(atributo(etiqueta, 'content') ?? '');
  }
  return candidatas.find((url) => /^https?:\/\/\S+$/i.test(url));
}

/** Patterns of private-looking strings: emails, bearer/JWT tokens, session ids, long hex/base64 secrets. */
const PRIVADO: [RegExp, string][] = [
  [/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, '[correo]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, '[token]'],
  [/\b(bearer|token|access_token|refresh_token|api[_-]?key|csrf[_-]?token|authenticity_token)\b\s*[:=]?\s*["']?[\w.\-~+/]{12,}=*["']?/gi, '[token]'],
  [/\b(session[_-]?id|sessid|phpsessid|jsessionid|sid|aspsessionid\w*|__cf_bm|cf_clearance|wordpress_logged_in\w*)\b\s*[:=]\s*["']?[\w.\-%|]{6,}["']?/gi, '[sesión]'],
  [/\b[0-9a-f]{32,}\b/gi, '[token]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}(?=\s|$)/g, '[token]'],
];

/** Replaces private-looking strings (account emails, tokens, session ids) in plain text. */
export function ocultarPrivado(texto: string): string {
  return PRIVADO.reduce((acc, [patron, sustituto]) => acc.replace(patron, sustituto), texto);
}

/** Elements whose whole content is never article text. */
const ELEMENTOS_FUERA = ['script', 'style', 'noscript', 'template', 'form', 'iframe', 'svg', 'nav', 'header', 'footer', 'aside', 'button', 'select', 'textarea', 'object', 'head'];

/**
 * Article text of an HTML page: the <article> (or <main>, else <body>) with
 * scripts, forms, navigation and every tag removed, entities decoded, private
 * strings hidden, and one paragraph per line.
 */
export function textoDeHtml(html: string): string {
  let limpio = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const nombre of ELEMENTOS_FUERA) {
    limpio = limpio.replace(new RegExp(`<${nombre}\\b[\\s\\S]*?</${nombre}\\s*>`, 'gi'), ' ');
  }
  limpio = limpio.replace(/<(meta|link|input|base)\b[^>]*>/gi, ' ');
  const zona = /<article\b[^>]*>([\s\S]*)<\/article\s*>/i.exec(limpio)?.[1] ?? /<main\b[^>]*>([\s\S]*)<\/main\s*>/i.exec(limpio)?.[1] ?? /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(limpio)?.[1] ?? limpio;
  const texto = zona
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote|\/section|\/figcaption)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return ocultarPrivado(decodificarEntidades(texto))
    .split('\n')
    .map((linea) => linea.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export interface ResultadoBuzon {
  guardados: (Guardado & { archivo: string; partido: string })[];
  /** Files that could not be ingested, with the reason (missing URL, unknown type…). */
  rechazados: { archivo: string; motivo: string }[];
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const TIPOS = ['.html', '.htm', '.pdf', '.txt'];

/** The URL of an inbox file: from the .url sidecar first, else (HTML only) from the page. */
export function urlDeArchivo(contenido: string | undefined, sidecar: string | undefined): string | undefined {
  const deSidecar = sidecar
    ?.split('\n')
    .map((linea) => linea.trim())
    .find((linea) => /^https?:\/\/\S+$/i.test(linea));
  return deSidecar ?? (contenido === undefined ? undefined : urlDeHtml(contenido));
}

/**
 * Ingests every file under `raizBuzon` (optionally only one date folder) into
 * the cache, with via 'buzon' and `consultado` = folder date. Deterministic order.
 */
export async function leerBuzon(raizBuzon: string, raizCache: string, opciones: { fecha?: string } = {}): Promise<ResultadoBuzon> {
  const resultado: ResultadoBuzon = { guardados: [], rechazados: [] };
  for (const partido of PARTY_IDS) {
    const fechas = (await listar(join(raizBuzon, partido))).filter((nombre) => FECHA.test(nombre) && (!opciones.fecha || nombre === opciones.fecha));
    for (const fecha of fechas) {
      const carpeta = join(raizBuzon, partido, fecha);
      const archivos = await listar(carpeta);
      for (const archivo of archivos) {
        const ext = extname(archivo).toLowerCase();
        if (ext === '.url' || archivo.startsWith('.')) continue;
        const relativo = join(partido, fecha, archivo);
        if (!TIPOS.includes(ext)) {
          resultado.rechazados.push({ archivo: relativo, motivo: `tipo no admitido (${ext || 'sin extensión'})` });
          continue;
        }
        const base = archivo.slice(0, -ext.length);
        const sidecar = archivos.includes(`${base}.url`) ? await readFile(join(carpeta, `${base}.url`), 'utf8') : undefined;
        const bytes = await readFile(join(carpeta, archivo));
        const esHtml = ext === '.html' || ext === '.htm';
        const html = esHtml ? bytes.toString('utf8') : undefined;
        const url = urlDeArchivo(html, sidecar);
        if (!url) {
          resultado.rechazados.push({
            archivo: relativo,
            motivo: esHtml ? 'sin URL: no hay link[rel=canonical] ni og:url, y falta el archivo .url' : 'sin URL: falta el archivo .url, obligatorio para PDF y texto',
          });
          continue;
        }
        let texto: string;
        let raw: string | Uint8Array;
        if (esHtml) {
          // Only the article text is kept, also as raw: the saved page may carry the owner's session.
          texto = textoDeHtml(html!);
          raw = texto;
        } else if (ext === '.pdf') {
          texto = ocultarPrivado(await textoDePdf(bytes));
          raw = bytes;
        } else {
          texto = ocultarPrivado(bytes.toString('utf8'));
          raw = texto;
        }
        const guardado = await guardar(raizCache, {
          url,
          url_canonica: urlCanonica(url),
          consultado: fecha,
          via: 'buzon',
          estado_http: null,
          raw,
          ext: ext === '.pdf' ? 'pdf' : 'txt',
          texto,
          extra: { partido },
        });
        resultado.guardados.push({ ...guardado, archivo: relativo, partido });
      }
    }
  }
  return resultado;
}

async function listar(carpeta: string): Promise<string[]> {
  try {
    return (await readdir(carpeta)).sort();
  } catch {
    return [];
  }
}
