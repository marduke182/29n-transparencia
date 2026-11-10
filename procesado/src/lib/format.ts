/** Spanish number and date formatting shared by pages and charts. */

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

/** "2026-11-09" -> "9 nov 2026". */
export function fechaCorta(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${MESES[(month ?? 1) - 1]} ${year}`;
}

/** Spanish number: decimal comma, thousands dot, up to `digits` decimals. */
export function nf(value: number, digits = 1): string {
  return value.toLocaleString('es-ES', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
    useGrouping: 'always',
  } as Intl.NumberFormatOptions);
}

/** "2026-11-09" -> "9 nov" (for "a 9 nov" notes next to a visible full date). */
export function fechaDiaMes(iso: string): string {
  return fechaCorta(iso).replace(/ \d{4}$/, '');
}

/** Spanish number with exactly `digits` decimals ("4,60", "2,20"): for published values whose precision matters. */
export function nfFijo(value: number, digits: number): string {
  return value.toLocaleString('es-ES', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    useGrouping: 'always',
  } as Intl.NumberFormatOptions);
}

/** Signed Spanish number with exactly `digits` decimals: "+8,0", "−0,5", and "0,0" without a sign. */
export function nfSignoFijo(value: number, digits = 1): string {
  const text = nfFijo(Math.abs(value), digits);
  if (text === nfFijo(0, digits)) return text;
  return `${value < 0 ? '−' : '+'}${text}`;
}

/** Signed Spanish number for scales centred on 0: "−3,1" (U+2212 minus), "+2", "0". */
export function nfSigno(value: number, digits = 1): string {
  const text = nf(Math.abs(value), digits);
  if (text === '0') return '0';
  return `${value < 0 ? '−' : '+'}${text}`;
}
