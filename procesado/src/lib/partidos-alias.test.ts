import { describe, expect, it } from 'vitest';
import { PARTY_IDS } from '../config';
import { CLAVES_ALIAS, getPartidosAlias, validatePartidosAlias } from './partidos-alias';

const entrada = (nombres: string[], extra: Record<string, unknown> = {}) => ({
  nombres,
  marcas_regionales: [],
  miembros: [],
  personas: [],
  excluir: [],
  ...extra,
});
const valido = () => ({
  'frente-amplio': entrada(['Frente Amplio'], { miembros: ['IU'] }),
  podemos: entrada(['Podemos']),
  pp: entrada(['PP']),
  psoe: entrada(['PSOE']),
  vox: entrada(['Vox']),
});

describe('validatePartidosAlias', () => {
  it('accepts a valid file, with the five parties and the same fields for each', () => {
    // The site checks its shipped data/partidos-alias.json here; this standalone copy uses the fixture.
    expect(validatePartidosAlias(valido())).toEqual([]);
    const alias = getPartidosAlias(valido());
    expect(Object.keys(alias).sort()).toEqual([...PARTY_IDS].sort());
    for (const party of PARTY_IDS) expect(Object.keys(alias[party]).sort()).toEqual([...CLAVES_ALIAS].sort());
  });

  it('accepts a minimal valid file', () => {
    expect(validatePartidosAlias(valido())).toEqual([]);
  });

  it('requires an object with exactly the five party ids', () => {
    expect(validatePartidosAlias([])).toEqual(['partidos-alias: must be an object keyed by party id']);
    const { vox: _, ...sinVox } = valido();
    expect(validatePartidosAlias(sinVox)).toEqual(['partidos-alias.vox: missing']);
    expect(validatePartidosAlias({ ...valido(), sumar: entrada(['Sumar']) })).toEqual(['partidos-alias: unknown party "sumar"']);
  });

  it('requires the five lists, of trimmed non-empty text, and at least one name', () => {
    const data = valido();
    data.pp = entrada([], { personas: [' Feijóo', ''], excluir: 'x', apodos: [] });
    const issues = validatePartidosAlias(data).join('\n');
    expect(issues).toMatch(/pp: unknown field "apodos"/);
    expect(issues).toMatch(/pp.personas: " Feijóo" must be non-empty text/);
    expect(issues).toMatch(/pp.personas: "" must be non-empty text/);
    expect(issues).toMatch(/pp.excluir: must be a list/);
    expect(issues).toMatch(/pp.nombres: needs at least one name/);
  });

  it('rejects repeats inside a party and strings under two parties, ignoring case', () => {
    const data = valido();
    data.psoe = entrada(['PSOE', 'psoe']);
    data.podemos = entrada(['Podemos'], { excluir: ['iu'] });
    const issues = validatePartidosAlias(data);
    expect(issues).toContain('partidos-alias.psoe.nombres: "psoe" is repeated');
    expect(issues).toContain('partidos-alias.podemos.excluir: "iu" is also under frente-amplio');
  });

  it('throws with every issue from getPartidosAlias', () => {
    expect(() => getPartidosAlias({})).toThrow(/partidos-alias.frente-amplio: missing/);
  });
});
