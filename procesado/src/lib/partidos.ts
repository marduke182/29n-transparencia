/**
 * Types of the party files (one JSON per party, same schema for all four). The files
 * are validated by `validatePartido` (validate.ts). Standalone copy: the site's
 * version also imports the four JSON files (`RAW_PARTIDOS`, `getPartido`,
 * `getPartidos`); those are left out because this repository publishes no data.
 */
import type { PartyId } from '../config';

export const ESTADOS = ['VERIFICADO', 'CORREGIDO', 'PARCIAL'] as const;
export type Estado = (typeof ESTADOS)[number];

export const VEREDICTOS = ['Respaldado', 'Matizable', 'Engañoso', 'Sin datos'] as const;
export type Veredicto = (typeof VEREDICTOS)[number];

export const PERFILES = ['interno', 'externo'] as const;
export type Perfil = (typeof PERFILES)[number];

export type Postura = 'critico' | 'defensor';

/** The nine sections of every party page: ids and titles are fixed, in this order. */
export const SECCIONES = [
  { id: 'candidatura', titulo: 'Candidato/a, lista y alianzas' },
  { id: 'lema-y-frases', titulo: 'Lema y frases de campaña' },
  { id: 'temas', titulo: 'Temas principales y qué evitan' },
  { id: 'por-escrito', titulo: 'Lo que hay por escrito' },
  { id: 'verificacion', titulo: 'Verificación de afirmaciones' },
  { id: 'historial', titulo: 'Historial: lo prometido frente a lo hecho' },
  { id: 'cambios', titulo: 'Cambios de discurso' },
  { id: 'criticos-defensores', titulo: 'Lo que dicen críticos y defensores' },
  { id: 'encuestas', titulo: 'Encuestas y escenarios' },
] as const;
export type SeccionId = (typeof SECCIONES)[number]['id'];

export interface Fuente {
  url: string;
  medio: string;
}

export interface Item {
  ref: string;
  texto: string;
  estado: Estado;
  matiz?: string;
  fuentes: Fuente[];
  cita?: { texto: string; url: string };
  atribucion?: string;
  /** Only in `verificacion`. */
  veredicto?: Veredicto;
  afirmacion?: string;
  /** Only in `verificacion`: a hoax about the party, shown under "Verificaciones sobre el partido". */
  bulo?: boolean;
  /** Only in `cambios`. */
  antes?: string;
  ahora?: string;
  /** Only in `criticos-defensores`. */
  postura?: Postura;
  perfil?: Perfil;
}

export interface Seccion {
  id: SeccionId;
  titulo: string;
  items: Item[];
  /** Only in `verificacion`: the note shown when there are no hoax checks. */
  nota_bulos?: string;
}

export interface Partido {
  id: PartyId;
  nombre: string;
  /** ISO date. */
  corte: string;
  tarjeta: {
    candidato: string;
    lema: string;
    fuente_lema: string;
    que_propone: string;
    fuente_propuesta: string;
    fuentes_propuesta?: string[];
  };
  secciones: Seccion[];
  pendientes: string[];
  /** Audit trail only: never rendered. */
  descartados?: unknown[];
}

export function getSeccion(partido: Partido, id: SeccionId): Seccion {
  return partido.secciones.find((seccion) => seccion.id === id) ?? { id, titulo: '', items: [] };
}

/** Every source link of the card's proposal, the main one first, without repeats. */
export function propuestaFuentes(tarjeta: Partido['tarjeta']): string[] {
  return [...new Set([tarjeta.fuente_propuesta, ...(tarjeta.fuentes_propuesta ?? [])].filter(Boolean))];
}
