/**
 * Source registry helpers for the /fuentes/ page and the source popovers. An
 * emisor is the site a link points to, matched by exact URL host (`www.`
 * stripped): diariodeavisos.elespanol.com is not elespanol.com. Agencies named
 * in a source's text are credited to the linking site. Everything here is a
 * pure function of the local data (no clock, no randomness), so the build is
 * deterministic. `validateFuentes` is the gate for edits to fuentes.json: it
 * returns one readable message per broken rule, and the build fails on any.
 */
import {
  EMISORES,
  ESTADOS_ACCESO,
  METODOS_RECOGIDA,
  MBFC_NIVELES,
  MBFC_SESGOS,
  RAW_FUENTES,
  TIPOS_CON_VALORACION,
  TIPOS_EMISOR,
  type Emisor,
  type MbfcSesgo,
} from '../data/fuentes';
import { PARTY_IDS, type PartyId } from '../config';
import type { Partido } from './partidos';

/** The host of a URL, lowercase and without `www.`; '' when the URL can't be parsed. */
export function hostDe(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const indices = new WeakMap<Emisor[], Map<string, Emisor>>();

/** host → emisor, built once per registry (the first emisor wins; the validator flags repeats). */
function indice(emisores: Emisor[]): Map<string, Emisor> {
  let byHost = indices.get(emisores);
  if (!byHost) {
    byHost = new Map();
    for (const emisor of emisores) for (const host of emisor.hosts) if (!byHost.has(host)) byHost.set(host, emisor);
    indices.set(emisores, byHost);
  }
  return byHost;
}

export function emisorDe(url: string, emisores: Emisor[] = EMISORES): Emisor | undefined {
  return indice(emisores).get(hostDe(url));
}

/** A party's own website emisor (the validator guarantees exactly one per party). */
export function webDePartido(partido: PartyId, emisores: Emisor[] = EMISORES): Emisor | undefined {
  return emisores.find((emisor) => emisor.tipo === 'partido' && emisor.partido === partido);
}

/** Every link of a party file, with where it is; only item `fuentes` are counted per party. */
function enlaces(partido: Partido): { url: string; where: string; cuenta: boolean }[] {
  const { tarjeta } = partido;
  const links = [
    { url: tarjeta.fuente_lema, where: `${partido.id}.tarjeta.fuente_lema`, cuenta: false },
    { url: tarjeta.fuente_propuesta, where: `${partido.id}.tarjeta.fuente_propuesta`, cuenta: false },
    ...(tarjeta.fuentes_propuesta ?? []).map((url, index) => ({
      url,
      where: `${partido.id}.tarjeta.fuentes_propuesta[${index + 1}]`,
      cuenta: false,
    })),
  ];
  for (const seccion of partido.secciones) {
    for (const item of seccion.items) {
      const where = `${partido.id}.${seccion.id}.${item.ref}`;
      item.fuentes.forEach((fuente, index) => links.push({ url: fuente.url, where: `${where}.fuentes[${index + 1}]`, cuenta: true }));
      if (item.cita) links.push({ url: item.cita.url, where: `${where}.cita`, cuenta: false });
    }
  }
  return links;
}

const ceros = () => Object.fromEntries(PARTY_IDS.map((id) => [id, 0])) as Record<PartyId, number>;

/** Item sources per emisor and party: every emisor of the registry, in its order, zeros included. */
export function citasPorEmisor(partidos: Partido[], emisores: Emisor[] = EMISORES): Map<string, Record<PartyId, number>> {
  const counts = new Map(emisores.map((emisor) => [emisor.id, ceros()]));
  for (const partido of partidos) {
    for (const { url, cuenta } of enlaces(partido)) {
      const emisor = cuenta ? emisorDe(url, emisores) : undefined;
      const row = emisor && counts.get(emisor.id);
      if (row) row[partido.id] += 1;
    }
  }
  return counts;
}

/** Fixed collator, so the order never depends on the runtime's default locale. */
const COLLATOR = new Intl.Collator('es');

/** Site order: by kind (TIPOS_EMISOR), then name (es collation), then id. */
export function compararEmisores(a: Emisor, b: Emisor): number {
  return (
    TIPOS_EMISOR.indexOf(a.tipo) - TIPOS_EMISOR.indexOf(b.tipo) || COLLATOR.compare(a.nombre, b.nombre) || COLLATOR.compare(a.id, b.id)
  );
}

/** The emisores behind some links, without repeats, in site order; unknown hosts are dropped. */
export function emisoresDe(urls: string[], emisores: Emisor[] = EMISORES): Emisor[] {
  const found = new Set(urls.map((url) => emisorDe(url, emisores)).filter((emisor) => emisor !== undefined));
  return [...found].sort(compararEmisores);
}

/** Score range of each MBFC label (one decimal, as MBFC publishes it). */
export const MBFC_BANDAS: Record<MbfcSesgo, [number, number]> = {
  Left: [-10, -5],
  'Left-Center': [-4.9, -2],
  'Least Biased': [-1.9, 1.9],
  'Right-Center': [2, 4.9],
  Right: [5, 10],
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isHttps = (url: unknown): url is string => typeof url === 'string' && /^https:\/\/\S+$/.test(url);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** A real calendar date written YYYY-MM-DD (2026-02-30 is rejected). */
const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T);

function checkKeys(where: string, value: Record<string, unknown>, allowed: string[], issues: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push(`${where}: unknown field "${key}"`);
}

/** Shape of `mbfc` and `cis_estudios`; returns the known study keys. */
function validateMeta(registro: unknown, issues: string[]): Set<string> {
  const meta = isObject(registro) ? registro : {};
  const mbfc = isObject(meta.mbfc) ? meta.mbfc : {};
  if (!isText(mbfc.nombre)) issues.push('fuentes.mbfc: missing nombre');
  if (!isHttps(mbfc.metodologia)) issues.push('fuentes.mbfc: metodologia is not an https URL');

  const estudios = new Set<string>();
  if (!isObject(meta.cis_estudios)) issues.push('fuentes.cis_estudios: must be an object');
  else {
    for (const [key, estudio] of Object.entries(meta.cis_estudios)) {
      const where = `fuentes.cis_estudios.${key}`;
      if (!/^\d+$/.test(key)) issues.push(`${where}: the key must be the CIS study number (digits only)`);
      if (!isObject(estudio)) {
        issues.push(`${where}: must be an object`);
        continue;
      }
      checkKeys(where, estudio, ['titulo', 'campo', 'muestra', 'url', 'datos'], issues);
      if (!isText(estudio.titulo)) issues.push(`${where}: missing titulo`);
      if (!isText(estudio.campo)) issues.push(`${where}: missing campo`);
      else if (!/\b\d{4}\b/.test(estudio.campo)) issues.push(`${where}: campo must include the four-digit year`);
      if (!(Number.isInteger(estudio.muestra) && (estudio.muestra as number) > 0)) {
        issues.push(`${where}: muestra must be a positive integer`);
      }
      if (!isHttps(estudio.url)) issues.push(`${where}: url is not an https URL`);
      if (estudio.datos !== undefined && !isHttps(estudio.datos)) issues.push(`${where}: datos is not an https URL`);
      estudios.add(key);
    }
  }
  return estudios;
}

function validateMbfc(where: string, mbfc: unknown, issues: string[]) {
  if (!isObject(mbfc)) {
    issues.push(`${where}: mbfc must be an object`);
    return;
  }
  checkKeys(where, mbfc, ['sesgo', 'puntuacion', 'factual', 'credibilidad', 'cuestionable', 'fecha', 'consultado', 'url'], issues);
  if (!isOneOf(MBFC_SESGOS, mbfc.sesgo))
    issues.push(`${where}: MBFC sesgo "${String(mbfc.sesgo)}" is not one of ${MBFC_SESGOS.join(', ')}`);
  for (const field of ['factual', 'credibilidad']) {
    if (!isOneOf(MBFC_NIVELES, mbfc[field])) {
      issues.push(`${where}: MBFC ${field} "${String(mbfc[field])}" is not one of ${MBFC_NIVELES.join(', ')}`);
    }
  }
  if (mbfc.cuestionable !== undefined && mbfc.cuestionable !== true) issues.push(`${where}: MBFC cuestionable must be true when present`);
  if (mbfc.puntuacion !== undefined) {
    if (!isNumber(mbfc.puntuacion)) issues.push(`${where}: MBFC puntuacion must be a number`);
    else if (isOneOf(MBFC_SESGOS, mbfc.sesgo)) {
      const [min, max] = MBFC_BANDAS[mbfc.sesgo];
      if (!(mbfc.puntuacion >= min && mbfc.puntuacion <= max)) {
        issues.push(`${where}: MBFC score ${mbfc.puntuacion} is outside ${mbfc.sesgo} (${min}..${max})`);
      }
    }
  }
  if (!isHttps(mbfc.url) || hostDe(mbfc.url) !== 'mediabiasfactcheck.com') {
    issues.push(`${where}: MBFC url must be https on mediabiasfactcheck.com`);
  }
  if (!isIsoDate(mbfc.fecha)) issues.push(`${where}: MBFC fecha is not an ISO date`);
  if (!isIsoDate(mbfc.consultado)) issues.push(`${where}: MBFC consultado is not an ISO date`);
}

function validateCis(where: string, cis: unknown, estudiosConocidos: Set<string>, issues: string[]) {
  if (!Array.isArray(cis)) {
    issues.push(`${where}: cis must be a list`);
    return;
  }
  const estudios = new Set<unknown>();
  cis.forEach((entry, index) => {
    const at = `${where}.cis[${index + 1}]`;
    if (!isObject(entry)) {
      issues.push(`${at}: must be an object`);
      return;
    }
    checkKeys(at, entry, ['estudio', 'media', 'de', 'n', 'consultado'], issues);
    if (typeof entry.estudio !== 'string' || !estudiosConocidos.has(entry.estudio)) {
      issues.push(`${at}: unknown CIS study ${String(entry.estudio)}`);
    }
    if (estudios.has(entry.estudio)) issues.push(`${at}: CIS study ${String(entry.estudio)} listed twice`);
    estudios.add(entry.estudio);
    if (!(isNumber(entry.media) && entry.media >= 1 && entry.media <= 10)) {
      issues.push(`${at}: CIS media ${String(entry.media)} is outside 1..10`);
    }
    if (!(isNumber(entry.de) && entry.de >= 0)) issues.push(`${at}: CIS de must be a number ≥ 0`);
    if (!(Number.isInteger(entry.n) && (entry.n as number) > 0)) issues.push(`${at}: CIS n must be a positive integer`);
    if (!isIsoDate(entry.consultado)) issues.push(`${at}: CIS consultado is not an ISO date`);
  });
}

function validateAcceso(where: string, acceso: unknown, issues: string[]) {
  if (!isObject(acceso)) {
    issues.push(`${where}: acceso must be an object`);
    return;
  }
  checkKeys(`${where}.acceso`, acceso, ['estado', 'comprobado', 'detalle'], issues);
  if (!isOneOf(ESTADOS_ACCESO, acceso.estado)) {
    issues.push(`${where}: acceso.estado "${String(acceso.estado)}" is not one of ${ESTADOS_ACCESO.join(', ')}`);
  }
  if (!isIsoDate(acceso.comprobado)) issues.push(`${where}: acceso.comprobado is not an ISO date`);
  if (!isText(acceso.detalle)) issues.push(`${where}: acceso.detalle must be text`);
}

function validateRecogida(where: string, recogida: unknown, issues: string[]) {
  if (!isObject(recogida)) {
    issues.push(`${where}: recogida must be an object`);
    return;
  }
  checkKeys(`${where}.recogida`, recogida, ['metodo', 'url', 'nota'], issues);
  if (!isOneOf(METODOS_RECOGIDA, recogida.metodo)) {
    issues.push(`${where}: recogida.metodo "${String(recogida.metodo)}" is not one of ${METODOS_RECOGIDA.join(', ')}`);
  }
  if (recogida.url !== undefined && !isHttps(recogida.url)) issues.push(`${where}: recogida.url is not an https URL`);
  if (recogida.nota !== undefined && !isText(recogida.nota)) issues.push(`${where}: recogida.nota must be text`);
}

/** Shape and rules of one emisor; true when it is safe to use for host lookups. */
function validateEmisor(where: string, emisor: Record<string, unknown>, estudios: Set<string>, issues: string[]): boolean {
  checkKeys(where, emisor, ['id', 'nombre', 'hosts', 'tipo', 'partido', 'acceso', 'titular', 'nota', 'mbfc', 'cis', 'recogida'], issues);
  if (typeof emisor.id !== 'string' || !SLUG.test(emisor.id)) issues.push(`${where}: id is not a slug`);
  if (!isText(emisor.nombre)) issues.push(`${where}: missing nombre`);
  if (!isOneOf(TIPOS_EMISOR, emisor.tipo)) issues.push(`${where}: tipo "${String(emisor.tipo)}" is not one of ${TIPOS_EMISOR.join(', ')}`);
  if (emisor.tipo === 'partido') {
    if (!isOneOf(PARTY_IDS, emisor.partido)) {
      issues.push(`${where}: partido "${String(emisor.partido)}" is not one of ${PARTY_IDS.join(', ')}`);
    }
    if (emisor.acceso === undefined) issues.push(`${where}: missing acceso (the dated check of the party website)`);
    else validateAcceso(where, emisor.acceso, issues);
  } else {
    if (emisor.partido !== undefined) issues.push(`${where}: partido is only allowed on tipo partido`);
    if (emisor.acceso !== undefined) issues.push(`${where}: acceso is only allowed on tipo partido`);
  }
  if (emisor.recogida !== undefined) validateRecogida(where, emisor.recogida, issues);
  if (emisor.nota !== undefined && !isText(emisor.nota)) issues.push(`${where}: nota must be text`);
  if (emisor.titular !== undefined) {
    const titular = isObject(emisor.titular) ? emisor.titular : {};
    if (isObject(emisor.titular)) checkKeys(`${where}.titular`, titular, ['nombre', 'url'], issues);
    if (!isText(titular.nombre)) issues.push(`${where}: titular without nombre`);
    if (!isHttps(titular.url)) issues.push(`${where}: titular.url is not an https URL`);
  }

  const hosts = Array.isArray(emisor.hosts) && emisor.hosts.length && emisor.hosts.every(isText);
  if (!hosts) issues.push(`${where}: hosts must be a non-empty list of hosts`);

  if ((emisor.mbfc !== undefined || emisor.cis !== undefined) && !isOneOf(TIPOS_CON_VALORACION, emisor.tipo)) {
    issues.push(`${where}: ratings are only allowed on ${TIPOS_CON_VALORACION.join(', ')} (tipo is ${String(emisor.tipo)})`);
  }
  if (emisor.mbfc !== undefined) validateMbfc(where, emisor.mbfc, issues);
  if (emisor.cis !== undefined) validateCis(where, emisor.cis, estudios, issues);

  return Boolean(hosts) && typeof emisor.id === 'string';
}

/**
 * Every rule of the registry: shape and enums (so a malformed JSON edit fails
 * with a readable message), ratings, and the links of the party files (every
 * linked host has exactly one emisor; every emisor is linked, except the party
 * websites). Every party has exactly one website emisor (tipo "partido"), cited
 * or not, so all four are always listed alike. `registro` is
 * the whole fuentes.json, for `mbfc` and `cis_estudios`.
 */
export function validateFuentes(emisores: unknown, partidos: Partido[], registro: unknown = RAW_FUENTES): string[] {
  const issues: string[] = [];
  const estudios = validateMeta(registro, issues);
  if (!Array.isArray(emisores)) return [...issues, 'fuentes.emisores: must be a list'];

  const usables: Emisor[] = [];
  const ids = new Set<string>();
  const hostOwner = new Map<string, string>();
  emisores.forEach((emisor: unknown, index) => {
    if (!isObject(emisor)) {
      issues.push(`fuentes.emisores[${index + 1}]: must be an object`);
      return;
    }
    const where = `fuentes.${typeof emisor.id === 'string' ? emisor.id : `emisores[${index + 1}]`}`;
    if (!validateEmisor(where, emisor, estudios, issues)) return;
    const valid = emisor as unknown as Emisor;
    if (ids.has(valid.id)) issues.push(`${where}: duplicate id`);
    ids.add(valid.id);
    for (const host of valid.hosts) {
      if (hostDe(`https://${host}/`) !== host) issues.push(`${where}: host "${host}" must be lowercase, without www.`);
      const owner = hostOwner.get(host);
      if (owner !== undefined) issues.push(`${where}: host "${host}" is already under ${owner}`);
      else hostOwner.set(host, valid.id);
    }
    usables.push(valid);
  });

  const citados = new Set<string>();
  for (const partido of partidos) {
    for (const { url, where } of enlaces(partido)) {
      const emisor = emisorDe(url, usables);
      if (emisor) citados.add(emisor.id);
      else issues.push(`${where}: no emisor for host "${hostDe(url)}" (${url})`);
    }
  }
  for (const emisor of usables) {
    if (emisor.tipo !== 'partido' && !citados.has(emisor.id)) issues.push(`fuentes.${emisor.id}: not linked from any party file`);
  }
  for (const party of PARTY_IDS) {
    const webs = usables.filter((emisor) => emisor.tipo === 'partido' && emisor.partido === party).map((emisor) => emisor.id);
    if (webs.length !== 1) {
      issues.push(
        `fuentes: ${party} needs exactly one partido emisor (its website), found ${webs.length}${webs.length ? ` (${webs.join(', ')})` : ''}`,
      );
    }
  }

  return issues;
}
