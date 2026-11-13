/** The search and classification checks as diario.sh runs them: `node src/diario.ts <check> --fecha D`. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consultasFuente } from './descubrir.ts';

const FECHA = '2026-11-10';
const PARTIDOS = ['frente-amplio', 'pp', 'psoe', 'vox'];
let raiz: string;
let ej: string;

const glue = (...args: string[]) => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'diario.ts'), ...args, '--fecha', FECHA], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, N29_CACHE: join(raiz, 'cache'), N29_SITIO: join(raiz, 'sitio') },
  });
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
};
const escribir = (ruta: string, datos: unknown) => {
  mkdirSync(join(ruta, '..'), { recursive: true });
  writeFileSync(ruta, typeof datos === 'string' ? datos : `${JSON.stringify(datos)}\n`);
};

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'n29-puerta-'));
  ej = join(raiz, 'cache', 'ejecuciones', FECHA);
  mkdirSync(join(raiz, 'sitio'), { recursive: true });
  const consultas = PARTIDOS.map((partido) => ({ partido, terminos: [`Persona ${partido}`, partido], excluir: [] }));
  const busquedas = consultasFuente(['medio.es'], consultas);
  escribir(join(ej, 'descubrir.json'), { fecha: FECHA, desde: '2026-11-08', candidatos: [], tareas_busqueda: [{ emisor: 'medio', nombre: 'Medio', hosts: ['medio.es'], consultas, busquedas, desde: '2026-11-08', hasta: FECHA }] });
  const iguales = PARTIDOS.map((partido) => ({ busqueda: `diario-${FECHA}-causas`, tipo: 'causas', partido, nombre: partido, periodo: { desde: '2026-11-08', hasta: FECHA }, plantilla: 'p', consultas: [{ texto: `${partido} causa`, motor: 'WebSearch', dominios: [] }], salida: `equidad/causas.${partido}.json` }));
  escribir(join(ej, 'equidad-tareas.json'), iguales);
  escribir(join(ej, 'busqueda', 'medio.json'), { emisor: 'medio', candidatos: [], consultas: busquedas.map((b) => ({ partido: b.partido, texto: b.texto, estado: 'ok', resultados: 0 })), nota: '' });
  for (const t of iguales) {
    const respuesta = JSON.stringify({ busqueda: t.busqueda, tipo: 'causas', partido: t.partido, consultas: [{ texto: t.consultas[0]!.texto, estado: 'ok', resultados: 0 }], resultados: [] });
    escribir(join(ej, t.partido === 'psoe' ? `${t.salida}.error.txt` : t.salida), t.partido === 'psoe' ? `${respuesta}]}\n` : respuesta);
  }
});
afterEach(() => {
  rmSync(raiz, { recursive: true, force: true });
});

describe('busqueda-completa', () => {
  it('prepares one retry of the whole kind (exit 3), and fails without --preparar-reintento', () => {
    expect(glue('busqueda-completa').codigo).toBe(1);
    expect(readFileSync(join(ej, 'busqueda-faltan.txt'), 'utf8')).toBe('- equidad/causas.psoe.json: la respuesta no es JSON (equidad/causas.psoe.json.error.txt)\n');
    const { codigo, salida } = glue('busqueda-completa', '--preparar-reintento');
    expect(codigo, salida).toBe(3);
    // The four parties of the kind are redone together; the old answers are kept aside.
    for (const p of PARTIDOS) expect(existsSync(join(ej, 'equidad', `causas.${p}.json`))).toBe(false);
    expect(existsSync(join(ej, 'reintento-anterior', 'equidad', 'causas.psoe.json.error.txt'))).toBe(true);
    expect(existsSync(join(ej, 'reintento-anterior', 'equidad', 'causas.vox.json'))).toBe(true);
    expect((JSON.parse(readFileSync(join(ej, 'reintento-equidad.json'), 'utf8')) as { partido: string }[]).map((t) => t.partido)).toEqual(PARTIDOS);
    expect(JSON.parse(readFileSync(join(ej, 'reintento-fuentes.json'), 'utf8'))).toEqual({ tareas_busqueda: [] });
    expect(readFileSync(join(ej, 'reintento-rutas.txt'), 'utf8').split('\n').filter(Boolean)).toEqual(PARTIDOS.flatMap((p) => [`./equidad/causas.${p}.json`, `./equidad/causas.${p}.json.error.txt`]));
    expect(readFileSync(join(ej, 'busqueda-reintentadas.txt'), 'utf8')).toContain('- se rehacen: equidad/causas.frente-amplio.json, equidad/causas.pp.json, equidad/causas.psoe.json, equidad/causas.vox.json');
  });

  it('accepts an answer with only whitespace after the JSON, and fails without the task files', () => {
    const psoe = join(ej, 'equidad', 'causas.psoe.json.error.txt');
    writeFileSync(psoe, readFileSync(psoe, 'utf8').replace(/\]\}\n$/, '\n \n'));
    expect(glue('busqueda-completa', '--preparar-reintento')).toMatchObject({ codigo: 0, salida: expect.stringContaining('aceptada: equidad/causas.psoe.json') });
    rmSync(join(ej, 'equidad-tareas.json'));
    expect(glue('busqueda-completa')).toMatchObject({ codigo: 1, salida: 'faltan equidad-tareas.json\n' });
  });

  it('does not offer a retry for gaps another session cannot fix', () => {
    const tareas = JSON.parse(readFileSync(join(ej, 'equidad-tareas.json'), 'utf8')) as unknown[];
    escribir(join(ej, 'equidad-tareas.json'), tareas.slice(0, 3));
    expect(glue('busqueda-completa', '--preparar-reintento').codigo).toBe(1);
    expect(readFileSync(join(ej, 'busqueda-definitivas.txt'), 'utf8')).toBe('- equidad: causas sin tarea para vox\n');
  });
});

describe('clasificacion-completa', () => {
  const tarea = (doc_id: string, partido: string) => ({ doc_id, partido, url: `https://medio.es/${doc_id}`, url_canonica: `https://medio.es/${doc_id}`, via: 'web', consultado: FECHA, origen: ['alias'], texto: '', meta: '', salida: `clasificacion/${doc_id}.${partido}.json` });

  it('checks one batch read-only, then prepares one retry for missing or invalid answers', () => {
    const tareas = [tarea('aa', 'pp'), tarea('aa', 'vox'), tarea('bb', 'psoe')];
    escribir(join(ej, 'tareas-clasificar.json'), tareas);
    escribir(join(ej, 'lotes', 'clasificar-01.json'), tareas.slice(0, 2));
    escribir(join(ej, 'clasificacion', 'aa.pp.json'), { doc_id: 'aa', partido: 'pp' });
    escribir(join(ej, 'clasificacion', 'aa.vox.json'), { doc_id: 'aa', partido: 'pp' });
    expect(glue('clasificacion-completa', '--lote', '01').codigo).toBe(1);
    expect(existsSync(join(ej, 'clasificacion', 'aa.vox.json'))).toBe(true);
    expect(glue('clasificacion-completa', '--preparar-reintento').codigo).toBe(3);
    expect(existsSync(join(ej, 'reintento-anterior', 'clasificacion', 'aa.vox.json'))).toBe(true);
    expect(readFileSync(join(ej, 'lotes', 'clasificar-reintento.rutas.txt'), 'utf8')).toBe('./clasificacion/aa.vox.json\n./clasificacion/bb.psoe.json\n');
    escribir(join(ej, 'clasificacion', 'aa.vox.json'), { doc_id: 'aa', partido: 'vox' });
    escribir(join(ej, 'clasificacion', 'bb.psoe.json'), { doc_id: 'bb', partido: 'psoe' });
    expect(glue('clasificacion-completa', '--lote', '01').codigo).toBe(0);
    expect(glue('clasificacion-completa')).toMatchObject({ codigo: 0, salida: '3 clasificaciones completas\n' });
  });
});
