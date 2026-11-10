import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECCIONES, clavesDe, fusionar, huella, maxRef, normalizar, ordenarItem } from './fusionar.ts';

let raiz: string;
let sitio: string;
let carpeta: string;

/** A fixture party file: one item per section where needed, refs like the real ones. */
const ficha = (id: string) => ({
  id,
  nombre: `Partido ${id}`,
  corte: '2026-11-09',
  tarjeta: { candidato: 'X', lema: 'Y', fuente_lema: 'https://a.es/b', que_propone: 'Z', fuente_propuesta: 'https://a.es/c' },
  secciones: SECCIONES.map((seccion) => ({
    id: seccion,
    titulo: seccion,
    items:
      seccion === 'temas'
        ? [{ ref: '23, 13', texto: 'Propone bajar el IVA de la luz.', estado: 'VERIFICADO', fuentes: [{ url: 'https://www.medio.es/a?utm_source=x', medio: 'Medio' }] }]
        : seccion === 'encuestas'
          ? [{ ref: '50a', texto: 'Encuesta previa.', estado: 'VERIFICADO', fuentes: [{ url: 'https://cis.es/e', medio: 'CIS' }] }]
          : [],
  })),
  pendientes: [],
  descartados: [{ ref: '41', estado: 'FALSO', motivo: 'm' }],
});

const propuesta = (partido: string, seccion: string, texto: string, url: string, extra: Record<string, unknown> = {}) => ({
  partido,
  seccion,
  item: { fuentes: [{ medio: 'Medio', url }], estado: 'VERIFICADO', texto },
  ...extra,
});

beforeEach(async () => {
  raiz = await mkdtemp(join(tmpdir(), 'n29-fus-'));
  sitio = join(raiz, 'sitio');
  carpeta = join(raiz, 'adjudicado');
  await mkdir(join(sitio, 'apps', '29n', 'src', 'data', 'partidos'), { recursive: true });
  await mkdir(carpeta);
  for (const id of ['pp', 'vox']) {
    await writeFile(join(sitio, 'apps', '29n', 'src', 'data', 'partidos', `${id}.json`), `${JSON.stringify(ficha(id), null, 2)}\n`);
  }
});
afterEach(async () => {
  await rm(raiz, { recursive: true, force: true });
});

const leer = (id: string, carpetaDatos = 'partidos') => readFile(join(sitio, 'apps', '29n', 'src', 'data', carpetaDatos, `${id}.json`), 'utf8');

describe('helpers', () => {
  it('normalises claims and keys on canonical URL + fingerprint', () => {
    expect(normalizar('  Propone BAJAR el IVA, de la luz!  ')).toBe('propone bajar el iva de la luz');
    expect(normalizar('Educación')).toBe('educacion');
    const a = clavesDe({ texto: 'Propone bajar el IVA de la luz.', fuentes: [{ url: 'http://www.medio.es/a/?fbclid=1' }] });
    expect(a).toEqual([`https://medio.es/a ${huella('propone bajar el iva de la luz')}`]);
  });
  it('finds the largest integer in any ref', () => {
    expect(maxRef(['23, 13', '50a', 'V1', '49 (CIS)', 'N1-critico'])).toBe(50);
    expect(maxRef([])).toBe(0);
  });
  it('orders item keys in a fixed order', () => {
    expect(Object.keys(ordenarItem({ fuentes: [], zeta: 1, estado: 'VERIFICADO', texto: 't', matiz: 'm', ref: 'x' }, '7'))).toEqual(['ref', 'texto', 'estado', 'matiz', 'fuentes', 'zeta']);
  });
});

describe('fusionar', () => {
  it('appends new items with the next integer ref per party, skipping present pairs', async () => {
    await writeFile(
      join(carpeta, 'b.json'),
      JSON.stringify([
        // Already present: same canonical URL (tracking and www stripped) and same normalised claim.
        propuesta('pp', 'temas', 'propone bajar el IVA de la luz', 'https://medio.es/a'),
        propuesta('pp', 'temas', 'Presenta su programa en Badalona.', 'https://medio.es/badalona'),
        propuesta('vox', 'candidatura', 'Cierra la lista por Madrid.', 'https://diario.es/lista'),
      ]),
    );
    await writeFile(join(carpeta, 'a.json'), JSON.stringify({ propuestas: [propuesta('pp', 'candidatura', 'Anuncia su número dos.', 'https://diario.es/dos')] }));

    const plan = await fusionar({ sitio, carpeta, fecha: '2026-11-10' });
    expect(plan.rechazados).toEqual([]);
    expect(plan.cambios.map((c) => [c.partido, c.añadidos.map((a) => [a.ref, a.seccion]), c.duplicados])).toEqual([
      ['pp', [['51', 'candidatura'], ['52', 'temas']], 1],
      ['vox', [['51', 'candidatura']], 0],
    ]);
    const pp = JSON.parse(await leer('pp'));
    expect(pp.corte).toBe('2026-11-10');
    expect(pp.secciones.find((s: { id: string }) => s.id === 'temas').items.map((i: { ref: string }) => i.ref)).toEqual(['23, 13', '52']);
    expect(Object.keys(pp.secciones[0].items[0])).toEqual(['ref', 'texto', 'estado', 'fuentes']);
  });

  it('is idempotent: a second run on the same inputs gives an empty diff', async () => {
    await writeFile(join(carpeta, 'a.json'), JSON.stringify([propuesta('pp', 'temas', 'Nueva afirmación.', 'https://medio.es/n'), propuesta('vox', 'historial', 'Otra.', 'https://medio.es/o')]));
    await fusionar({ sitio, carpeta, fecha: '2026-11-10' });
    const despues = [await leer('pp'), await leer('vox')];
    const segundo = await fusionar({ sitio, carpeta, fecha: '2026-11-10' });
    expect(segundo.cambios.every((c) => c.añadidos.length === 0)).toBe(true);
    expect([await leer('pp'), await leer('vox')]).toEqual(despues);
  });

  it('dedups within one batch too', async () => {
    await writeFile(join(carpeta, 'a.json'), JSON.stringify([propuesta('pp', 'temas', 'Igual.', 'https://medio.es/i'), propuesta('pp', 'temas', '¡igual!', 'https://www.medio.es/i?utm_campaign=z')]));
    const plan = await fusionar({ sitio, carpeta, fecha: '2026-11-10' });
    expect(plan.cambios[0]).toMatchObject({ añadidos: [{ ref: '51' }], duplicados: 1 });
  });

  it('refuses new encuestas items from 2026-11-24 (poll ban), not before', async () => {
    await writeFile(join(carpeta, 'a.json'), JSON.stringify([propuesta('pp', 'encuestas', 'Sondeo nuevo.', 'https://medio.es/sondeo')]));
    const antes = await fusionar({ sitio, carpeta, fecha: '2026-11-23', escribir: false });
    expect(antes.rechazados).toEqual([]);
    expect(antes.cambios[0]!.añadidos).toHaveLength(1);

    const original = await leer('pp');
    const veda = await fusionar({ sitio, carpeta, fecha: '2026-11-24' });
    expect(veda.rechazados).toEqual([{ archivo: 'a.json', indice: 0, motivo: 'veda de encuestas: desde el 2026-11-24 no se añaden encuestas' }]);
    expect(veda.cambios).toEqual([]);
    expect(await leer('pp')).toBe(original);
  });

  it('rejects unpublishable proposals with a reason', async () => {
    await writeFile(
      join(carpeta, 'a.json'),
      JSON.stringify([
        propuesta('pp', 'temas', 'Sin matiz.', 'https://medio.es/p', { item: { texto: 'x', estado: 'PARCIAL', fuentes: [{ url: 'https://medio.es/p', medio: 'M' }] } }),
        propuesta('nadie', 'temas', 't', 'https://medio.es/q'),
        propuesta('pp', 'temas', 't', 'http://medio.es/inseguro'),
      ]),
    );
    const plan = await fusionar({ sitio, carpeta, fecha: '2026-11-10' });
    expect(plan.rechazados.map((r) => r.motivo)).toEqual(['PARCIAL sin matiz', 'partido desconocido "nadie"', 'fuentes: hace falta al menos una, cada una con url https y medio']);
  });

  it('writes held items to the top-level en_espera with their seccion, and dedups against them', async () => {
    await writeFile(join(carpeta, 'a.json'), JSON.stringify([propuesta('pp', 'cambios', 'Pendiente de contraste.', 'https://medio.es/espera', { en_espera: true })]));
    await fusionar({ sitio, carpeta, fecha: '2026-11-10' });
    const pp = JSON.parse(await leer('pp'));
    expect(pp.en_espera).toEqual([{ ref: '51', texto: 'Pendiente de contraste.', estado: 'VERIFICADO', fuentes: [{ medio: 'Medio', url: 'https://medio.es/espera' }], seccion: 'cambios' }]);
    expect(pp.secciones.find((s: { id: string }) => s.id === 'cambios').items).toEqual([]);
    const segundo = await fusionar({ sitio, carpeta, fecha: '2026-11-10' });
    expect(segundo.cambios[0]).toMatchObject({ añadidos: [], duplicados: 1 });
  });

});

describe('fusionar: perfiles', () => {
  const perfil = (partido: string, extra: Record<string, unknown> = {}) => ({
    partido,
    periodo: { desde: '2026-10-05', hasta: '2026-11-09' },
    limites: [],
    documentos: [
      { id: `${partido}-d1`, titulo: 'Nota', fecha: '2026-10-20', fecha_fuente: 'Fecha impresa', tipo: 'nota de prensa', url: 'https://web.es/notas/una', procedencia: { via: 'web', consultado: '2026-11-09' } },
    ],
    propuestas: [{ id: `${partido}-p3`, tema: 'VIV', texto: 'Propone más vivienda pública.', cita: { texto: 'más vivienda', documento: `${partido}-d1` }, documentos: [`${partido}-d1`] }],
    mensajes: [],
    ...extra,
  });
  const rutaPerfil = (id: string) => join(sitio, 'apps', '29n', 'src', 'data', 'perfiles', `${id}.json`);
  const documento = (url: string, titulo = 'Programa') => ({
    partido: 'vox',
    destino: 'perfil',
    tipo: 'documento',
    documento: { procedencia: { consultado: '2026-11-10', via: 'rss' }, url, titulo, fecha: '2026-11-08', fecha_fuente: 'pubDate del feed', tipo: 'programa electoral' },
  });

  beforeEach(async () => {
    await mkdir(join(sitio, 'apps', '29n', 'src', 'data', 'perfiles'), { recursive: true });
    for (const id of ['frente-amplio', 'podemos', 'pp', 'psoe', 'vox']) await writeFile(rutaPerfil(id), `${JSON.stringify(perfil(id), null, 2)}\n`);
  });

  it('adds documents, propuestas and mensajes in the perfil shape, continuing the ids', async () => {
    await writeFile(
      join(carpeta, 'a.json'),
      JSON.stringify([
        { partido: 'vox', destino: 'perfil', tipo: 'mensaje', mensaje: { texto: 'Critica al Gobierno por la vivienda.', tipo: 'critica_al_gobierno', documentos: ['https://www.web.es/programa?utm_source=x'] } },
        { partido: 'vox', destino: 'perfil', tipo: 'propuesta', propuesta: { tema: 'EDU', texto: 'Propone gratuidad de 0 a 3.', cita: { texto: 'gratuidad de 0 a 3', documento: 'https://web.es/programa', pagina: 4 }, documentos: ['https://web.es/programa', 'https://web.es/notas/una'] } },
        documento('https://web.es/programa'),
      ]),
    );
    const plan = await fusionar({ sitio, carpeta, fecha: '2026-11-10' });
    expect(plan.rechazados).toEqual([]);
    expect(plan.cambios).toEqual([
      {
        ruta: rutaPerfil('vox'),
        partido: 'vox',
        destino: 'perfil',
        duplicados: 0,
        añadidos: [
          { ref: 'vox-d2', seccion: 'documento', url: 'https://web.es/programa' },
          { ref: 'vox-p4', seccion: 'propuesta', url: 'https://web.es/programa' },
          { ref: 'vox-m1', seccion: 'mensaje', url: 'https://web.es/programa' },
        ],
      },
    ]);
    const vox = JSON.parse(await readFile(rutaPerfil('vox'), 'utf8'));
    expect(vox.documentos[1]).toEqual({ id: 'vox-d2', titulo: 'Programa', fecha: '2026-11-08', fecha_fuente: 'pubDate del feed', tipo: 'programa electoral', url: 'https://web.es/programa', procedencia: { via: 'rss', consultado: '2026-11-10' } });
    expect(Object.keys(vox.documentos[1])).toEqual(['id', 'titulo', 'fecha', 'fecha_fuente', 'tipo', 'url', 'procedencia']);
    expect(vox.propuestas[1]).toEqual({ id: 'vox-p4', tema: 'EDU', texto: 'Propone gratuidad de 0 a 3.', cita: { texto: 'gratuidad de 0 a 3', documento: 'vox-d2', pagina: 4 }, documentos: ['vox-d2', 'vox-d1'] });
    expect(vox.mensajes).toEqual([{ id: 'vox-m1', tipo: 'critica_al_gobierno', texto: 'Critica al Gobierno por la vivienda.', documentos: ['vox-d2'] }]);
    // The validator wants one periodo for all five: hasta moves everywhere.
    for (const id of ['frente-amplio', 'podemos', 'pp', 'psoe', 'vox']) expect(JSON.parse(await readFile(rutaPerfil(id), 'utf8')).periodo).toEqual({ desde: '2026-10-05', hasta: '2026-11-10' });
  });

  it('is idempotent and dedups on document URL + text fingerprint', async () => {
    await writeFile(
      join(carpeta, 'a.json'),
      JSON.stringify([
        documento('https://web.es/programa'),
        documento('https://web.es/notas/una/', 'Otro título, mismo documento'),
        { partido: 'vox', destino: 'perfil', tipo: 'propuesta', propuesta: { tema: 'VIV', texto: '¡Propone más vivienda pública!', cita: { texto: 'más vivienda', documento: 'https://web.es/notas/una' }, documentos: ['https://web.es/notas/una'] } },
      ]),
    );
    const primero = await fusionar({ sitio, carpeta, fecha: '2026-11-10' });
    expect(primero.cambios[0]).toMatchObject({ añadidos: [{ ref: 'vox-d2' }], duplicados: 2 });
    const antes = await Promise.all(['pp', 'vox'].map((id) => readFile(rutaPerfil(id), 'utf8')));
    const segundo = await fusionar({ sitio, carpeta, fecha: '2026-11-10' });
    expect(segundo.cambios[0]).toMatchObject({ añadidos: [], duplicados: 3 });
    expect(await Promise.all(['pp', 'vox'].map((id) => readFile(rutaPerfil(id), 'utf8')))).toEqual(antes);
  });

  it('leaves periodo alone when nothing is added, and rejects unknown documents and bad shapes', async () => {
    await writeFile(
      join(carpeta, 'a.json'),
      JSON.stringify([
        { partido: 'pp', destino: 'perfil', tipo: 'mensaje', mensaje: { tipo: 'valores', texto: 'x', documentos: ['https://web.es/no-existe'] } },
        { partido: 'pp', destino: 'perfil', tipo: 'propuesta', propuesta: { tema: 'POL', texto: 'x', cita: { texto: 'x', documento: 'https://web.es/notas/una' }, documentos: ['https://web.es/notas/una'] } },
        { ...documento('https://web.es/z'), documento: { ...documento('https://web.es/z').documento, procedencia: { via: 'proxy', consultado: '2026-11-10' } } },
      ]),
    );
    const original = await readFile(rutaPerfil('pp'), 'utf8');
    const plan = await fusionar({ sitio, carpeta, fecha: '2026-11-10' });
    expect(plan.rechazados.map((r) => r.motivo)).toEqual([
      'mensaje: el documento https://web.es/no-existe no está en el perfil ni en esta ejecución',
      'propuesta: tema "POL" no admitido',
      'documento: procedencia.via "proxy" no admitida',
    ]);
    expect(await readFile(rutaPerfil('pp'), 'utf8')).toBe(original);
  });
});
