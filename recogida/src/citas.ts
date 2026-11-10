/**
 * Comprobación de citas: cada `cita` y cada fragmento entre comillas de los campos de texto
 * de un archivo de datos (una ficha de partido o un perfil de documentos) debe
 * aparecer literalmente en el texto en caché del documento que cita, y tener
 * menos de 15 palabras.
 *
 * Caché: $N29_CACHE/docs/<sha256(url_canonica)[:16]>/{meta.json, texto.txt}.
 * La comparación se hace tras `normalizar` (unir palabras partidas con guion a
 * final de línea y colapsar espacios), igual en la cita y en el documento.
 *
 * Uso: node src/citas.ts <archivo.json>...   (rutas relativas a $N29_SITIO)
 * Sale con 1 si hay algún problema y con 2 si falta configuración.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { idDocumento, urlCanonica } from './cache.ts';

/** Las citas literales deben tener menos de este número de palabras. */
export const MAX_PALABRAS_CITA = 15;

/** Campos de texto libre de un elemento de ficha que pueden llevar fragmentos «…». */
const CAMPOS_TEXTO = ['texto', 'matiz', 'afirmacion', 'antes', 'ahora', 'atribucion'] as const;

/**
 * Normaliza un texto para comparar citas: forma NFC, sin guiones blandos, une
 * las palabras partidas con guion a final de línea y colapsa los espacios.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFC')
    .replace(/­/g, '')
    .replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palabras de un texto: tramos con alguna letra o cifra (la puntuación sola no cuenta). */
export function contarPalabras(texto: string): number {
  return texto.split(/\s+/).filter((palabra) => /[\p{L}\p{N}]/u.test(palabra)).length;
}

/**
 * Texto entre comillas «…», “…”, "…" y ‘…’ (un par exterior se traga los
 * interiores): las mismas que cuenta `quotedFragments` en el validador del sitio.
 */
export function fragmentos(texto: string): string[] {
  return [...texto.matchAll(/«([^»]*)»|“([^”]*)”|"([^"]*)"|‘([^’]*)’/g)].map(
    (m) => m.slice(1).find((grupo) => grupo !== undefined) ?? '',
  );
}

/** Una cita que comprobar: dónde está, su texto y las URL de los documentos en los que puede estar. */
export interface Cita {
  donde: string;
  tipo: 'cita' | 'fragmento';
  texto: string;
  urls: string[];
}

export type TipoProblema = 'no_literal' | 'sin_cache' | 'larga' | 'sin_documento';

export interface Problema {
  donde: string;
  tipo: TipoProblema;
  texto: string;
  detalle: string;
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const esTexto = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const unicas = (urls: unknown[]): string[] => [...new Set(urls.filter(esTexto))];

function fragmentosDe(donde: string, texto: unknown, urls: string[], salida: Cita[]) {
  if (typeof texto !== 'string') return;
  for (const f of fragmentos(texto)) salida.push({ donde, tipo: 'fragmento', texto: f, urls });
}

/**
 * Citas de una ficha de partido: la tarjeta y los elementos publicados. Quedan
 * fuera los descartados, los en espera, `pendientes` y `nota_bulos` (no citan documento).
 */
function citasPartido(datos: Record<string, unknown>): Cita[] {
  const salida: Cita[] = [];
  const tarjeta = esObjeto(datos.tarjeta) ? datos.tarjeta : {};
  fragmentosDe('tarjeta.lema', tarjeta.lema, unicas([tarjeta.fuente_lema]), salida);
  fragmentosDe(
    'tarjeta.que_propone',
    tarjeta.que_propone,
    unicas([tarjeta.fuente_propuesta, ...lista(tarjeta.fuentes_propuesta)]),
    salida,
  );
  lista(datos.secciones).forEach((seccion, s) => {
    if (!esObjeto(seccion)) return;
    const id = esTexto(seccion.id) ? seccion.id : `#${s + 1}`;
    lista(seccion.items).forEach((item, i) => {
      if (!esObjeto(item)) return;
      const donde = `${id}[${esTexto(item.ref) ? item.ref : `#${i + 1}`}]`;
      const cita = esObjeto(item.cita) ? item.cita : undefined;
      const urlsFuentes = lista(item.fuentes).map((f) => (esObjeto(f) ? f.url : undefined));
      if (cita && typeof cita.texto === 'string') {
        salida.push({ donde: `${donde}.cita`, tipo: 'cita', texto: cita.texto, urls: unicas([cita.url]) });
      }
      const urls = unicas([...urlsFuentes, cita?.url]);
      for (const campo of CAMPOS_TEXTO) fragmentosDe(`${donde}.${campo}`, item[campo], urls, salida);
    });
  });
  return salida;
}

/** Citas de un perfil de documentos: la `cita` de cada propuesta y los fragmentos de propuestas y mensajes. */
function citasPerfil(datos: Record<string, unknown>): Cita[] {
  const salida: Cita[] = [];
  const urlDe = new Map<string, unknown>();
  for (const doc of lista(datos.documentos)) if (esObjeto(doc) && esTexto(doc.id)) urlDe.set(doc.id, doc.url);
  const urlsDe = (ids: unknown[]) => unicas(ids.map((id) => (typeof id === 'string' ? urlDe.get(id) : undefined)));
  for (const tipo of ['propuestas', 'mensajes'] as const) {
    lista(datos[tipo]).forEach((item, i) => {
      if (!esObjeto(item)) return;
      const donde = `${tipo}[${i + 1}]`;
      if (typeof item.cita === 'string') {
        salida.push({ donde: `${donde}.cita`, tipo: 'cita', texto: item.cita, urls: urlsDe([item.cita_documento]) });
      }
      fragmentosDe(`${donde}.texto`, item.texto, urlsDe(lista(item.documentos)), salida);
    });
  }
  return salida;
}

/** Todas las citas de un archivo de datos, en el orden del archivo. */
export function extraerCitas(datos: unknown): Cita[] {
  if (!esObjeto(datos)) return [];
  return Array.isArray(datos.documentos) ? citasPerfil(datos) : citasPartido(datos);
}

/** Devuelve el texto en caché de una URL, o undefined si no está. */
export type LectorCache = (url: string) => string | undefined;

/**
 * Comprueba cada cita: longitud, que tenga documento, que el documento esté en
 * caché y que la cita aparezca literal en alguno de sus documentos.
 */
export function comprobarCitas(citas: Cita[], leer: LectorCache): Problema[] {
  const problemas: Problema[] = [];
  const normalizados = new Map<string, string | undefined>();
  const textoDe = (url: string) => {
    if (!normalizados.has(url)) {
      const texto = leer(url);
      normalizados.set(url, texto === undefined ? undefined : normalizar(texto));
    }
    return normalizados.get(url);
  };
  for (const cita of citas) {
    const base = { donde: cita.donde, texto: cita.texto };
    const palabras = contarPalabras(cita.texto);
    if (palabras >= MAX_PALABRAS_CITA) {
      problemas.push({ ...base, tipo: 'larga', detalle: `${palabras} palabras (máximo ${MAX_PALABRAS_CITA - 1})` });
    }
    if (!cita.urls.length) {
      problemas.push({ ...base, tipo: 'sin_documento', detalle: 'no enlaza ningún documento' });
      continue;
    }
    const enCache = cita.urls.filter((url) => textoDe(url) !== undefined);
    const faltan = cita.urls.filter((url) => textoDe(url) === undefined);
    if (!enCache.length) {
      problemas.push({ ...base, tipo: 'sin_cache', detalle: `sin texto en caché: ${faltan.join(', ')}` });
      continue;
    }
    const buscada = normalizar(cita.texto);
    if (!enCache.some((url) => textoDe(url)!.includes(buscada))) {
      const resto = faltan.length ? `; sin texto en caché: ${faltan.join(', ')}` : '';
      problemas.push({ ...base, tipo: 'no_literal', detalle: `no aparece en ${enCache.join(', ')}${resto}` });
    }
  }
  return problemas;
}

/**
 * Lector sobre la carpeta de caché. Busca por la clave de la URL canónica (la
 * de cache.ts) y, si no está, por el índice de `url` y `url_canonica` de cada
 * meta.json, de modo que una URL guardada con otra forma encuentra su documento.
 */
export function lectorCache(raiz: string): LectorCache {
  const docs = join(raiz, 'docs');
  let indice: Map<string, string> | undefined;
  const construirIndice = () => {
    const mapa = new Map<string, string>();
    const claves = existsSync(docs) ? readdirSync(docs).sort() : [];
    for (const clave of claves) {
      const ruta = join(docs, clave, 'meta.json');
      if (!existsSync(ruta)) continue;
      try {
        const meta: unknown = JSON.parse(readFileSync(ruta, 'utf8'));
        if (!esObjeto(meta)) continue;
        for (const url of [meta.url_canonica, meta.url]) if (esTexto(url) && !mapa.has(url)) mapa.set(url, clave);
      } catch {
        // meta.json ilegible: el documento cuenta como ausente
      }
    }
    return mapa;
  };
  const leerClave = (clave: string) => {
    const ruta = join(docs, clave, 'texto.txt');
    return existsSync(ruta) ? readFileSync(ruta, 'utf8') : undefined;
  };
  return (url) => {
    let canonica = url;
    try {
      canonica = urlCanonica(url);
    } catch {
      // URL no válida: solo puede estar en el índice tal cual
    }
    const directo = leerClave(idDocumento(canonica));
    if (directo !== undefined) return directo;
    indice ??= construirIndice();
    const clave = indice.get(url) ?? indice.get(canonica);
    return clave === undefined ? undefined : leerClave(clave);
  };
}

const ETIQUETAS: Record<TipoProblema, string> = {
  no_literal: 'Citas no literales',
  sin_cache: 'Documentos sin caché',
  larga: 'Citas de 15 palabras o más',
  sin_documento: 'Citas sin documento',
};

/** Informe en Markdown de un archivo: un bloque por tipo de problema, siempre en el mismo orden. */
export function informe(archivo: string, citas: Cita[], problemas: Problema[]): string {
  const lineas = [`## ${archivo}`, '', `${citas.length} citas comprobadas, ${problemas.length} problemas.`];
  for (const tipo of Object.keys(ETIQUETAS) as TipoProblema[]) {
    const deTipo = problemas.filter((p) => p.tipo === tipo);
    lineas.push('', `### ${ETIQUETAS[tipo]} (${deTipo.length})`, '');
    if (!deTipo.length) lineas.push('_Ninguna._');
    for (const p of deTipo) lineas.push(`- \`${p.donde}\`: «${p.texto}» (${p.detalle})`);
  }
  return lineas.join('\n') + '\n';
}

function main(args: string[]): number {
  const sitio = process.env.N29_SITIO;
  const cache = process.env.N29_CACHE;
  if (!sitio || !cache || !args.length) {
    process.stderr.write('Uso: N29_SITIO=… N29_CACHE=… node src/citas.ts <archivo.json>...\n');
    return 2;
  }
  const leer = lectorCache(cache);
  let total = 0;
  const salida: string[] = [];
  for (const archivo of args) {
    const ruta = resolve(sitio, archivo);
    const citas = extraerCitas(JSON.parse(readFileSync(ruta, 'utf8')));
    const problemas = comprobarCitas(citas, leer);
    total += problemas.length;
    salida.push(informe(archivo, citas, problemas));
  }
  process.stdout.write(salida.join('\n'));
  return total ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
