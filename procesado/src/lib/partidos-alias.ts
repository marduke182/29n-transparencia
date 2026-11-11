/**
 * Party aliases (data/partidos-alias.json) for the daily data agents and coverage
 * searches: the names, regional brands, member parties (coalitions), people and
 * look-alike names to exclude for each party. Not rendered on the site. Same
 * structure for all four parties; `validatePartidosAlias` is the gate for edits.
 */
import { PARTY_IDS, type PartyId } from '../config';

export const CLAVES_ALIAS = ['nombres', 'marcas_regionales', 'miembros', 'personas', 'excluir'] as const;
export type ClaveAlias = (typeof CLAVES_ALIAS)[number];
export type AliasPartido = Record<ClaveAlias, string[]>;

/** The site imports data/partidos-alias.json here; this standalone copy publishes no data, so pass it to `getPartidosAlias`. */
export const RAW_PARTIDOS_ALIAS: unknown = undefined;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Shape and rules: exactly the four party ids, each with exactly the five lists of
 * non-empty, trimmed strings; at least one name; no repeats inside a party, and no
 * string under two parties (case-insensitive), so a match never credits two parties.
 */
export function validatePartidosAlias(data: unknown): string[] {
  if (!isObject(data)) return ['partidos-alias: must be an object keyed by party id'];
  const issues: string[] = [];
  for (const key of Object.keys(data)) {
    if (!(PARTY_IDS as readonly string[]).includes(key)) issues.push(`partidos-alias: unknown party "${key}"`);
  }
  const owner = new Map<string, string>();
  for (const party of PARTY_IDS) {
    const entry = data[party];
    if (!isObject(entry)) {
      issues.push(`partidos-alias.${party}: missing`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!(CLAVES_ALIAS as readonly string[]).includes(key)) issues.push(`partidos-alias.${party}: unknown field "${key}"`);
    }
    const vistos = new Set<string>();
    for (const clave of CLAVES_ALIAS) {
      const where = `partidos-alias.${party}.${clave}`;
      const list = entry[clave];
      if (!Array.isArray(list)) {
        issues.push(`${where}: must be a list`);
        continue;
      }
      list.forEach((value: unknown) => {
        if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
          issues.push(`${where}: "${String(value)}" must be non-empty text without outer spaces`);
          return;
        }
        const norm = value.toLocaleLowerCase('es');
        if (vistos.has(norm)) issues.push(`${where}: "${value}" is repeated`);
        vistos.add(norm);
        const other = owner.get(norm);
        if (other !== undefined && other !== party) issues.push(`${where}: "${value}" is also under ${other}`);
        else owner.set(norm, party);
      });
    }
    if (Array.isArray(entry.nombres) && entry.nombres.length === 0) issues.push(`partidos-alias.${party}.nombres: needs at least one name`);
  }
  return issues;
}

/** The validated aliases; throws with every issue when the JSON breaks a rule. */
export function getPartidosAlias(data: unknown = RAW_PARTIDOS_ALIAS): Record<PartyId, AliasPartido> {
  const issues = validatePartidosAlias(data);
  if (issues.length) throw new Error(`src/data/partidos-alias.json is not valid:\n${issues.join('\n')}`);
  return data as Record<PartyId, AliasPartido>;
}
