/**
 * "De qué políticas habla en campaña": the topic donut on each home card, counted at build
 * time from the EFE/Europa Press wires in src/data/temas-items.json (temas.ts, method at
 * /metodologia/#temas). Only the eight topics with a fixed colour and at least `MIN_PCT` %
 * are shown; the rest fold into "Otros", with their names kept for the tooltip. Same rules
 * and colours for all five.
 */
import type { PartyId } from '../config';
import { countTemas, largestRemainder, validateTemas, type PartyTemas, type Share, type TemasData } from './temas';

export const MIN_PCT = 5;

/** Topic code -> label and fixed chart colour (`--s1`…`--s8`), identical on every card. */
export const TOPICS = {
  TRA: { label: 'Transporte', color: 'var(--s1)' },
  VIV: { label: 'Vivienda', color: 'var(--s2)' },
  COR: { label: 'Corrupción', color: 'var(--s3)' },
  SEG: { label: 'Seguridad', color: 'var(--s4)' },
  INM: { label: 'Inmigración', color: 'var(--s5)' },
  PEN: { label: 'Pensiones', color: 'var(--s6)' },
  ECO: { label: 'Economía e impuestos', color: 'var(--s7)' },
  EMP: { label: 'Empleo y salarios', color: 'var(--s8)' },
} as const;
export const OTHER_COLOR = 'var(--other)';

/** Short names of the topics without a colour (only listed inside "Otros"). */
const OTHER_LABELS: Record<string, string> = {
  SOC: 'Servicios sociales',
  TER: 'Modelo territorial',
  EDU: 'Educación',
  EXT: 'Exterior y defensa',
  MED: 'Energía y clima',
  SAN: 'Sanidad',
  IGU: 'Igualdad y derechos',
  OTR: 'Otros',
};

export interface FocusSlice {
  label: string;
  color: string;
  n: number;
  /** Whole percent, largest remainder: the slices of a donut add up to exactly 100. */
  pct: number;
  /** Only for "Otros": the topics folded into it. */
  detail?: string;
}

export interface Focus {
  /** Wires about public policy (the donut's base). */
  n: number;
  /** % of the party's wires about the campaign itself (excluded). */
  pctCampana: number;
  slices: FocusSlice[];
}

/** Builds one donut from `countTemas` output (shares already sorted by n, ties in fixed topic order). */
export function buildFocus(data: PartyTemas, othersLabel = 'Otros'): Focus {
  // The threshold compares exact counts, never rounded percentages.
  const isMain = (share: Share) => share.code in TOPICS && 100 * share.n >= MIN_PCT * data.n;
  const main = data.shares.filter(isMain);
  const rest = data.shares.filter((share) => !isMain(share));
  const slices: Omit<FocusSlice, 'pct'>[] = main.map((share) => ({ ...TOPICS[share.code as keyof typeof TOPICS], n: share.n }));
  const restN = rest.reduce((sum, share) => sum + share.n, 0);
  if (restN) {
    const detail = rest
      .map((share) => TOPICS[share.code as keyof typeof TOPICS]?.label ?? OTHER_LABELS[share.code] ?? share.code)
      .join(', ');
    slices.push({ label: othersLabel, color: OTHER_COLOR, n: restN, detail });
  }
  const pcts = largestRemainder(slices.map((slice) => slice.n));
  return {
    n: data.n,
    pctCampana: Math.round((100 * data.n_campana) / data.n_items),
    slices: slices.map((slice, index) => ({ ...slice, pct: pcts[index]! })),
  };
}

/**
 * The build gate and the donuts. In the site this block runs at module load on the
 * imported src/data/temas-items.json (`getFocus(id)`); this standalone copy takes the
 * raw data as an argument, because the repository publishes no data. Same code path:
 * validate, throw on any issue, count once, build each donut.
 */
export function crearGetFocus(raw: unknown): (id: PartyId, othersLabel?: string) => Focus {
  // The build gate: invalid topic data fails every page that draws a donut (and the tests).
  const issues = validateTemas(raw);
  if (issues.length) throw new Error(`src/data/temas-items.json is not publishable:\n${issues.join('\n')}`);
  const temas = raw as unknown as TemasData;
  const counts = countTemas(temas.items);
  return (id, othersLabel) => buildFocus(counts[id], othersLabel);
}
