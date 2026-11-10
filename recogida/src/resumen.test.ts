import { describe, expect, it } from 'vitest';
import { PARTY_IDS, PARTY_SHORT, resumen, type EntradaResumen } from './resumen.ts';

const item = (ref: string, extra: Record<string, unknown> = {}) => ({
  ref,
  texto: `Texto del elemento ${ref}.`,
  estado: 'PARCIAL',
  matiz: 'Según el relato de un medio.',
  fuentes: [{ url: 'https://diario.es/2026/11/01/nota.html', medio: 'Diario' }],
  ...extra,
});

const ficha = (items: Record<string, unknown[]>, extra: Record<string, unknown> = {}) => ({
  id: 'pp',
  tarjeta: { lema: 'Lema', fuente_lema: 'https://diario.es/2026/11/01/lema.html' },
  secciones: Object.entries(items).map(([id, its]) => ({ id, items: its })),
  pendientes: [],
  ...extra,
});

const entrada: EntradaResumen = {
  fecha: '2026-11-10',
  antes: {
    partidos: {
      pp: ficha({ temas: [item('2.1'), item('2.2')], 'criticos-defensores': [item('N1', { postura: 'critico' })] }),
    },
    perfiles: {},
  },
  despues: {
    partidos: {
      pp: ficha(
        {
          temas: [item('2.1', { texto: 'Texto corregido del elemento 2.1.' }), item('2.3', { estado: 'VERIFICADO', fuentes: [{ url: 'https://boe.es/a', medio: 'BOE' }] })],
          'criticos-defensores': [item('N1', { postura: 'critico' }), item('N2', { postura: 'defensor' })],
        },
        {
          descartados: [{ ref: '2.2', estado: 'NO VERIFICABLE', motivo: 'No se pudo abrir.' }],
          en_espera: [item('7.1', { seccion: 'cambios', texto: 'Cambio pendiente de la transcripción.' })],
        },
      ),
    },
    perfiles: {},
  },
  buzon: { pp: [{ url: 'https://diario.es/2026/11/09/otra.html', titulo: 'Otra nota', fecha: '2026-11-09' }] },
  emisores: [
    { nombre: 'Diario', hosts: ['diario.es'], tipo: 'medio' },
    { nombre: 'BOE', hosts: ['boe.es'], tipo: 'oficial' },
  ],
};

const ENCABEZADOS = [
  'Añadidos',
  'Modificados',
  'Pasados a descartados',
  'Pasados a en espera',
  'Retirados sin rastro',
  'PARCIAL solo con prensa',
  'Fuentes nuevas',
  'Buzón',
  'Recuentos',
];

describe('resumen', () => {
  it('da la misma salida en dos ejecuciones', () => {
    expect(resumen(structuredClone(entrada))).toBe(resumen(structuredClone(entrada)));
  });

  it('usa el orden de partidos de cache.ts, el mismo que el del sitio', () => {
    expect(PARTY_IDS).toEqual(['frente-amplio', 'podemos', 'pp', 'psoe', 'vox']);
  });

  it('pinta todos los encabezados para cada partido aunque no haya datos, en el orden de PARTY_IDS', () => {
    const md = resumen({ fecha: '2026-11-10', antes: { partidos: {}, perfiles: {} }, despues: { partidos: {}, perfiles: {} } });
    const partidos = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(partidos).toEqual(PARTY_IDS.map((id) => PARTY_SHORT[id]));
    const bloques = md.split(/^## /m).slice(1);
    for (const bloque of bloques) {
      const encabezados = [...bloque.matchAll(/^### (.+?)(?: \(.*\))?$/gm)].map((m) => m[1]);
      expect(encabezados).toEqual(ENCABEZADOS);
    }
  });

  it('agrupa añadidos, cambios y descartes por pregunta, sección y estado', () => {
    const pp = resumen(entrada).split(/^## /m).find((b) => b.startsWith('PP'))!;
    expect(pp).toContain('### Añadidos (2)\n\n- **Q2 · ¿Qué dicen que harán?** (1)\n  - `temas` · VERIFICADO (1)\n    - 2.3');
    expect(pp).toContain('- **Q6 · ¿Qué dicen de ellos?** (1)\n  - `criticos-defensores` · PARCIAL (1)\n    - N2');
    expect(pp).toContain('### Modificados (1)');
    expect(pp).toContain('    - 2.1: campos: texto');
    expect(pp).toContain('### Pasados a descartados (1)\n\n- **Q2 · ¿Qué dicen que harán?** (1)\n  - `temas` · NO VERIFICABLE (1)\n    - 2.2: No se pudo abrir.');
    expect(pp).toContain('### Pasados a en espera (1)\n\n- **Q5 · ¿Han cambiado de opinión?** (1)\n  - `cambios` · PARCIAL (1)\n    - 7.1: Cambio pendiente de la transcripción.');
    expect(pp).toContain('### Retirados sin rastro (0)');
  });

  it('separa verificacion en Q3 y Q6 (por bulo) e historial en Q4 y Q8 (por la búsqueda de causas), en el orden de las preguntas', () => {
    const conVerificacion: EntradaResumen = {
      fecha: '2026-11-10',
      antes: { partidos: { pp: ficha({ verificacion: [] }) }, perfiles: {} },
      despues: {
        partidos: { pp: ficha({ verificacion: [item('V2', { bulo: true }), item('V1', { afirmacion: 'Dijo X.' })], encuestas: [item('E1')], historial: [item('C1', { busqueda: 'diario-2026-11-10-causas' })] }) },
        perfiles: {},
      },
    };
    const pp = resumen(conVerificacion).split(/^## /m).find((b) => b.startsWith('PP'))!;
    const anadidos = pp.slice(pp.indexOf('### Añadidos'), pp.indexOf('### Modificados'));
    expect(anadidos).toBe(
      [
        '### Añadidos (4)',
        '',
        '- **Q3 · ¿Lo que dicen es cierto?** (1)',
        '  - `verificacion` · PARCIAL (1)',
        '    - V1: Texto del elemento V1.',
        '- **Q6 · ¿Qué dicen de ellos?** (1)',
        '  - `verificacion` · PARCIAL (1)',
        '    - V2: Texto del elemento V2.',
        '- **Q7 · ¿Cómo van en las encuestas?** (1)',
        '  - `encuestas` · PARCIAL (1)',
        '    - E1: Texto del elemento E1.',
        '- **Q8 · ¿Tienen causas abiertas?** (1)',
        '  - `historial` · PARCIAL (1)',
        '    - C1: Texto del elemento C1.',
        '',
        '',
      ].join('\n'),
    );
  });

  it('cuenta los PARCIAL solo con prensa, las fuentes nuevas, el buzón y los recuentos', () => {
    const pp = resumen(entrada).split(/^## /m).find((b) => b.startsWith('PP'))!;
    expect(pp).toContain('### PARCIAL solo con prensa (3 de 3)\n\n- 2.1\n- N1\n- N2');
    expect(pp).toContain('### Fuentes nuevas (1)\n\n- boe.es: BOE (oficial)');
    expect(pp).toContain('### Buzón (1)\n\n- 2026-11-09 · diario.es: Otra nota <https://diario.es/2026/11/09/otra.html>');
    expect(pp).toContain('| Críticos | 1 | 1 | 0 |');
    expect(pp).toContain('| Defensores | 0 | 1 | +1 |');
  });

  it('rechaza una fecha que no es AAAA-MM-DD', () => {
    expect(() => resumen({ ...entrada, fecha: 'hoy' })).toThrow();
  });
});
