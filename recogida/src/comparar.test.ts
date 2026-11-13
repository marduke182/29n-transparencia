import { describe, expect, it } from 'vitest';
import { comparar, propuestasDe } from '../bin/comparar.ts';

const item = (url: string, estado: string, texto: string, cita?: string) => ({ texto, estado, fuentes: [{ url, medio: 'M' }], ...(cita ? { cita: { texto: cita, url } } : {}) });

describe('comparar: live run against shadow run', () => {
  it('keys proposals by section and canonical source, and counts per party, section and state', () => {
    expect(propuestasDe({ propuestas: [{ partido: 'pp', seccion: 'temas', item: item('https://www.medio.es/a?utm_source=x', 'PARCIAL', 'Dice «hola».') }] })).toEqual([
      { clave: 'temas https://medio.es/a', seccion: 'temas', estado: 'PARCIAL', texto: 'Dice «hola».', citas: ['hola'] },
    ]);
    const vivo = { pp: { propuestas: [{ seccion: 'temas', item: item('https://medio.es/a', 'PARCIAL', 'A', 'cita uno') }, { seccion: 'encuestas', item: item('https://medio.es/b', 'VERIFICADO', 'B') }] } };
    const sombra = { pp: { propuestas: [{ seccion: 'temas', item: item('https://medio.es/a', 'VERIFICADO', 'A', 'cita dos') }, { seccion: 'historial', item: item('https://medio.es/c', 'PARCIAL', 'C') }] } };
    const md = comparar(vivo, sombra, { vivo: { hechos: [{ hecho: 'h1' }, { hecho: 'h2' }] }, sombra: { hechos: [{ hecho: 'h2' }, { hecho: 'h3' }] } });
    expect(md).toContain('| pp | 2 | 2 | 1 | 1 | 1 | 1 |');
    expect(md).toContain('| vox | 0 | 0 | 0 | 0 | 0 | 0 |');
    expect(md).toContain('Por sección: encuestas 1→0, historial 0→1, temas 1→1.');
    expect(md).toContain('Por estado: PARCIAL 1→1, VERIFICADO 1→1.');
    expect(md).toContain('- `encuestas https://medio.es/b` (VERIFICADO): B');
    expect(md).toContain('- `historial https://medio.es/c` (PARCIAL): C');
    expect(md).toContain('- `temas https://medio.es/a`: PARCIAL → VERIFICADO');
    expect(md).toContain('- `temas https://medio.es/a`: «cita uno» → «cita dos»');
    expect(md).toContain('Hechos compartidos: 2 en vivo, 2 en sombra; solo en vivo: h1; solo en sombra: h3.');
  });
});
