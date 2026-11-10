import { describe, expect, it } from 'vitest';
import { SECCIONES } from './fusionar.ts';
import { IDS_PREGUNTA, PREGUNTAS, esCausa, esPregunta, motivoContexto, motivoPregunta, preguntaDe, preguntasDeSeccion } from './preguntas.ts';

const causa = { busqueda: 'diario-2026-11-10-causas' };

describe('PREGUNTAS', () => {
  it('has the eight questions in order', () => {
    expect(IDS_PREGUNTA).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8']);
  });

  it('covers every stored section, and only stored sections; only verificacion and historial serve two questions', () => {
    const usadas = IDS_PREGUNTA.flatMap((id) => [...PREGUNTAS[id].secciones]);
    expect([...new Set(usadas)].sort()).toEqual([...SECCIONES].sort());
    for (const seccion of SECCIONES) expect(preguntasDeSeccion(seccion)).toHaveLength(['verificacion', 'historial'].includes(seccion) ? 2 : 1);
    expect(preguntasDeSeccion('verificacion')).toEqual(['Q3', 'Q6']);
    expect(preguntasDeSeccion('historial')).toEqual(['Q4', 'Q8']);
    expect(preguntasDeSeccion('otra')).toEqual([]);
  });

  it('recognises question ids only', () => {
    expect(esPregunta('Q8')).toBe(true);
    expect(['Q0', 'Q9', 'q1', 'historial', null, undefined, 'toString'].some(esPregunta)).toBe(false);
  });
});

describe('preguntaDe', () => {
  it('gives each section its question, splits verificacion by bulo and historial by the causas search', () => {
    expect(preguntaDe('candidatura')).toBe('Q1');
    expect(preguntaDe('por-escrito')).toBe('Q2');
    expect(preguntaDe('historial')).toBe('Q4');
    expect(preguntaDe('historial', causa)).toBe('Q8');
    expect(preguntaDe('historial', { busqueda: 'diario-2026-11-10-criticos' })).toBe('Q4');
    expect(preguntaDe('cambios')).toBe('Q5');
    expect(preguntaDe('criticos-defensores')).toBe('Q6');
    expect(preguntaDe('encuestas')).toBe('Q7');
    expect(preguntaDe('verificacion', { afirmacion: 'Dijo X.' })).toBe('Q3');
    expect(preguntaDe('verificacion', { bulo: true })).toBe('Q6');
    expect(preguntaDe('tarjeta')).toBeUndefined();
    expect(esCausa(causa)).toBe(true);
  });
});

describe('motivoPregunta', () => {
  it('accepts a missing pregunta and a matching one', () => {
    expect(motivoPregunta(undefined, 'temas')).toBeUndefined();
    expect(motivoPregunta('Q2', 'temas')).toBeUndefined();
    expect(motivoPregunta('Q6', 'criticos-defensores', { postura: 'critico' })).toBeUndefined();
    expect(motivoPregunta('Q3', 'verificacion', { afirmacion: 'Dijo X.' })).toBeUndefined();
    expect(motivoPregunta('Q6', 'verificacion', { bulo: true })).toBeUndefined();
    expect(motivoPregunta('Q4', 'historial')).toBeUndefined();
    expect(motivoPregunta('Q8', 'historial', causa)).toBeUndefined();
  });

  it('rejects null, an unknown pregunta and one that does not match the section', () => {
    expect(motivoPregunta(null, 'temas')).toMatch(/no se propone/);
    expect(motivoPregunta('Q9', 'temas')).toBe('pregunta desconocida "Q9"');
    expect(motivoPregunta('Q2', 'historial')).toBe('pregunta Q2 (¿Qué dicen que harán?) no corresponde a la sección historial, que responde a Q4');
    expect(motivoPregunta('Q8', 'temas')).toMatch(/responde a Q2/);
  });

  it('rejects a bulo filed as the party’s own claim and a party claim filed as a bulo', () => {
    expect(motivoPregunta('Q3', 'verificacion', { bulo: true })).toMatch(/bulo sobre el partido responde a Q6/);
    expect(motivoPregunta('Q6', 'verificacion', { afirmacion: 'Dijo X.' })).toMatch(/sin "bulo": true/);
  });

  it('keeps court cases (Q8) apart from promise-versus-outcome items (Q4)', () => {
    expect(motivoPregunta('Q8', 'historial')).toMatch(/solo sale de esa búsqueda/);
    expect(motivoPregunta('Q4', 'historial', causa)).toMatch(/responde a Q8/);
  });
});

describe('motivoContexto', () => {
  it('accepts a context note without veredicto, in any section but verificacion', () => {
    expect(motivoContexto('temas', {})).toBeUndefined();
    expect(motivoContexto('temas', { contexto: true })).toBeUndefined();
    expect(motivoContexto('encuestas', { contexto: false })).toBeUndefined();
    expect(motivoContexto('verificacion', { contexto: false, veredicto: 'Respaldado' })).toBeUndefined();
  });

  it('rejects a non-boolean flag, a veredicto on a context note and a context note in verificacion', () => {
    expect(motivoContexto('temas', { contexto: 'sí' })).toBe('contexto debe ser true o false');
    expect(motivoContexto('historial', { contexto: true, veredicto: 'Sin datos' })).toBe('una nota de contexto no lleva veredicto');
    expect(motivoContexto('verificacion', { contexto: true })).toMatch(/no va en verificacion/);
  });
});
