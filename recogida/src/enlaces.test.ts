import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORIGEN_ENLACES, leerListaEnlaces } from './buzon.ts';
import { informe } from './diario.ts';
import { Traedor, traerEnlaces } from './traer.ts';

describe('leerListaEnlaces', () => {
  it('reads one https URL per line with an optional party, skipping comments and blank lines', () => {
    const texto = ['# enlaces del 10 de noviembre', '', 'https://medio.es/a', '  https://medio.es/b pp  ', 'https://medio.es/c#parte vox # nota', '\r'].join('\n');
    expect(leerListaEnlaces(texto)).toEqual({
      enlaces: [
        { linea: 3, url: 'https://medio.es/a' },
        { linea: 4, url: 'https://medio.es/b', partido: 'pp' },
        { linea: 5, url: 'https://medio.es/c#parte', partido: 'vox' },
      ],
      avisos: [],
    });
  });

  it('turns every bad line into an aviso, never an error', () => {
    const texto = ['http://medio.es/a', 'no es una url', 'https://medio.es/b podemos', 'https://medio.es/c pp extra', 'https://usuario:clave@medio.es/d', 'https://medio.es/e', 'https://www.medio.es/e?utm_source=x'].join('\n');
    const { enlaces, avisos } = leerListaEnlaces(texto);
    expect(enlaces).toEqual([{ linea: 6, url: 'https://medio.es/e' }]);
    expect(avisos.map((a) => [a.linea, a.motivo])).toEqual([
      [1, 'solo se admiten URL https'],
      [2, 'más de dos campos: se espera «URL [partido]»'],
      [3, 'partido desconocido: se espera frente-amplio, pp, psoe o vox'],
      [4, 'más de dos campos: se espera «URL [partido]»'],
      [5, 'la URL lleva usuario o contraseña'],
      [7, 'repetida (ya en la línea 6)'],
    ]);
  });
});

describe('traerEnlaces', () => {
  let raiz: string;
  beforeEach(async () => {
    raiz = await mkdtemp(join(tmpdir(), 'n29-enlaces-'));
  });
  afterEach(async () => {
    await rm(raiz, { recursive: true, force: true });
  });

  const traedor = (rutas: Record<string, { status: number; body?: string }>, soloBuzon: string[] = []) => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const ruta = rutas[String(url)] ?? { status: 404 };
      return new Response(ruta.body ?? '', { status: ruta.status, headers: { 'content-type': 'text/html' } });
    });
    let ahora = 0;
    const t = new Traedor({ fecha: '2026-11-10', fetch: fetch as unknown as typeof globalThis.fetch, reloj: () => ahora, esperar: async (ms) => void (ahora += ms), resolver: async () => ['93.184.215.14'], soloBuzon });
    return { t, fetch };
  };
  const robots = { status: 200, body: 'User-agent: *\nDisallow: /privado/' };
  const pagina = { status: 200, body: '<html><body><article><p>Alberto Núñez Feijóo habló del Partido Popular.</p></article></body></html>' };

  it('fetches through the same Traedor and marks the origin; robots, inbox-only hosts and failures become avisos', async () => {
    const { t, fetch } = traedor({ 'https://medio.es/robots.txt': robots, 'https://medio.es/a': pagina }, ['psoe.es']);
    const lista = leerListaEnlaces(['https://medio.es/a pp', 'https://medio.es/privado/b', 'https://psoe.es/c', 'https://medio.es/no-existe', 'ftp://medio.es/x'].join('\n'));
    const { enlaces, avisos } = await traerEnlaces(t, raiz, lista);
    expect(enlaces.map((e) => [e.linea, e.estado, e.cache])).toEqual([
      [1, 'ok', 'nuevo'],
      [2, 'robots', undefined],
      [3, 'solo-buzon', undefined],
      [4, 'error', undefined],
    ]);
    expect(avisos.map((a) => a.linea)).toEqual([2, 3, 4, 5]);
    expect(avisos[0]!.motivo).toMatch(/^no se trajo \(robots/);
    const meta = JSON.parse(await readFile(join(raiz, 'docs', enlaces[0]!.id!, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ url_canonica: 'https://medio.es/a', consultado: '2026-11-10', via: 'web', origen: ORIGEN_ENLACES });
    // The owner's party note is kept in enlaces.json only: classifiers and adjudicators read meta.json.
    expect(meta).not.toHaveProperty('partido_buzon');
    expect(JSON.stringify(meta)).not.toContain('"pp"');
    expect(enlaces[0]).toMatchObject({ partido: 'pp' });
    expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain('https://psoe.es/c');
  });

  it('says so when a link was already cached unchanged on an earlier day', async () => {
    const antes = traedor({ 'https://medio.es/robots.txt': robots, 'https://medio.es/a': pagina });
    const ayer = new Traedor({ fecha: '2026-11-09', fetch: antes.fetch as unknown as typeof globalThis.fetch, reloj: () => 0, esperar: async () => {}, resolver: async () => ['93.184.215.14'], soloBuzon: [] });
    await traerEnlaces(ayer, raiz, leerListaEnlaces('https://medio.es/a'));
    const { avisos } = await traerEnlaces(antes.t, raiz, leerListaEnlaces('https://medio.es/a'));
    expect(avisos).toEqual([{ linea: 1, texto: 'https://medio.es/a', motivo: 'ya estaba en la caché sin cambios desde el 2026-11-09: no es nuevo hoy' }]);
  });
});

describe('informe: enlaces del buzón', () => {
  it('lists each link with its origin, the parties of the alias rule and the items added from it', () => {
    const texto = informe({
      fecha: '2026-11-10',
      etapas: '',
      enlaces: {
        enlaces: [
          { linea: 1, url: 'https://www.medio.es/a?utm_source=x&token=secreto#parte', partido: 'pp', estado: 'ok', url_canonica: 'https://medio.es/a', cache: 'nuevo' },
          { linea: 2, url: 'https://psoe.es/c', estado: 'solo-buzon', motivo: 'solo su listado o el buzón' },
        ],
        avisos: [
          { linea: 2, texto: 'https://psoe.es/c', motivo: 'no se trajo (solo-buzon)' },
          { linea: 3, texto: 'https://x.es/?clave=privada', motivo: 'solo se admiten URL https' },
        ],
      },
      clasificar: [
        { url_canonica: 'https://medio.es/a', partido: 'pp' },
        { url_canonica: 'https://medio.es/a', partido: 'vox' },
        { url_canonica: 'https://otro.es/z', partido: 'psoe' },
      ],
      fusionar: { cambios: [{ partido: 'pp', destino: 'partido', añadidos: [{ ref: '3', seccion: 'temas', url: 'https://medio.es/a' }, { ref: '4', seccion: 'temas', url: 'https://otro.es/z' }], duplicados: 0 }] },
    });
    expect(texto).toContain(`### Enlaces del buzón (origen ${ORIGEN_ENLACES}) (2)`);
    expect(texto).toContain('- línea 1: <https://www.medio.es/a> (nota: pp): traído; partidos por la regla de alias: pp, vox; elementos añadidos: pp 3 (temas)');
    expect(texto).not.toMatch(/secreto|utm_source|#parte/);
    expect(texto).toContain('- línea 2: <https://psoe.es/c>: no traído (solo-buzon)');
    expect(texto).toContain('- línea 2: no se trajo (solo-buzon)\n- línea 3: solo se admiten URL https');
    expect(texto).not.toContain('clave=privada');
  });

  it('says none when there is no list', () => {
    expect(informe({ fecha: '2026-11-10', etapas: '' })).toMatch(/### Enlaces del buzón \(origen buzon-enlaces\) \(0\)\n\n_Ninguno\._/);
  });
});

describe('informe: reintento de la búsqueda', () => {
  it('lists what the retry session redid and the answers accepted with whitespace', () => {
    const texto = informe({ fecha: '2026-11-10', etapas: '', reintentadas: '- equidad/causas.psoe.json: la respuesta no es JSON (equidad/causas.psoe.json.error.txt)\n', aceptadas: '- busqueda/medio-c.json\n' });
    expect(texto).toContain('### Reintentado en una sesión más (busqueda-reintento), la misma regla para todos los partidos (1)\n\n- equidad/causas.psoe.json: la respuesta no es JSON');
    expect(texto).toContain('### Respuestas aceptadas con espacios alrededor del JSON (1)\n\n- busqueda/medio-c.json');
    expect(informe({ fecha: '2026-11-10', etapas: '' })).toContain('(busqueda-reintento), la misma regla para todos los partidos (0)\n\n_Nada._');
  });
});
