/**
 * The topic counts behind the home donuts, computed at build time from the item list in
 * src/data/temas-items.json (method at /metodologia/#temas). The JSON is the only part an
 * agent updates; everything here is deterministic: no clock, no randomness, fixed order.
 *
 * Unit: one "evento" (an act or statement). Wires that report the same evento (EFE and
 * Europa Press doubles) share its slug and count once; a joint wire counts once for each
 * party in `partidos`. `validateTemas` returns one readable message per broken rule; the
 * build fails on any (focus.ts throws when the data is loaded).
 */
import { PARTY_IDS, type PartyId } from '../config';

/** Every topic code, in the fixed order used to break ties: the eight coloured topics, the rest, then the campaign. */
export const TEMA_CODES = [
  'TRA',
  'VIV',
  'COR',
  'SEG',
  'INM',
  'PEN',
  'ECO',
  'EMP',
  'SOC',
  'TER',
  'EDU',
  'EXT',
  'MED',
  'SAN',
  'IGU',
  'OTR',
  'POL',
] as const;
export type TemaCode = (typeof TEMA_CODES)[number];

/** "Política, partidos y campaña": counted in `n_campana`, excluded from the donut's base. */
export const CAMPAIGN: TemaCode = 'POL';

export const AGENCIAS = ['EFE', 'Europa Press', 'desconocida'] as const;

export interface TemaItem {
  /** `<fecha>-<slug of the URL>`. */
  id: string;
  fecha: string;
  partidos: PartyId[];
  titulo: string;
  url: string;
  agencia: (typeof AGENCIAS)[number];
  tema: TemaCode;
  /** Slug shared by every wire about the same act or statement (by convention, the id of its first wire). */
  evento: string;
}

export interface TemasData {
  periodo: { desde: string; hasta: string };
  metodo: string;
  items: TemaItem[];
}

export interface Share {
  code: TemaCode;
  n: number;
  /** One decimal, largest remainder: the shares of a party add up to exactly 100. */
  pct: number;
}

export interface PartyTemas {
  /** Eventos about the party. */
  n_items: number;
  /** Eventos about the campaign itself (`CAMPAIGN`), excluded from the donut. */
  n_campana: number;
  /** Eventos about public policy: the donut's base. */
  n: number;
  /** Policy topics only, by n (desc), ties in `TEMA_CODES` order. */
  shares: Share[];
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELDS = ['id', 'fecha', 'partidos', 'titulo', 'url', 'agencia', 'tema', 'evento'];
const DAY = 86_400_000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isHttps = (url: unknown) => typeof url === 'string' && /^https:\/\/\S+$/.test(url);
const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const temaIndex = (code: string) => TEMA_CODES.indexOf(code as TemaCode);

/**
 * Rounds `counts` to percentages with `decimals` decimals that add up to exactly 100
 * (largest remainder). Ties go to the earlier index, so pass the counts in a fixed order.
 */
export function largestRemainder(counts: readonly number[], decimals = 0): number[] {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (!total) return counts.map(() => 0);
  const unit = 10 ** decimals;
  const exact = counts.map((n) => (100 * unit * n) / total);
  const floors = exact.map(Math.floor);
  let left = 100 * unit - floors.reduce((sum, n) => sum + n, 0);
  const order = exact.map((value, index) => ({ index, rest: value - floors[index]! })).sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left-- <= 0) break;
    floors[index]! += 1;
  }
  return floors.map((n) => n / unit);
}

/** Every broken rule in the topic data, as readable messages; empty when it can be published. */
export function validateTemas(raw: unknown): string[] {
  if (!isObject(raw)) return ['temas-items: not an object'];
  const issues: string[] = [];
  const periodo = isObject(raw.periodo) ? raw.periodo : {};
  const { desde, hasta } = periodo;
  if (!isIsoDate(desde) || !isIsoDate(hasta) || desde > hasta) issues.push('temas-items: periodo needs ISO desde <= hasta');
  if (!isText(raw.metodo)) issues.push('temas-items: missing metodo');
  if (!Array.isArray(raw.items) || !raw.items.length) return [...issues, 'temas-items: items must be a non-empty list'];

  const ids = new Set<string>();
  const urls = new Set<string>();
  const eventos = new Map<string, { tema: unknown; fechas: string[] }>();
  raw.items.forEach((item, index) => {
    const where = `temas-items[${isObject(item) && isText(item.id) ? item.id : `#${index + 1}`}]`;
    if (!isObject(item)) return issues.push(`${where}: not an object`);
    for (const field of Object.keys(item)) if (!FIELDS.includes(field)) issues.push(`${where}: unknown field ${field}`);

    if (!isText(item.id) || !SLUG.test(item.id)) issues.push(`${where}: id is not a slug`);
    else if (ids.has(item.id)) issues.push(`${where}: duplicate id`);
    else ids.add(item.id);

    if (!isIsoDate(item.fecha)) issues.push(`${where}: fecha is not an ISO date`);
    else {
      if (isIsoDate(desde) && isIsoDate(hasta) && (item.fecha < desde || item.fecha > hasta))
        issues.push(`${where}: fecha ${item.fecha} is outside the periodo`);
      if (isText(item.id) && !item.id.startsWith(`${item.fecha}-`)) issues.push(`${where}: id does not start with its fecha`);
    }

    const partidos = Array.isArray(item.partidos) ? item.partidos : [];
    if (!partidos.length) issues.push(`${where}: partidos must be a non-empty list`);
    for (const partido of partidos)
      if (!PARTY_IDS.includes(partido as never)) issues.push(`${where}: unknown partido "${String(partido)}"`);
    if (new Set(partidos).size !== partidos.length) issues.push(`${where}: repeated partido`);

    if (!isText(item.titulo)) issues.push(`${where}: missing titulo`);
    if (!isHttps(item.url)) issues.push(`${where}: url is not https`);
    else if (urls.has(item.url as string)) issues.push(`${where}: duplicate url`);
    else urls.add(item.url as string);
    if (!AGENCIAS.includes(item.agencia as never)) issues.push(`${where}: agencia "${String(item.agencia)}"`);
    if (temaIndex(String(item.tema)) < 0) issues.push(`${where}: tema "${String(item.tema)}" is not in the taxonomy`);

    if (!isText(item.evento) || !SLUG.test(item.evento)) return issues.push(`${where}: evento is not a slug`);
    const evento = eventos.get(item.evento) ?? { tema: item.tema, fechas: [] };
    if (evento.tema !== item.tema)
      issues.push(`${where}: tema ${String(item.tema)} differs from evento ${item.evento} (${String(evento.tema)})`);
    if (isIsoDate(item.fecha)) evento.fechas.push(item.fecha);
    eventos.set(item.evento, evento);
  });

  for (const [slug, { fechas }] of eventos) {
    const sorted = [...fechas].sort();
    if (sorted.length > 1 && Date.parse(sorted.at(-1)!) - Date.parse(sorted[0]!) > DAY)
      issues.push(`temas-items: evento ${slug} spans more than one day (${sorted[0]} to ${sorted.at(-1)})`);
  }
  if (!issues.length) {
    const counts = countTemas(raw.items as TemaItem[]);
    for (const id of PARTY_IDS) if (!counts[id].n) issues.push(`temas-items: ${id} has no policy evento (empty donut)`);
  }
  return issues;
}

/** Per party: unique eventos, how many are about the campaign, and the policy shares. Input order is irrelevant. */
export function countTemas(items: readonly TemaItem[]): Record<PartyId, PartyTemas> {
  const eventos = new Map<string, { tema: TemaCode; partidos: Set<PartyId> }>();
  for (const item of items) {
    const evento = eventos.get(item.evento) ?? { tema: item.tema, partidos: new Set<PartyId>() };
    for (const partido of item.partidos) evento.partidos.add(partido);
    eventos.set(item.evento, evento);
  }
  const result = {} as Record<PartyId, PartyTemas>;
  for (const id of PARTY_IDS) {
    const temas = [...eventos.values()].filter((evento) => evento.partidos.has(id)).map((evento) => evento.tema);
    const byCode = new Map<TemaCode, number>();
    for (const tema of temas) if (tema !== CAMPAIGN) byCode.set(tema, (byCode.get(tema) ?? 0) + 1);
    const counted = [...byCode].sort(([a, na], [b, nb]) => nb - na || temaIndex(a) - temaIndex(b));
    const pcts = largestRemainder(
      counted.map(([, n]) => n),
      1,
    );
    const n = temas.length - temas.filter((tema) => tema === CAMPAIGN).length;
    result[id] = {
      n_items: temas.length,
      n_campana: temas.length - n,
      n,
      shares: counted.map(([code, count], index) => ({ code, n: count, pct: pcts[index]! })),
    };
  }
  return result;
}
