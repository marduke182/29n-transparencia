import { describe, expect, it } from 'vitest';
import { PARTY_IDS } from '../config';
import { buildFocus, crearGetFocus, MIN_PCT, OTHER_COLOR, TOPICS } from './focus';
import { CAMPAIGN, TEMA_CODES, type TemaItem } from './temas';

/**
 * Fixture topic data in place of the site's temas-items.json (not published here):
 * per party, a few policy wires of mixed topics (one below 5 %), campaign wires and a
 * double of one evento.
 */
function wires(): TemaItem[] {
  const items: TemaItem[] = [];
  let seq = 0;
  const add = (partido: (typeof PARTY_IDS)[number], tema: TemaItem['tema'], evento?: string) => {
    seq += 1;
    const id = `2026-10-10-w${seq}`;
    items.push({ id, fecha: '2026-10-10', partidos: [partido], titulo: `T${seq}`, url: `https://example.com/w/${seq}`, agencia: 'EFE', tema, evento: evento ?? id });
    return id;
  };
  PARTY_IDS.forEach((partido, p) => {
    for (let i = 0; i < 6 + p; i += 1) add(partido, 'VIV');
    for (let i = 0; i < 4; i += 1) add(partido, 'TRA');
    for (let i = 0; i < 3; i += 1) add(partido, 'EXT');
    for (let i = 0; i < 2 * p + 1; i += 1) add(partido, 'POL');
    const first = add(partido, 'ECO');
    add(partido, 'ECO', first);
    for (let i = 0; i < 6; i += 1) add(partido, 'SAN');
    for (let i = 0; i < 10 + p; i += 1) add(partido, 'PEN');
    if (p === 0) for (let i = 0; i < 15; i += 1) add(partido, 'MED');
  });
  return items;
}
const getFocus = crearGetFocus({ periodo: { desde: '2026-10-05', hasta: '2026-11-08' }, metodo: 'Fixture.', items: wires() });

describe('buildFocus', () => {
  it('keeps coloured topics at or above 5 % and folds the rest into Otros', () => {
    const focus = buildFocus({
      n_items: 40,
      n_campana: 20,
      n: 20,
      shares: [
        { code: 'VIV', n: 10, pct: 50 },
        { code: 'EXT', n: 6, pct: 30 },
        { code: 'TRA', n: 3, pct: 15 },
        { code: 'PEN', n: 1, pct: 5 },
      ],
    });
    expect(focus.pctCampana).toBe(50);
    expect(focus.slices.map((slice) => [slice.label, slice.n, slice.pct])).toEqual([
      ['Vivienda', 10, 50],
      ['Transporte', 3, 15],
      ['Pensiones', 1, 5],
      ['Otros', 6, 30],
    ]);
    expect(focus.slices.at(-1)).toMatchObject({ color: OTHER_COLOR, detail: 'Exterior y defensa' });
  });

  it('applies the threshold to exact counts and rounds the slices to 100', () => {
    // 1 of 21 is 4.76 %: below 5 % even though it would display as 5.
    const focus = buildFocus({
      n_items: 21,
      n_campana: 0,
      n: 21,
      shares: [
        { code: 'VIV', n: 10, pct: 47.6 },
        { code: 'TRA', n: 10, pct: 47.6 },
        { code: 'PEN', n: 1, pct: 4.8 },
      ],
    });
    expect(focus.slices.map((slice) => [slice.label, slice.pct])).toEqual([
      ['Vivienda', 48],
      ['Transporte', 47],
      ['Otros', 5],
    ]);
  });
});

it('has a label for every topic code but the campaign', () => {
  expect(TEMA_CODES.slice(0, 8)).toEqual(Object.keys(TOPICS));
  const focus = buildFocus({
    n_items: 9,
    n_campana: 0,
    n: 9,
    shares: TEMA_CODES.filter((code) => code !== CAMPAIGN && !(code in TOPICS)).map((code) => ({ code, n: 1, pct: 0 })),
  });
  expect(focus.slices.at(-1)?.detail?.split(', ')).toHaveLength(8);
  expect(focus.slices.at(-1)?.detail).not.toMatch(/\b[A-Z]{3}\b/);
});

describe.each(PARTY_IDS)('getFocus(%s)', (id) => {
  const focus = getFocus(id);
  it('adds up to the base and to 100 %', () => {
    expect(focus.slices.reduce((sum, slice) => sum + slice.n, 0)).toBe(focus.n);
    expect(focus.slices.reduce((sum, slice) => sum + slice.pct, 0)).toBe(100);
  });
  it('shows only topics with a fixed colour and at least 5 %', () => {
    for (const slice of focus.slices.filter((s) => s.color !== OTHER_COLOR)) {
      expect(slice.color).toMatch(/^var\(--s[1-8]\)$/);
      expect(100 * slice.n).toBeGreaterThanOrEqual(MIN_PCT * focus.n);
    }
  });
  it('is deterministic', () => {
    expect(getFocus(id)).toEqual(focus);
  });
});

it('matches the fixture bases', () => {
  // Bases exclude POL; a double of one evento counts once.
  expect(PARTY_IDS.map((id) => getFocus(id).n)).toEqual([45, 32, 34, 36]);
});

it('throws on data that breaks a rule (the build gate)', () => {
  expect(() => crearGetFocus({ periodo: { desde: '2026-10-05', hasta: '2026-11-08' }, metodo: 'x', items: [] })).toThrow(/not publishable/);
});
