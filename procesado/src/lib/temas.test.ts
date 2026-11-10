import { describe, expect, it } from 'vitest';
import { PARTY_IDS } from '../config';
import { countTemas, largestRemainder, validateTemas, type TemaItem } from './temas';

let seq = 0;
function item(overrides: Partial<TemaItem> = {}): TemaItem {
  seq += 1;
  const fecha = overrides.fecha ?? '2026-10-10';
  const id = overrides.id ?? `${fecha}-teletipo-${seq}`;
  return {
    id,
    fecha,
    partidos: ['pp'],
    titulo: `Teletipo ${seq}`,
    url: `https://www.infobae.com/espana/agencias/x/${seq}/`,
    agencia: 'desconocida',
    tema: 'VIV',
    evento: id,
    ...overrides,
  };
}

/** One policy evento per party, so the "empty donut" rule stays quiet in rule tests. */
const baseline = () => PARTY_IDS.map((id) => item({ partidos: [id], tema: 'TRA' }));
const doc = (items: unknown[]) => ({ periodo: { desde: '2026-10-05', hasta: '2026-11-08' }, metodo: 'Recuento.', items });

/**
 * A fixture sample in place of the site's temas-items.json (not published here): every
 * party, several topics, campaign items, EFE/Europa Press doubles of one evento and a
 * joint wire for two parties.
 */
function muestra(): TemaItem[] {
  const items: TemaItem[] = [];
  const temas = ['VIV', 'TRA', 'ECO', 'SAN', 'POL', 'INM', 'VIV', 'POL', 'EXT', 'PEN'] as const;
  PARTY_IDS.forEach((partido, p) => {
    temas.slice(0, 5 + p).forEach((tema, t) => {
      const wire = item({ partidos: [partido], tema, fecha: `2026-10-${String(10 + t).padStart(2, '0')}` });
      items.push(wire);
      if (t % 3 === 0) items.push(item({ partidos: [partido], tema, fecha: wire.fecha, evento: wire.evento, agencia: 'EFE' }));
    });
  });
  items.push(item({ partidos: ['pp', 'vox'], tema: 'POL', agencia: 'Europa Press' }));
  return items;
}
const data = { items: muestra() };

describe('largestRemainder', () => {
  it('adds up to exactly 100 and breaks ties by position', () => {
    expect(largestRemainder([1, 1, 1])).toEqual([34, 33, 33]);
    expect(largestRemainder([2, 2, 2, 1, 1, 1])).toEqual([23, 22, 22, 11, 11, 11]);
    expect(largestRemainder([1, 1, 1], 1)).toEqual([33.4, 33.3, 33.3]);
    expect(largestRemainder([0, 0])).toEqual([0, 0]);
  });
  it('sums to 100 for any split', () => {
    for (let total = 1; total <= 40; total += 1) {
      for (let first = 0; first <= total; first += 1) {
        const counts = [first, Math.floor((total - first) / 3), total - first - Math.floor((total - first) / 3)];
        expect(largestRemainder(counts).reduce((a, b) => a + b, 0)).toBe(100);
        expect(Math.round(largestRemainder(counts, 1).reduce((a, b) => a + b, 0) * 10)).toBe(1000);
      }
    }
  });
});

describe('countTemas', () => {
  it('counts an evento once, however many wires report it', () => {
    const a = item({ tema: 'VIV' });
    const b = item({ tema: 'VIV', evento: a.evento });
    const c = item({ tema: 'TRA' });
    const pp = countTemas([a, b, c]).pp;
    expect(pp).toMatchObject({ n_items: 2, n_campana: 0, n: 2 });
    expect(pp.shares).toEqual([
      { code: 'TRA', n: 1, pct: 50 },
      { code: 'VIV', n: 1, pct: 50 },
    ]);
  });

  it('counts a joint wire for every party, and an evento for every party of any of its wires', () => {
    const joint = item({ partidos: ['pp', 'vox'], tema: 'POL' });
    const double = item({ partidos: ['vox'], tema: 'POL', evento: joint.evento });
    const counts = countTemas([joint, double]);
    expect(counts.pp).toMatchObject({ n_items: 1, n_campana: 1, n: 0, shares: [] });
    expect(counts.vox).toMatchObject({ n_items: 1, n_campana: 1, n: 0 });
    expect(counts.psoe.n_items).toBe(0);
  });

  it('is deterministic and ignores input order', () => {
    const first = countTemas(data.items);
    expect(countTemas(data.items)).toEqual(first);
    expect(countTemas([...data.items].reverse())).toEqual(first);
    const shuffled = [...data.items].sort((a, b) => a.url.length - b.url.length || b.id.localeCompare(a.id));
    expect(countTemas(shuffled)).toEqual(first);
  });

  it('gives each party shares that add up to 100 %', () => {
    for (const party of Object.values(countTemas(data.items))) {
      expect(Math.round(party.shares.reduce((sum, share) => sum + share.pct, 0) * 10)).toBe(1000);
      expect(party.shares.reduce((sum, share) => sum + share.n, 0)).toBe(party.n);
      expect(party.n_items).toBe(party.n + party.n_campana);
    }
  });
});

describe('validateTemas', () => {
  it('accepts the fixture sample', () => {
    expect(validateTemas(doc(data.items))).toEqual([]);
  });

  it('accepts a minimal valid document', () => {
    expect(validateTemas(doc(baseline()))).toEqual([]);
  });

  const cases: [string, unknown[], RegExp][] = [
    ['a missing titulo', [item({ titulo: '' })], /missing titulo/],
    ['an unknown party', [item({ partidos: ['sumar' as never] })], /unknown partido "sumar"/],
    ['no party', [item({ partidos: [] })], /partidos must be a non-empty list/],
    ['a repeated party', [item({ partidos: ['pp', 'pp'] })], /repeated partido/],
    ['a tema outside the taxonomy', [item({ tema: 'XYZ' as never })], /tema "XYZ" is not in the taxonomy/],
    ['a date that is not ISO', [item({ fecha: '10/10/2026', id: 'a-b' })], /fecha is not an ISO date/],
    ['an impossible date', [item({ fecha: '2026-02-30' })], /fecha is not an ISO date/],
    ['a date outside the periodo', [item({ fecha: '2026-11-09' })], /outside the periodo/],
    ['an id without its fecha', [item({ id: '2026-10-11-x', evento: 'x' })], /id does not start with its fecha/],
    ['an http URL', [item({ url: 'http://example.com/a' })], /url is not https/],
    ['an unknown agencia', [item({ agencia: 'Reuters' as never })], /agencia "Reuters"/],
    ['an unknown field', [{ ...item(), topic: 'VIV' }], /unknown field topic/],
    ['an evento that is not a slug', [item({ evento: 'Mismo Acto' })], /evento is not a slug/],
    ['an id that is not a slug', [item({ id: '2026-10-10-Á' })], /id is not a slug/],
  ];
  it.each(cases)('rejects %s', (_, items, message) => {
    expect(validateTemas(doc([...baseline(), ...items])).join('\n')).toMatch(message);
  });

  it('rejects duplicate ids and URLs', () => {
    const a = item();
    const issues = validateTemas(doc([...baseline(), a, { ...a }])).join('\n');
    expect(issues).toMatch(/duplicate id/);
    const b = item({ url: a.url });
    expect(validateTemas(doc([...baseline(), a, b])).join('\n')).toMatch(/duplicate url/);
  });

  it('rejects an evento whose wires have different temas or are more than a day apart', () => {
    const a = item({ tema: 'VIV' });
    expect(validateTemas(doc([...baseline(), a, item({ tema: 'SEG', evento: a.evento })])).join('\n')).toMatch(
      /tema SEG differs from evento/,
    );
    expect(validateTemas(doc([...baseline(), a, item({ fecha: '2026-10-11', evento: a.evento })]))).toEqual([]);
    expect(validateTemas(doc([...baseline(), a, item({ fecha: '2026-10-12', evento: a.evento })])).join('\n')).toMatch(
      /spans more than one day/,
    );
  });

  it('rejects a party without any policy evento', () => {
    const items = baseline().filter((i) => i.partidos[0] !== 'podemos');
    expect(validateTemas(doc(items))).toEqual(['temas-items: podemos has no policy evento (empty donut)']);
  });

  it('rejects a broken periodo or document', () => {
    expect(validateTemas({ ...doc(baseline()), periodo: { desde: '2026-11-08', hasta: '2026-10-05' } }).join('\n')).toMatch(/periodo/);
    expect(validateTemas(doc([]))).toContain('temas-items: items must be a non-empty list');
    expect(validateTemas(null)).toEqual(['temas-items: not an object']);
  });
});
