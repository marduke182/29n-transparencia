import { describe, expect, it } from 'vitest';
import { fechaCorta, fechaDiaMes, nf, nfFijo, nfSigno, nfSignoFijo } from './format';

describe('fechaCorta', () => {
  it('writes the short Spanish date', () => {
    expect(fechaCorta('2026-11-09')).toBe('9 nov 2026');
  });
});

describe('nf', () => {
  it('uses a decimal comma and groups thousands', () => {
    expect(nf(10.18, 2)).toBe('10,18');
    expect(nf(2591.2, 0)).toBe('2.591');
  });
});

describe('fechaDiaMes', () => {
  it('drops the year', () => {
    expect(fechaDiaMes('2026-11-09')).toBe('9 nov');
  });
});

describe('nfSigno', () => {
  it('writes a real minus sign, a plus sign and a decimal comma', () => {
    expect(nfSigno(-3.1)).toBe('\u22123,1');
    expect(nfSigno(2.5)).toBe('+2,5');
    expect(nfSigno(10, 0)).toBe('+10');
  });

  it('writes zero without a sign, also when rounding reaches it', () => {
    expect(nfSigno(0)).toBe('0');
    expect(nfSigno(-0.04)).toBe('0');
  });
});

describe('nfFijo', () => {
  it('keeps trailing zeros to exactly the given decimals', () => {
    expect(nfFijo(4.6, 2)).toBe('4,60');
    expect(nfFijo(2.2, 2)).toBe('2,20');
    expect(nfFijo(5.123, 2)).toBe('5,12');
    expect(nfFijo(8288, 0)).toBe('8.288');
  });
});

describe('nfSignoFijo', () => {
  it('signs and keeps exactly the given decimals', () => {
    expect(nfSignoFijo(8)).toBe('+8,0');
    expect(nfSignoFijo(-0.5)).toBe('\u22120,5');
    expect(nfSignoFijo(6.6)).toBe('+6,6');
  });

  it('writes zero without a sign, also when rounding reaches it', () => {
    expect(nfSignoFijo(0)).toBe('0,0');
    expect(nfSignoFijo(-0.04)).toBe('0,0');
  });
});
