/**
 * Merge: applies the adjudicated outputs of a run (JSON files in the run
 * folder) to the site's party files, deterministically.
 *
 *   $N29_SITIO/apps/29n/src/data/partidos/<id>.json   (destino "partido")
 *   $N29_SITIO/apps/29n/src/data/perfiles/<id>.json   (destino "perfil")
 *
 * Party files:
 * - Each new item gets the next integer ref of its party (max integer in any
 *   ref, items and descartados, plus one).
 * - Dedup key: canonical URL (no tracking parameters, no www) + fingerprint of
 *   the normalised claim text. Pairs already present are skipped, so running
 *   twice on the same inputs leaves the files unchanged.
 * - Stable key order for new items; new items are appended in a fixed order;
 *   files are written only when something was added.
 * - A proposal with `en_espera: true` goes to the top-level `en_espera` array
 *   of the party file, as a full Item with its `seccion`.
 * - `corte` moves to the run date only when items are added.
 * - From 2026-11-24 (the pre-election poll ban) new `encuestas` items are refused.
 * - A proposal may carry `pregunta` (Q1..Q8, next to `seccion`); one that does
 *   not match its section (preguntas.ts), or is null, is refused. `pregunta` is
 *   never written to the party file, and an item that carries it is refused.
 * - An item may be a context note (`contexto: true`), never with a veredicto.
 * - Rules the site checks on every item, refused here so the day's data passes
 *   them: a bulo is VERIFICADO (the fact-checker's page is the primary record of
 *   its own verdict), and no quote (`cita` or «…» in a text field) has 15 words
 *   or more.
 * - Every quote of a new item appears literally in the cached text of the URL it
 *   cites (citas.ts, the same check the run makes after the merge); one that
 *   does not, or whose document is not cached, leaves the item out. Only with a
 *   cache reader (`leer`; the CLI always passes the run's cache).
 * - With `citable` (the CLI always passes it: fuentes.json of the site and the
 *   owner's documents, citas.ts citableEn), a proposal that names a URL on a
 *   host the registry does not list is refused, and a quote is checked only
 *   against citable documents.
 *
 * Perfil files ({partido, periodo, limites, documentos, propuestas, mensajes}):
 * - A proposal adds one documento, propuesta or mensaje (`tipo`). Propuestas and
 *   mensajes name their documents by URL; they resolve to the document ids.
 * - New ids continue `<partido>-d<n>`, `-p<n>`, `-m<n>`.
 * - Dedup: a documento by its canonical URL (or, without URL, its title
 *   fingerprint); a propuesta or mensaje by document URL + text fingerprint.
 * - `periodo.hasta` moves to the run date only when something is added, in all
 *   four perfiles at once (the site's validator requires the same periodo).
 *
 * The run date is an argument (no clock).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PARTY_IDS, sha256, urlCanonica } from './cache.ts';
import { comprobarCitas, extraerCitas, type LectorCache } from './citas.ts';
import { motivoContexto, motivoPregunta, type Pregunta } from './preguntas.ts';

/** First day of the ban on publishing polls (five days before the 29 Nov 2026 election). */
export const VEDA_ENCUESTAS = '2026-11-24';

export const SECCIONES = ['candidatura', 'lema-y-frases', 'temas', 'por-escrito', 'verificacion', 'historial', 'cambios', 'criticos-defensores', 'encuestas'] as const;
const ESTADOS = ['VERIFICADO', 'CORREGIDO', 'PARCIAL'];

/** Key order of a written item; unknown keys follow, alphabetically. */
const ORDEN_CLAVES = ['ref', 'texto', 'estado', 'matiz', 'contexto', 'afirmacion', 'veredicto', 'bulo', 'antes', 'ahora', 'postura', 'perfil', 'atribucion', 'cita', 'fuentes'];

type Objeto = Record<string, unknown>;

export interface Propuesta {
  partido: string;
  /** partido (default); perfil proposals are `PropuestaPerfil`. */
  destino?: 'partido';
  seccion: string;
  /** The voter question the item answers (criterios/preguntas.md). Checked against seccion, never stored. */
  pregunta?: Pregunta;
  item: Objeto;
  /** Held by the adjudicator: written to the party file's top-level `en_espera` (with `seccion`), not to the section. */
  en_espera?: boolean;
}

export interface Rechazo {
  archivo: string;
  indice: number;
  motivo: string;
}

export interface CambioArchivo {
  ruta: string;
  partido: string;
  destino: 'partido' | 'perfil';
  /** Party files: ref and seccion; perfil files: the new id and its kind in `seccion` (documento/propuesta/mensaje). */
  añadidos: { ref: string; seccion: string; url: string; en_espera?: true }[];
  duplicados: number;
}

export interface Plan {
  fecha: string;
  cambios: CambioArchivo[];
  rechazados: Rechazo[];
}

const isObjeto = (valor: unknown): valor is Objeto => typeof valor === 'object' && valor !== null && !Array.isArray(valor);

/** Normalised claim text: no accents, lowercase, letters and digits separated by single spaces. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const huella = (texto: string) => sha256(normalizar(texto)).slice(0, 16);

/** Dedup keys of an item: one per source URL, each with the claim fingerprint. */
export function clavesDe(item: Objeto): string[] {
  const texto = typeof item.texto === 'string' ? item.texto : '';
  const fuentes = Array.isArray(item.fuentes) ? item.fuentes : [];
  const urls = fuentes.flatMap((fuente) => (isObjeto(fuente) && typeof fuente.url === 'string' ? [fuente.url] : []));
  if (isObjeto(item.cita) && typeof item.cita.url === 'string') urls.push(item.cita.url);
  return urls.flatMap((url) => {
    try {
      return [`${urlCanonica(url)} ${huella(texto)}`];
    } catch {
      return [];
    }
  });
}

/** Every http(s) URL in a value, at any depth (a proposal's sources, quotes and perfil documents). */
export function urlsEn(valor: unknown): string[] {
  if (typeof valor === 'string') return /^https?:\/\//i.test(valor.trim()) ? [valor.trim()] : [];
  if (Array.isArray(valor)) return valor.flatMap(urlsEn);
  if (isObjeto(valor)) return Object.values(valor).flatMap(urlsEn);
  return [];
}

/** Largest integer found in any ref (e.g. "23, 13" → 23, "50a" → 50, "V1" → 1). */
export function maxRef(refs: string[]): number {
  return refs.reduce((max, ref) => Math.max(max, ...[...ref.matchAll(/\d+/g)].map((match) => Number(match[0]))), 0);
}

/** Why a proposal cannot be merged, or undefined. */
export function motivoRechazo(propuesta: Propuesta, fecha: string, leer?: LectorCache): string | undefined {
  if (!(PARTY_IDS as readonly string[]).includes(propuesta.partido)) return `partido desconocido "${propuesta.partido}"`;
  if (propuesta.destino !== undefined && propuesta.destino !== 'partido') return `destino desconocido "${String(propuesta.destino)}"`;
  if (!(SECCIONES as readonly string[]).includes(propuesta.seccion)) return `sección desconocida "${propuesta.seccion}"`;
  if (propuesta.en_espera !== undefined && typeof propuesta.en_espera !== 'boolean') return 'en_espera debe ser true o false';
  if (propuesta.seccion === 'encuestas' && fecha >= VEDA_ENCUESTAS) return `veda de encuestas: desde el ${VEDA_ENCUESTAS} no se añaden encuestas`;
  const item = propuesta.item;
  if (!isObjeto(item)) return 'item no es un objeto';
  if (item.pregunta !== undefined) return 'pregunta va en la propuesta, junto a seccion, no en el item';
  const pregunta = motivoPregunta(propuesta.pregunta, propuesta.seccion, item);
  if (pregunta) return pregunta;
  const contexto = motivoContexto(propuesta.seccion, item);
  if (contexto) return contexto;
  if (typeof item.texto !== 'string' || !item.texto.trim()) return 'item sin texto';
  if (!ESTADOS.includes(item.estado as string)) return `estado "${String(item.estado)}" no publicable`;
  if (item.estado === 'PARCIAL' && (typeof item.matiz !== 'string' || !item.matiz.trim())) return 'PARCIAL sin matiz';
  if (item.bulo === true && item.estado !== 'VERIFICADO') return `bulo con estado ${String(item.estado)}: los elementos de bulos son VERIFICADO`;
  // The quotes citas.ts finds in a party file, for this item alone; without a cache reader, only their length.
  const citas = extraerCitas({ secciones: [{ id: propuesta.seccion, items: [{ ...item, ref: 'nuevo' }] }] });
  const problema = comprobarCitas(citas, leer ?? (() => undefined)).find((p) => leer !== undefined || p.tipo === 'larga');
  if (problema) {
    const campo = problema.donde.replace(/^[^.]*\./, '');
    return problema.tipo === 'larga' ? `${campo}: cita de ${problema.detalle}` : `${campo}: cita «${problema.texto}» ${problema.detalle}`;
  }
  const fuentes = Array.isArray(item.fuentes) ? item.fuentes : [];
  if (!fuentes.length || !fuentes.every((fuente) => isObjeto(fuente) && typeof fuente.url === 'string' && /^https:\/\/\S+$/.test(fuente.url) && typeof fuente.medio === 'string')) {
    return 'fuentes: hace falta al menos una, cada una con url https y medio';
  }
  if (!clavesDe(item).length) return 'ninguna URL de fuente es válida';
  return undefined;
}

/** A new item with keys in the fixed order and the given ref. */
export function ordenarItem(item: Objeto, ref: string): Objeto {
  const { ref: _ignorada, ...resto } = item;
  const salida: Objeto = { ref };
  for (const clave of ORDEN_CLAVES) if (clave !== 'ref' && resto[clave] !== undefined) salida[clave] = resto[clave];
  for (const clave of Object.keys(resto).sort()) if (!ORDEN_CLAVES.includes(clave)) salida[clave] = resto[clave];
  return salida;
}

/** Reads every *.json of the run folder (sorted by name): an array of proposals or { propuestas: [...] }. */
export async function leerPropuestas(carpeta: string): Promise<{ archivo: string; indice: number; propuesta: Propuesta | PropuestaPerfil }[]> {
  const archivos = (await readdir(carpeta)).filter((nombre) => nombre.endsWith('.json')).sort();
  const salida: { archivo: string; indice: number; propuesta: Propuesta | PropuestaPerfil }[] = [];
  for (const archivo of archivos) {
    const contenido = JSON.parse(await readFile(join(carpeta, archivo), 'utf8')) as unknown;
    const lista = Array.isArray(contenido) ? contenido : isObjeto(contenido) && Array.isArray(contenido.propuestas) ? contenido.propuestas : undefined;
    if (!lista) continue;
    lista.forEach((propuesta, indice) => salida.push({ archivo, indice, propuesta: propuesta as Propuesta | PropuestaPerfil }));
  }
  return salida;
}

interface FichaPartido extends Objeto {
  id: string;
  corte?: string;
  secciones: { id: string; items: Objeto[] }[];
  descartados?: Objeto[];
  /** Held items: full Items with a required `seccion`. */
  en_espera?: Objeto[];
}

// ---------------------------------------------------------------- perfiles

/** Document kinds, vías and message kinds of the perfil files (site: src/data/perfiles.ts). */
export const TIPOS_DOCUMENTO = ['programa electoral', 'programa sectorial', 'argumentario', 'discurso', 'entrevista', 'nota de prensa', 'comunicado', 'folleto', 'noticia', 'transcripcion'] as const;
export const VIAS_PERFIL = ['web', 'rss', 'buzon'] as const;
export const TIPOS_MENSAJE = ['critica_al_gobierno', 'critica_a_otro_partido', 'valores', 'otro'] as const;
/** Topic codes a perfil proposal can have: every topic except the campaign (POL). */
export const TEMAS_PERFIL = ['TRA', 'VIV', 'COR', 'SEG', 'INM', 'PEN', 'ECO', 'EMP', 'SOC', 'TER', 'EDU', 'EXT', 'MED', 'SAN', 'IGU', 'OTR'] as const;

/**
 * One addition to a perfil file. Documents are named by URL everywhere:
 * `documento.url` for a new document, and `cita.documento` / `documentos` (URLs)
 * in a propuesta or mensaje, resolved to existing or newly added document ids.
 */
export type PropuestaPerfil = { partido: string; destino: 'perfil' } & (
  | { tipo: 'documento'; documento: Objeto }
  | { tipo: 'propuesta'; propuesta: Objeto }
  | { tipo: 'mensaje'; mensaje: Objeto }
);

interface FichaPerfil extends Objeto {
  partido: string;
  periodo: { desde: string; hasta: string };
  limites: string[];
  documentos: Objeto[];
  propuestas: Objeto[];
  mensajes: Objeto[];
}

const ORDEN_DOCUMENTO = ['id', 'titulo', 'fecha', 'fecha_fuente', 'tipo', 'url', 'url_pendiente', 'procedencia'];
const ORDEN_PROPUESTA = ['id', 'tema', 'texto', 'cita', 'documentos'];
const ORDEN_MENSAJE = ['id', 'tipo', 'objetivo', 'texto', 'documentos'];
const TIPOS_PERFIL = ['documento', 'propuesta', 'mensaje'] as const;
const LETRA = { documento: 'd', propuesta: 'p', mensaje: 'm' } as const;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const esTexto = (valor: unknown): valor is string => typeof valor === 'string' && valor.trim() !== '';
const esHttps = (valor: unknown): valor is string => typeof valor === 'string' && /^https:\/\/\S+$/.test(valor);
const canonicaSegura = (url: string) => {
  try {
    return urlCanonica(url);
  } catch {
    return undefined;
  }
};

/** Keeps the listed keys in order and drops any other. */
const conClaves = (objeto: Objeto, orden: string[]) => Object.fromEntries(orden.filter((clave) => objeto[clave] !== undefined).map((clave) => [clave, objeto[clave]]));

/** Why a perfil proposal cannot be merged (shape only; document references are checked on merge), or undefined. */
export function motivoRechazoPerfil(propuesta: PropuestaPerfil): string | undefined {
  if (!(PARTY_IDS as readonly string[]).includes(propuesta.partido)) return `partido desconocido "${propuesta.partido}"`;
  if (!(TIPOS_PERFIL as readonly string[]).includes(propuesta.tipo)) return `tipo de perfil desconocido "${String(propuesta.tipo)}"`;
  if (propuesta.tipo === 'documento') {
    const doc = propuesta.documento;
    if (!isObjeto(doc)) return 'documento no es un objeto';
    if (!esTexto(doc.titulo)) return 'documento sin titulo';
    if (typeof doc.fecha !== 'string' || !ISO.test(doc.fecha)) return 'documento: fecha no es ISO';
    if (!esTexto(doc.fecha_fuente)) return 'documento sin fecha_fuente';
    if (!(TIPOS_DOCUMENTO as readonly string[]).includes(doc.tipo as string)) return `documento: tipo "${String(doc.tipo)}" no admitido`;
    if (doc.url === null) {
      if (!esTexto(doc.url_pendiente)) return 'documento sin url ni url_pendiente';
    } else if (!esHttps(doc.url) || !canonicaSegura(doc.url)) return 'documento: url no es https';
    else if (doc.url_pendiente !== undefined) return 'documento: url_pendiente solo vale con url null';
    const procedencia = isObjeto(doc.procedencia) ? doc.procedencia : {};
    if (!(VIAS_PERFIL as readonly string[]).includes(procedencia.via as string)) return `documento: procedencia.via "${String(procedencia.via)}" no admitida`;
    if (typeof procedencia.consultado !== 'string' || !ISO.test(procedencia.consultado)) return 'documento: procedencia.consultado no es ISO';
    return undefined;
  }
  const dato = propuesta.tipo === 'propuesta' ? propuesta.propuesta : propuesta.mensaje;
  if (!isObjeto(dato)) return `${propuesta.tipo} no es un objeto`;
  if (!esTexto(dato.texto)) return `${propuesta.tipo} sin texto`;
  if (!Array.isArray(dato.documentos) || !dato.documentos.length || !dato.documentos.every(esHttps)) return `${propuesta.tipo}: documentos debe ser una lista de URLs https`;
  if (propuesta.tipo === 'propuesta') {
    if (!(TEMAS_PERFIL as readonly string[]).includes(dato.tema as string)) return `propuesta: tema "${String(dato.tema)}" no admitido`;
    const cita = isObjeto(dato.cita) ? dato.cita : undefined;
    if (!cita || !esTexto(cita.texto) || !esHttps(cita.documento)) return 'propuesta: cita necesita texto y documento (URL)';
    if (!dato.documentos.includes(cita.documento)) return 'propuesta: cita.documento no está en documentos';
  } else {
    if (!(TIPOS_MENSAJE as readonly string[]).includes(dato.tipo as string)) return `mensaje: tipo "${String(dato.tipo)}" no admitido`;
    if (dato.objetivo !== undefined && !esTexto(dato.objetivo)) return 'mensaje: objetivo debe ser texto';
  }
  return undefined;
}

/** Dedup key of a perfil document: its canonical URL, or the title fingerprint when the URL is pending. */
const claveDocumento = (doc: Objeto) => (esHttps(doc.url) ? (canonicaSegura(doc.url) ?? doc.url) : `pendiente ${huella(String(doc.titulo ?? ''))}`);

/** Largest n among ids `<partido>-<letra><n>`. */
const maxId = (items: Objeto[], partido: string, letra: string) =>
  items.reduce((max, item) => {
    const match = new RegExp(`^${partido}-${letra}(\\d+)$`).exec(String(item.id ?? ''));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

/**
 * Applies perfil proposals to one perfil file in place. Documents first (sorted
 * by key), then propuestas and mensajes (sorted by first document URL and
 * fingerprint), so ids are deterministic.
 */
export function fusionarPerfil(
  ficha: FichaPerfil,
  entradas: { archivo: string; indice: number; propuesta: PropuestaPerfil }[],
): { añadidos: CambioArchivo['añadidos']; duplicados: number; rechazados: Rechazo[] } {
  const partido = ficha.partido;
  const añadidos: CambioArchivo['añadidos'] = [];
  const rechazados: Rechazo[] = [];
  let duplicados = 0;

  const idPorUrl = new Map<string, string>();
  for (const doc of ficha.documentos) if (esHttps(doc.url) && typeof doc.id === 'string') idPorUrl.set(canonicaSegura(doc.url) ?? doc.url, doc.id);
  const docsVistos = new Set(ficha.documentos.map(claveDocumento));
  const siguiente = {
    documento: maxId(ficha.documentos, partido, 'd') + 1,
    propuesta: maxId(ficha.propuestas, partido, 'p') + 1,
    mensaje: maxId(ficha.mensajes, partido, 'm') + 1,
  };

  // 1. Documents.
  const documentos = entradas
    .filter((e) => e.propuesta.tipo === 'documento')
    .map((e) => ({ ...e, clave: claveDocumento((e.propuesta as { documento: Objeto }).documento) }))
    .sort((a, b) => a.clave.localeCompare(b.clave) || a.archivo.localeCompare(b.archivo) || a.indice - b.indice);
  for (const { propuesta, clave } of documentos) {
    if (docsVistos.has(clave)) {
      duplicados++;
      continue;
    }
    docsVistos.add(clave);
    const doc = (propuesta as { documento: Objeto }).documento;
    const id = `${partido}-${LETRA.documento}${siguiente.documento++}`;
    const procedencia = doc.procedencia as Objeto;
    ficha.documentos.push(conClaves({ ...doc, id, procedencia: conClaves(procedencia, ['via', 'consultado']) }, ORDEN_DOCUMENTO));
    if (esHttps(doc.url)) idPorUrl.set(clave, id);
    añadidos.push({ ref: id, seccion: 'documento', url: esHttps(doc.url) ? clave : '' });
  }

  // 2. Propuestas and mensajes: document URLs → ids; dedup on each document URL + text fingerprint.
  const claves = (dato: Objeto) => {
    const urls = (dato.documentos as string[]).map((url) => canonicaSegura(url) ?? url);
    const ids = urls.map((url) => idPorUrl.get(url));
    return { urls, ids, claves: urls.map((url) => `${url} ${huella(String(dato.texto))}`) };
  };
  const existentes = (lista: Objeto[]) => {
    const urlPorId = new Map([...idPorUrl].map(([url, id]) => [id, url]));
    return new Set(
      lista.flatMap((item) =>
        (Array.isArray(item.documentos) ? item.documentos : []).flatMap((id) => {
          const url = urlPorId.get(String(id));
          return url ? [`${url} ${huella(String(item.texto ?? ''))}`] : [];
        }),
      ),
    );
  };
  for (const tipo of ['propuesta', 'mensaje'] as const) {
    const lista = tipo === 'propuesta' ? ficha.propuestas : ficha.mensajes;
    const vistas = existentes(lista);
    const ordenadas = entradas
      .filter((e) => e.propuesta.tipo === tipo)
      .map((e) => {
        const dato = (e.propuesta as Record<string, unknown>)[tipo] as Objeto;
        return { ...e, dato, ...claves(dato) };
      })
      .sort((a, b) => a.claves[0]!.localeCompare(b.claves[0]!) || a.archivo.localeCompare(b.archivo) || a.indice - b.indice);
    for (const { archivo, indice, dato, urls, ids, claves: suyas } of ordenadas) {
      const falta = urls.find((_url, i) => ids[i] === undefined);
      if (falta) {
        rechazados.push({ archivo, indice, motivo: `${tipo}: el documento ${falta} no está en el perfil ni en esta ejecución` });
        continue;
      }
      if (suyas.some((clave) => vistas.has(clave))) {
        duplicados++;
        continue;
      }
      suyas.forEach((clave) => vistas.add(clave));
      const id = `${partido}-${LETRA[tipo]}${siguiente[tipo]++}`;
      const nuevo: Objeto = { ...dato, id, documentos: ids };
      if (tipo === 'propuesta') {
        const cita = dato.cita as Objeto;
        nuevo.cita = conClaves({ ...cita, documento: idPorUrl.get(canonicaSegura(String(cita.documento)) ?? '') }, ['texto', 'documento', 'pagina']);
      }
      lista.push(conClaves(nuevo, tipo === 'propuesta' ? ORDEN_PROPUESTA : ORDEN_MENSAJE));
      añadidos.push({ ref: id, seccion: tipo, url: urls[0]! });
    }
  }
  return { añadidos, duplicados, rechazados };
}

// ---------------------------------------------------------------- run

const rutaFicha = (sitio: string, destino: 'partido' | 'perfil', partido: string) =>
  join(sitio, 'apps', '29n', 'src', 'data', destino === 'partido' ? 'partidos' : 'perfiles', `${partido}.json`);

async function escribirJson(ruta: string, datos: unknown) {
  await mkdir(dirname(ruta), { recursive: true });
  await writeFile(ruta, `${JSON.stringify(datos, null, 2)}\n`);
}

/**
 * Applies the proposals of `carpeta` to the site at `sitio`. With `escribir:
 * false` it only returns the plan. Files without additions are not touched.
 */
export async function fusionar(opciones: {
  sitio: string;
  carpeta: string;
  fecha: string;
  escribir?: boolean;
  leer?: LectorCache;
  /** Whether a URL may back a published item (citas.ts, citableEn): with it, a proposal naming any other URL is refused, and quotes are checked only against citable documents. */
  citable?: (url: string) => boolean;
}): Promise<Plan> {
  if (!ISO.test(opciones.fecha)) throw new Error(`fecha no es ISO: ${opciones.fecha}`);
  const plan: Plan = { fecha: opciones.fecha, cambios: [], rechazados: [] };
  const dePartido: { archivo: string; indice: number; propuesta: Propuesta }[] = [];
  const dePerfil: { archivo: string; indice: number; propuesta: PropuestaPerfil }[] = [];
  const { citable, leer: leerCache } = opciones;
  // A quote counts only in a document on a registered host (or one the owner supplied).
  const leer = leerCache && citable ? (url: string) => (citable(url) ? leerCache(url) : undefined) : leerCache;
  for (const entrada of await leerPropuestas(opciones.carpeta)) {
    const esPerfil = isObjeto(entrada.propuesta) && entrada.propuesta.destino === 'perfil';
    const ajena = citable ? urlsEn(entrada.propuesta).find((url) => !citable(url)) : undefined;
    const motivo = !isObjeto(entrada.propuesta)
      ? 'propuesta no es un objeto'
      : ajena !== undefined
        ? `${ajena}: host sin registrar en fuentes.json; no se publica sin revisión`
        : esPerfil
          ? motivoRechazoPerfil(entrada.propuesta as PropuestaPerfil)
          : motivoRechazo(entrada.propuesta as unknown as Propuesta, opciones.fecha, leer);
    if (motivo) plan.rechazados.push({ archivo: entrada.archivo, indice: entrada.indice, motivo });
    else if (esPerfil) dePerfil.push(entrada as (typeof dePerfil)[number]);
    else dePartido.push(entrada as (typeof dePartido)[number]);
  }
  const escribir = opciones.escribir !== false;

  for (const partido of PARTY_IDS) {
    const propias = dePartido.filter(({ propuesta }) => propuesta.partido === partido);
    if (!propias.length) continue;
    const ruta = rutaFicha(opciones.sitio, 'partido', partido);
    if (!existsSync(ruta)) throw new Error(`No existe la ficha del partido ${partido}`);
    const ficha = JSON.parse(await readFile(ruta, 'utf8')) as FichaPartido;

    const existentes: Objeto[] = [...ficha.secciones.flatMap((seccion) => seccion.items), ...(ficha.descartados ?? []), ...(ficha.en_espera ?? [])];
    const vistas = new Set(existentes.flatMap(clavesDe));
    let siguiente = maxRef(existentes.map((item) => String(item.ref ?? ''))) + 1;

    // Fixed order of the additions: section order, then first canonical URL, then file and index.
    const ordenadas = propias
      .map((entrada) => ({ ...entrada, claves: clavesDe(entrada.propuesta.item) }))
      .sort(
        (a, b) =>
          SECCIONES.indexOf(a.propuesta.seccion as never) - SECCIONES.indexOf(b.propuesta.seccion as never) ||
          a.claves[0]!.localeCompare(b.claves[0]!) ||
          a.archivo.localeCompare(b.archivo) ||
          a.indice - b.indice,
      );
    const cambio: CambioArchivo = { ruta, partido, destino: 'partido', añadidos: [], duplicados: 0 };
    for (const { propuesta, claves } of ordenadas) {
      if (claves.some((clave) => vistas.has(clave))) {
        cambio.duplicados++;
        continue;
      }
      claves.forEach((clave) => vistas.add(clave));
      const ref = String(siguiente++);
      const item = ordenarItem(propuesta.item, ref);
      if (propuesta.en_espera) {
        (ficha.en_espera ??= []).push({ ...item, seccion: propuesta.seccion });
      } else {
        const seccion = ficha.secciones.find((s) => s.id === propuesta.seccion);
        if (!seccion) throw new Error(`La ficha de ${partido} no tiene la sección ${propuesta.seccion}`);
        seccion.items.push(item);
      }
      cambio.añadidos.push({ ref, seccion: propuesta.seccion, url: claves[0]!.split(' ')[0]!, ...(propuesta.en_espera ? { en_espera: true as const } : {}) });
    }
    if (cambio.añadidos.length && typeof ficha.corte === 'string' && ficha.corte < opciones.fecha) ficha.corte = opciones.fecha;
    if (cambio.añadidos.length || cambio.duplicados) plan.cambios.push(cambio);
    if (cambio.añadidos.length && escribir) await escribirJson(ruta, ficha);
  }

  // The validator requires the same periodo in all four perfiles: when anything is
  // added to any of them, periodo.hasta moves to the run date in all four.
  if (dePerfil.length) {
    const perfiles = new Map<string, { ruta: string; ficha: FichaPerfil; antes: string }>();
    for (const partido of PARTY_IDS) {
      const ruta = rutaFicha(opciones.sitio, 'perfil', partido);
      if (!existsSync(ruta)) throw new Error(`No existe el perfil del partido ${partido}`);
      const ficha = JSON.parse(await readFile(ruta, 'utf8')) as FichaPerfil;
      perfiles.set(partido, { ruta, ficha, antes: JSON.stringify(ficha) });
    }
    let hubo = false;
    for (const partido of PARTY_IDS) {
      const propias = dePerfil.filter(({ propuesta }) => propuesta.partido === partido);
      if (!propias.length) continue;
      const { ruta, ficha } = perfiles.get(partido)!;
      const resultado = fusionarPerfil(ficha, propias);
      plan.rechazados.push(...resultado.rechazados);
      if (resultado.añadidos.length) hubo = true;
      if (resultado.añadidos.length || resultado.duplicados) {
        plan.cambios.push({ ruta, partido, destino: 'perfil', añadidos: resultado.añadidos, duplicados: resultado.duplicados });
      }
    }
    if (hubo) {
      for (const { ruta, ficha, antes } of perfiles.values()) {
        if (ficha.periodo.hasta < opciones.fecha) ficha.periodo.hasta = opciones.fecha;
        // Only files whose data changed are written (the site formats them with Prettier).
        if (escribir && JSON.stringify(ficha) !== antes) await escribirJson(ruta, ficha);
      }
    }
  }
  plan.rechazados.sort((a, b) => a.archivo.localeCompare(b.archivo) || a.indice - b.indice);
  return plan;
}
