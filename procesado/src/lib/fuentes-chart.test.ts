import { describe, expect, it } from 'vitest';
import type { CisEstudio, Mbfc } from '../data/fuentes';
import { anioEstudio, cisOrdenados, escala, escalasConDato, estudioReciente, filaCis, filaMbfc, LIENZO, posicion } from './fuentes-chart';

const ESTUDIOS: Record<string, CisEstudio> = {
  '3421': { titulo: 'Audiencias (I)', campo: '18 de septiembre – 16 de octubre de 2023', muestra: 27433, url: 'https://www.cis.es/a' },
  '3511': { titulo: 'Audiencias (II)', campo: '8 de mayo – 12 de junio de 2025', muestra: 15017, url: 'https://www.cis.es/b' },
};

const mbfc = (puntuacion?: number): Mbfc => ({
  sesgo: 'Left-Center',
  ...(puntuacion === undefined ? {} : { puntuacion }),
  factual: 'High',
  credibilidad: 'High',
  fecha: '2025-12-11',
  consultado: '2026-11-09',
  url: 'https://mediabiasfactcheck.com/x/',
});
const cis = (estudio: string, media: number) => ({ estudio, media, de: 2.4, n: 1000, consultado: '2026-11-09' });

const inner = LIENZO.width - 2 * LIENZO.pad;

describe('escala', () => {
  it('keeps MBFC and CIS as separate scales', () => {
    expect(escala('mbfc')).toMatchObject({ min: -10, max: 10, ticks: [-10, -5, 0, 5, 10], bandas: [-5, -2, 2, 5] });
    expect(escala('cis')).toMatchObject({ min: 1, max: 10, bandas: [] });
    expect(escala('cis').ticks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('escalasConDato', () => {
  it('lists only the raters with a value, MBFC first', () => {
    expect(escalasConDato({})).toEqual([]);
    expect(escalasConDato({ cis: [] })).toEqual([]);
    expect(escalasConDato({ mbfc: mbfc() })).toEqual(['mbfc']);
    expect(escalasConDato({ cis: [cis('3511', 4.6)] })).toEqual(['cis']);
    expect(escalasConDato({ cis: [cis('3511', 4.6)], mbfc: mbfc(-3) })).toEqual(['mbfc', 'cis']);
  });
});

describe('posicion', () => {
  it('maps the ends and the middle of each scale', () => {
    expect(posicion(-10, 'mbfc', 200)).toBe(0);
    expect(posicion(0, 'mbfc', 200)).toBe(100);
    expect(posicion(10, 'mbfc', 200)).toBe(200);
    expect(posicion(1, 'cis', 90)).toBe(0);
    expect(posicion(5.5, 'cis', 90)).toBe(45);
    expect(posicion(10, 'cis', 90)).toBe(90);
  });

  it('throws outside the scale', () => {
    expect(() => posicion(10.1, 'mbfc', 100)).toThrow(RangeError);
    expect(() => posicion(0.9, 'cis', 100)).toThrow(RangeError);
    expect(() => posicion(Number.NaN, 'cis', 100)).toThrow(RangeError);
  });
});

describe('filaMbfc', () => {
  it('draws the axis with signed tick labels and band lines', () => {
    const fila = filaMbfc(undefined);
    expect(fila.ticks.map((tick) => tick.label)).toEqual(['−10', '−5', '0', '+5', '+10']);
    expect(fila.ticks[0]!.x).toBe(LIENZO.pad);
    expect(fila.ticks.at(-1)!.x).toBe(LIENZO.width - LIENZO.pad);
    expect(fila.bandas).toHaveLength(4);
    expect(fila.puntos).toEqual([]);
  });

  it('puts one filled dot at the score', () => {
    expect(filaMbfc(mbfc(-3)).puntos).toEqual([{ x: 116.2, relleno: true }]);
  });

  it('draws no dot when MBFC publishes only the label', () => {
    expect(filaMbfc(mbfc()).puntos).toEqual([]);
  });
});

describe('CIS studies', () => {
  it('takes the highest study number as the most recent', () => {
    expect(estudioReciente(ESTUDIOS)).toBe('3511');
  });

  it('reads the year from the fieldwork', () => {
    expect(anioEstudio('3511', ESTUDIOS)).toBe('2025');
    expect(anioEstudio('3421', ESTUDIOS)).toBe('2023');
    expect(() => anioEstudio('9999', ESTUDIOS)).toThrow();
  });

  it('orders an emisor’s values most recent first', () => {
    expect(cisOrdenados([cis('3421', 4), cis('3511', 5)]).map((c) => c.estudio)).toEqual(['3511', '3421']);
    expect(cisOrdenados(undefined)).toEqual([]);
  });
});

describe('filaCis', () => {
  it('fills the most recent study and draws the older one hollow, underneath', () => {
    const fila = filaCis([cis('3511', 5.5), cis('3421', 1)], ESTUDIOS);
    expect(fila.puntos).toEqual([
      { x: LIENZO.pad, relleno: false },
      { x: LIENZO.pad + inner / 2, relleno: true },
    ]);
  });

  it('keeps an older study hollow when it is the only one', () => {
    expect(filaCis([cis('3421', 10)], ESTUDIOS).puntos).toEqual([{ x: LIENZO.width - LIENZO.pad, relleno: false }]);
  });

  it('keeps the empty axis without data', () => {
    const fila = filaCis(undefined, ESTUDIOS);
    expect(fila.ticks.map((tick) => tick.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(fila.puntos).toEqual([]);
  });
});
