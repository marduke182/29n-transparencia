/**
 * Typed access to fuentes.json: the registry of every emisor (the site a source
 * link points to) cited in the party files, with only published external
 * ratings (Media Bias/Fact Check and the CIS audience studies). We never label
 * an emisor ourselves; a missing rating is shown as "sin dato". The JSON is
 * edited by hand or by the data agents and is loosely typed: `validateFuentes`
 * (lib/fuentes.ts) checks its shape and rules, and the build fails on any issue.
 *
 * Standalone copy: types only. The site fills the four constants at the end from
 * fuentes.json; here they are empty, because this repository publishes no data.
 * Every function that reads them takes the data as an argument, and the tests
 * always pass fixtures.
 */
import type { PartyId } from '../config';

/** Emisor kinds, in the order the site lists them. Only the first three can carry ratings. */
export const TIPOS_EMISOR = ['medio', 'verificador', 'agencia', 'oficial', 'partido', 'datos'] as const;
export type TipoEmisor = (typeof TIPOS_EMISOR)[number];

/** Kinds that may carry MBFC or CIS ratings. */
export const TIPOS_CON_VALORACION: readonly TipoEmisor[] = ['medio', 'verificador', 'agencia'];

export const MBFC_SESGOS = ['Left', 'Left-Center', 'Least Biased', 'Right-Center', 'Right'] as const;
export type MbfcSesgo = (typeof MBFC_SESGOS)[number];

export const MBFC_NIVELES = ['Very High', 'High', 'Mostly Factual', 'Mixed', 'Medium', 'Low', 'Very Low'] as const;
export type MbfcNivel = (typeof MBFC_NIVELES)[number];

/** Whether automated clients (our collectors, search indexes) can read a party's website: all of it, only part (e.g. its feed), or none. */
export const ESTADOS_ACCESO = ['abierto', 'parcial', 'bloqueado'] as const;
export type EstadoAcceso = (typeof ESTADOS_ACCESO)[number];

/** Result of a dated check of a party website with an automated client; shown alike for all five parties. */
export interface Acceso {
  estado: EstadoAcceso;
  /** ISO date of the check. */
  comprobado: string;
  /** What the site answered, stated as fact ("Responde 403 a clientes automatizados"). */
  detalle: string;
}

/**
 * How the daily collection agents read an emisor: its feed or sitemap, an API,
 * an HTML listing page ("seccion"),
 * a web search (the default when `recogida` is absent), or not at all
 * ("omitir": out of scope, data-only, or blocking bots).
 */
export const METODOS_RECOGIDA = ['sitemap', 'rss', 'api', 'seccion', 'busqueda', 'omitir'] as const;
export type MetodoRecogida = (typeof METODOS_RECOGIDA)[number];

export interface Recogida {
  metodo: MetodoRecogida;
  /** The feed, sitemap or API endpoint to poll. */
  url?: string;
  nota?: string;
}

export interface Mbfc {
  sesgo: MbfcSesgo;
  /** −10 (extreme left) … +10 (extreme right); absent when MBFC publishes only the label. */
  puntuacion?: number;
  factual: MbfcNivel;
  credibilidad: MbfcNivel;
  /** MBFC's "Questionable" flag. */
  cuestionable?: true;
  /** ISO date of MBFC's last update of the page. */
  fecha: string;
  /** ISO date we read the value. */
  consultado: string;
  url: string;
}

/** CIS question P22: mean placement on 1 (más a la izquierda) … 10 (más a la derecha). */
export interface Cis {
  /** A key of CIS_ESTUDIOS. */
  estudio: string;
  media: number;
  /** Standard deviation. */
  de: number;
  /** Valid answers. */
  n: number;
  /** ISO date we read the value. */
  consultado: string;
}

export interface Emisor {
  /** Slug, used as the anchor on /fuentes/ and in popover ids. */
  id: string;
  nombre: string;
  /** Exact URL hosts, lowercase and without `www.`. */
  hosts: string[];
  tipo: TipoEmisor;
  /** Only on tipo "partido": the party whose website it is. Every party has exactly one, cited or not. */
  partido?: PartyId;
  /** Only on tipo "partido", and required there: can automated clients read the website? */
  acceso?: Acceso;
  /** Owner, from its own legal notice. */
  titular?: { nombre: string; url: string };
  nota?: string;
  mbfc?: Mbfc;
  cis?: Cis[];
  /** Collection method for the daily agents; absent means web search. */
  recogida?: Recogida;
}

export interface MbfcInfo {
  nombre: string;
  metodologia: string;
}

export interface CisEstudio {
  titulo: string;
  /** Fieldwork dates, as shown. */
  campo: string;
  muestra: number;
  url: string;
  /** Published data file, when there is one. */
  datos?: string;
}

/** The raw file, before validation. Empty here (the site imports fuentes.json). */
export const RAW_FUENTES: unknown = undefined;

export const MBFC: MbfcInfo = { nombre: '', metodologia: '' };
export const CIS_ESTUDIOS: Record<string, CisEstudio> = {};
export const EMISORES: Emisor[] = [];
