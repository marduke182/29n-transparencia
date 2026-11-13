/**
 * diario.sh --seco end to end, and the site rules its merged data must meet
 * (the site's own tests do not run in --seco). The 11 November 2026 run broke
 * each of these: perfiles behind the corte, day runs without `hallazgos`, a
 * quote of 15 words merged into a party file, a quote not literally in its
 * cached source (the citas check after the merge failed).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARTY_IDS } from './cache.ts';
import { MAX_PALABRAS_CITA, contarPalabras, fragmentos } from './citas.ts';

const SCRIPT = join(import.meta.dirname, '..', 'bin', 'diario.sh');
const FECHA = '2026-11-10';
type Objeto = Record<string, any>;

let raiz: string;
let salida: string;
let codigo: number | null;
const datos = (ruta: string): Objeto => JSON.parse(readFileSync(join(raiz, 'sitio', 'apps', '29n', 'src', 'data', ruta), 'utf8'));

beforeAll(() => {
  raiz = mkdtempSync(join(tmpdir(), 'n29-seco-'));
  rmSync(raiz, { recursive: true });
  const r = spawnSync('bash', [SCRIPT, '--fecha', FECHA, '--seco', '--salida', raiz], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir() } });
  codigo = r.status;
  salida = `${r.stdout}${r.stderr}`;
}, 120_000);
afterAll(() => rmSync(raiz, { recursive: true, force: true }));

describe('diario.sh --seco', () => {
  it('ends without a failed stage (citas included)', () => {
    expect(codigo, salida).toBe(0);
    expect(salida).toMatch(/Seco terminado/);
  });

  it('runs every perfil to its party sheet corte and publishes the held documents it reaches', () => {
    for (const p of PARTY_IDS) {
      const corte = datos(`partidos/${p}.json`).corte;
      const perfil = datos(`perfiles/${p}.json`);
      expect(perfil.periodo.hasta, p).toBe(corte);
      for (const doc of perfil.en_espera?.documentos ?? []) expect(doc.fecha > perfil.periodo.hasta, `${p} ${doc.id}`).toBe(true);
    }
    expect(datos('perfiles/pp.json').documentos.map((d: Objeto) => d.id)).toContain('pp-d2');
  });

  it("gives every finding of the day's runs one disposition that matches the party files", () => {
    const fichas = Object.fromEntries(PARTY_IDS.map((p) => [p, datos(`partidos/${p}.json`)]));
    const dia = datos('busquedas.json').busquedas.filter((b: Objeto) => b.id.startsWith(`diario-${FECHA}-`));
    expect(dia).toHaveLength(4);
    for (const run of dia) {
      for (const p of PARTY_IDS) {
        const lista: Objeto[] = run.hallazgos?.[p];
        expect(lista, `${run.id} ${p}`).toHaveLength(run.resultados[p]);
        const publicados = fichas[p]!.secciones.flatMap((s: Objeto) => s.items);
        const retenidos = fichas[p]!.en_espera ?? [];
        for (const h of lista) {
          const [items, refs] = 'en_espera' in h ? [retenidos, [h.en_espera]] : 'publicado' in h ? [publicados, h.publicado] : [[], []];
          if (!('descartado' in h)) expect(refs.length, JSON.stringify(h)).toBeGreaterThan(0);
          for (const ref of refs) {
            const item = items.find((i: Objeto) => i.ref === ref);
            expect(item?.busqueda, `${run.id} ${p} ${ref}`).toBe(run.id);
            expect(item.fuentes.map((f: Objeto) => f.url)).toContain(h.url);
          }
        }
        const listados = new Set(lista.flatMap((h) => ('publicado' in h ? h.publicado : 'en_espera' in h ? [h.en_espera] : [])));
        for (const item of [...publicados, ...retenidos].filter((i: Objeto) => i.busqueda === run.id)) expect(listados.has(item.ref), `${p} ${item.ref}`).toBe(true);
      }
    }
  });

  it('merges no bulo that is not VERIFICADO, no quote of 15 words or more and no quote missing from its cached source', () => {
    for (const p of PARTY_IDS) {
      for (const item of datos(`partidos/${p}.json`).secciones.flatMap((s: Objeto) => s.items)) {
        if (item.bulo) expect(item.estado, `${p} ${item.ref}`).toBe('VERIFICADO');
        const citas = [item.cita?.texto, ...['texto', 'matiz', 'afirmacion', 'antes', 'ahora', 'atribucion'].flatMap((c) => (typeof item[c] === 'string' ? fragmentos(item[c]) : []))];
        for (const cita of citas.filter((c) => typeof c === 'string')) expect(contarPalabras(cita), `${p} ${item.ref}: ${cita}`).toBeLessThan(MAX_PALABRAS_CITA);
      }
    }
    const fusion = JSON.parse(readFileSync(join(raiz, 'cache', 'ejecuciones', FECHA, 'fusionar.json'), 'utf8'));
    const motivos = fusion.rechazados.map((r: Objeto) => r.motivo);
    expect(motivos).toContain('texto: cita de 15 palabras (máximo 14)');
    // A quote not literally in the cached page is left out at the merge, so the citas check after it passes.
    expect(motivos).toContain('texto: cita «Ganaremos en toda Castilla-La Mancha» no aparece en https://medio-b.example/politica/2026/11/09/persona-cuatro-mitin');
  });
});

describe('diario.sh --seco with atrasos', () => {
  let carpeta: string;
  let r: { status: number | null; salida: string };
  const ej = () => join(carpeta, 'cache', 'ejecuciones', FECHA);
  beforeAll(() => {
    carpeta = mkdtempSync(join(tmpdir(), 'n29-seco-atrasos-'));
    rmSync(carpeta, { recursive: true });
    const args = [SCRIPT, '--fecha', FECHA, '--seco', '--salida', carpeta, '--atrasos-desde', '2026-10-05', '--atrasos-hasta', '2026-11-07', '--atrasos-emisores', 'medio-b'];
    const p = spawnSync('bash', args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir() } });
    r = { status: p.status, salida: `${p.stdout}${p.stderr}` };
  }, 120_000);
  afterAll(() => rmSync(carpeta, { recursive: true, force: true }));

  it('adds the atrasos task, checks its answer like any other, and says so in the stage table and the summary', () => {
    expect(r.status, r.salida).toBe(0);
    const descubierto = JSON.parse(readFileSync(join(ej(), 'descubrir.json'), 'utf8')) as Objeto;
    expect(descubierto.atrasos).toEqual({ desde: '2026-10-05', hasta: '2026-11-07', emisores: ['medio-b'] });
    const tareas = (descubierto.tareas_busqueda as Objeto[]).filter((t) => t.emisor === 'medio-b');
    expect(tareas.map((t) => [t.salida ?? null, t.desde, t.hasta])).toEqual([
      [null, '2026-11-08', FECHA],
      ['busqueda/medio-b.atrasos.json', '2026-10-05', '2026-11-07'],
    ]);
    expect(tareas[1]!.busquedas.map((b: Objeto) => b.partido)).toEqual([...PARTY_IDS]);
    expect(readFileSync(join(ej(), 'etapas.tsv'), 'utf8')).toMatch(/^atrasos\tok\t2026-10-05 a 2026-11-07: medio-b$/m);
    expect(readFileSync(join(ej(), 'etapas.tsv'), 'utf8')).toMatch(/^busqueda-completa\tok\t$/m);
    expect(readFileSync(join(ej(), 'resumen.md'), 'utf8')).toContain('## Atrasos\n\nAdemás de la ventana del día, se buscó del 2026-10-05 al 2026-11-07 en esta fuente');
  });
});
