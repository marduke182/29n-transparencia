/**
 * Party ids shared by every module. Copied from the site's src/config.ts (only the
 * party settings; site URL and dates are left out).
 */

/** Party ids, alphabetical by short name: the fixed order of every count and table. */
export const PARTY_IDS = ['frente-amplio', 'podemos', 'pp', 'psoe', 'vox'] as const;
export type PartyId = (typeof PARTY_IDS)[number];

/** Display names used everywhere (cards, headings, nav, lists). */
export const PARTY_SHORT: Record<PartyId, string> = {
  'frente-amplio': 'Frente Amplio',
  podemos: 'Podemos',
  pp: 'PP',
  psoe: 'PSOE',
  vox: 'Vox',
};
