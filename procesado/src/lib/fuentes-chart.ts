/**
 * Geometry of the orientation rows (components/fuentes/Orientacion.astro): one
 * build-time SVG axis per published rating, never merged. MBFC places an emisor
 * on −10 (izquierda) … +10 (derecha) by content analysis; the CIS asks the public
 * to place it on 1 (más a la izquierda) … 10 (más a la derecha). Each scale gets
 * its own axis, ticks and labels. An emisor shows only the rows of the raters that
 * publish a value for it (`escalasConDato`); the /fuentes/ dot plots draw the empty
 * axis as their header. Pure functions of the local data.
 */
import { CIS_ESTUDIOS, type Cis, type CisEstudio, type Mbfc } from '../data/fuentes';
import { nf, nfSigno } from './format';

export type EscalaId = 'mbfc' | 'cis';

export interface Escala {
  min: number;
  max: number;
  /** Tick values, labelled under the axis. */
  ticks: readonly number[];
  /** Faint guide lines (MBFC label boundaries); none on the CIS scale. */
  bandas: readonly number[];
}

const ESCALAS: Record<EscalaId, Escala> = {
  mbfc: { min: -10, max: 10, ticks: [-10, -5, 0, 5, 10], bandas: [-5, -2, 2, 5] },
  cis: { min: 1, max: 10, ticks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], bandas: [] },
};

export function escala(kind: EscalaId): Escala {
  return ESCALAS[kind];
}

/** The scales that publish a value for an emisor, in fixed order (MBFC, then CIS); empty when none does. */
export function escalasConDato(emisor: { mbfc?: Mbfc; cis?: readonly Cis[] }): EscalaId[] {
  const escalas: EscalaId[] = [];
  if (emisor.mbfc) escalas.push('mbfc');
  if (emisor.cis && emisor.cis.length > 0) escalas.push('cis');
  return escalas;
}

/** x of `value` on a `width`-wide axis (min at 0, max at `width`); throws outside the scale. */
export function posicion(value: number, kind: EscalaId, width: number): number {
  const { min, max } = escala(kind);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${kind}: ${value} is outside ${min}…${max}`);
  }
  return ((value - min) / (max - min)) * width;
}

/** SVG size: a fixed viewBox, so every row of every emisor is drawn the same. */
export const LIENZO = {
  width: 320,
  /** Room left and right for the end ticks' labels and a dot at the edge. */
  pad: 14,
  axisY: 12,
  height: { completo: 32, compacto: 22 },
} as const;

export interface Tick {
  x: number;
  label: string;
}

export interface Punto {
  x: number;
  /** Filled for the most recent CIS study (and MBFC), hollow for the older one. */
  relleno: boolean;
}

export interface Fila {
  ticks: Tick[];
  bandas: number[];
  puntos: Punto[];
}

/** x inside the padded viewBox, rounded to 0.01 so the HTML stays short and stable. */
const x = (value: number, kind: EscalaId) => Math.round((LIENZO.pad + posicion(value, kind, LIENZO.width - 2 * LIENZO.pad)) * 100) / 100;

/** The empty axis of a scale: ticks and guide lines, no dots. */
function eje(kind: EscalaId): Fila {
  const { ticks, bandas } = escala(kind);
  const label = kind === 'mbfc' ? (value: number) => nfSigno(value, 0) : (value: number) => nf(value, 0);
  return {
    ticks: ticks.map((value) => ({ x: x(value, kind), label: label(value) })),
    bandas: bandas.map((value) => x(value, kind)),
    puntos: [],
  };
}

/** MBFC row: one dot at the published score; no dot without a score (or without a rating). */
export function filaMbfc(mbfc: Mbfc | undefined): Fila {
  const fila = eje('mbfc');
  if (mbfc?.puntuacion !== undefined) fila.puntos.push({ x: x(mbfc.puntuacion, 'mbfc'), relleno: true });
  return fila;
}

/** The most recent CIS study: the highest study number (CIS numbers its studies in order). */
export function estudioReciente(estudios: Record<string, CisEstudio> = CIS_ESTUDIOS): string {
  const keys = Object.keys(estudios).sort((a, b) => Number(b) - Number(a));
  if (keys.length === 0) throw new Error('fuentes.cis_estudios is empty');
  return keys[0]!;
}

/** Year of a CIS study, the last four-digit year of its fieldwork ("… de junio de 2025" → "2025"). */
export function anioEstudio(estudio: string, estudios: Record<string, CisEstudio> = CIS_ESTUDIOS): string {
  const campo = estudios[estudio]?.campo;
  const anio = campo?.match(/\d{4}(?!.*\d{4})/)?.[0];
  if (!anio) throw new Error(`fuentes.cis_estudios.${estudio}: no year in campo`);
  return anio;
}

/** An emisor's CIS values, most recent study first (same order in the chart's text and on every emisor). */
export function cisOrdenados(cis: Cis[] | undefined): Cis[] {
  return [...(cis ?? [])].sort((a, b) => Number(b.estudio) - Number(a.estudio));
}

/** CIS row: a filled dot for the most recent study, a hollow one for older studies. */
export function filaCis(cis: Cis[] | undefined, estudios: Record<string, CisEstudio> = CIS_ESTUDIOS): Fila {
  const fila = eje('cis');
  const reciente = estudioReciente(estudios);
  // Hollow dots first, so a filled dot at the same place stays visible inside the ring.
  for (const valor of cisOrdenados(cis).reverse()) {
    fila.puntos.push({ x: x(valor.media, 'cis'), relleno: valor.estudio === reciente });
  }
  return fila;
}
