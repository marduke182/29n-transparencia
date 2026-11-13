import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LISTADOS_DEBATES, LONGITUD_MAXIMA_CONSULTA, accesoDesdeRegistro, candidatoPrimero, consultasFuente, descubrir, leerCandidatos, mitadesDe, terminosQueCaben, textoConsulta, fechaIso, leerFeed, leerSeccion, leerSitemap, restarDias, type Alias, type Emisor, type Listado } from './descubrir.ts';
import { Traedor } from './traer.ts';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Medio</title>
<item><title>Debate &amp; propuestas</title><link>https://www.medio.es/politica/2026/11/10/debate.html?utm_source=rss</link><pubDate>Tue, 10 Nov 2026 08:00:00 GMT</pubDate></item>
<item><title>Vieja</title><link>https://www.medio.es/politica/2026/10/01/vieja.html</link><pubDate>Thu, 01 Oct 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;

const INDICE = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://diario.es/post-sitemap2.xml</loc><lastmod>2026-11-10T06:00:00Z</lastmod></sitemap>
<sitemap><loc>https://diario.es/post-sitemap1.xml</loc><lastmod>2026-09-01T06:00:00Z</lastmod></sitemap>
</sitemapindex>`;
const URLSET = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://diario.es/2026/11/09/nota/</loc><lastmod>2026-11-09</lastmod></url>
<url><loc>https://diario.es/2026/10/02/antigua/</loc><lastmod>2026-10-02</lastmod></url>
</urlset>`;
const SECCION = `<a href="/es/avance-de-resultados/estudio-3550">Avance</a><a href="https://otro.es/x/y">fuera</a><a href="#top">arriba</a><a href="/es/">inicio</a>`;
const BOE = { data: { sumario: { diario: [{ seccion: [{ departamento: [{ epigrafe: [{ item: [
  { titulo: 'Acuerdo de la Junta Electoral Central sobre debates', url_html: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-1' },
  { titulo: 'Orden de pesca', url_html: 'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-2' },
] }] }] }] }] } } };
const MONCLOA = `<a href="/presidente/intervenciones/Paginas/2026/prensa101126.aspx">Rueda</a><a href="/Paginas/index.aspx">Inicio</a>`;

const emisores: Emisor[] = [
  { id: 'medio', nombre: 'Medio', hosts: ['medio.es'], tipo: 'medio', recogida: { metodo: 'rss', url: 'https://www.medio.es/rss' } },
  { id: 'diario', nombre: 'Diario', hosts: ['diario.es'], tipo: 'medio', recogida: { metodo: 'sitemap', url: 'https://diario.es/sitemap_index.xml' } },
  { id: 'boe', nombre: 'BOE', hosts: ['boe.es'], tipo: 'oficial', recogida: { metodo: 'api', url: 'https://www.boe.es/datosabiertos/api/boe/sumario/' } },
  { id: 'cis', nombre: 'CIS', hosts: ['cis.es'], tipo: 'oficial', recogida: { metodo: 'seccion', url: 'https://www.cis.es/es/avance-de-resultados' } },
  { id: 'busca', nombre: 'Busca', hosts: ['busca.es'], tipo: 'medio' },
  { id: 'fuera', nombre: 'Fuera', hosts: ['fuera.cl'], tipo: 'medio', recogida: { metodo: 'omitir', nota: 'Fuera de ámbito.' } },
  {
    id: 'web-partido-ejemplo',
    nombre: 'Web de Partido Ejemplo',
    hosts: ['partido-ejemplo.es'],
    tipo: 'partido',
    partido: 'pp',
    acceso: { estado: 'parcial', comprobado: '2026-11-10', detalle: 'Artículos 403; feed legible.' },
    recogida: { metodo: 'rss', url: 'https://partido-ejemplo.es/feed/' },
  },
  {
    id: 'web-vox',
    nombre: 'Web de Vox',
    hosts: ['voxespana.es'],
    tipo: 'partido',
    partido: 'vox',
    acceso: { estado: 'bloqueado', comprobado: '2026-11-10', detalle: '403.' },
    recogida: { metodo: 'omitir', nota: 'bloquea bots' },
  },
  { id: 'cerrado', nombre: 'Cerrado', hosts: ['cerrado.es'], tipo: 'medio', recogida: { metodo: 'rss', url: 'https://cerrado.es/feed' } },
];
const alias: Record<string, Alias> = {
  'frente-amplio': { nombres: ['Frente Amplio'], marcas_regionales: [], miembros: [], personas: ['Persona Uno'], excluir: [] },
  pp: { nombres: ['PP'], marcas_regionales: [], miembros: [], personas: ['Persona Dos'], excluir: [] },
  psoe: { nombres: ['PSOE'], marcas_regionales: [], miembros: [], personas: ['Persona Tres'], excluir: [] },
  vox: { nombres: ['Vox'], marcas_regionales: [], miembros: [], personas: [], excluir: ['Vox Populi'] },
};
// Vox's candidate is not among its alias terms: it still goes first in the query.
const candidatos = { 'frente-amplio': 'Persona Uno', pp: 'Persona Dos', psoe: 'Persona Tres', vox: 'Persona Cuatro' };
const listados: Listado[] = [
  { id: 'moncloa', emisor: 'la-moncloa-gobierno', metodo: 'seccion', url: 'https://www.lamoncloa.gob.es/presidente/intervenciones/Paginas/index.aspx', genero: 'transcripcion', enlaces: /\/Paginas\/\d{4}\/.+\.aspx$/ },
];

const rutas: Record<string, { status: number; body: string; type?: string }> = {
  'https://www.medio.es/rss': { status: 200, body: RSS, type: 'application/rss+xml' },
  'https://diario.es/sitemap_index.xml': { status: 200, body: INDICE, type: 'application/xml' },
  'https://diario.es/post-sitemap2.xml': { status: 200, body: URLSET, type: 'application/xml' },
  'https://www.boe.es/datosabiertos/api/boe/sumario/20261110': { status: 200, body: JSON.stringify(BOE), type: 'application/json' },
  'https://www.cis.es/es/avance-de-resultados': { status: 200, body: SECCION },
  'https://www.lamoncloa.gob.es/presidente/intervenciones/Paginas/index.aspx': { status: 200, body: MONCLOA },
  'https://cerrado.es/feed': { status: 403, body: 'Forbidden' },
  'https://partido-ejemplo.es/feed/': {
    status: 200,
    type: 'application/rss+xml; charset=utf-8',
    body: `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>Nota</title><link>https://partido-ejemplo.es/nota-vivienda/</link><pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate><content:encoded><![CDATA[<p>Texto completo de la nota.</p>]]></content:encoded></item></channel></rss>`,
  },
};

function traedor() {
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
    const ruta = rutas[u] ?? { status: 404, body: '' };
    return new Response(ruta.body, { status: ruta.status, headers: { 'content-type': ruta.type ?? 'text/html' } });
  });
  let ahora = 0;
  const acceso = accesoDesdeRegistro(emisores);
  return { fetch, traedor: new Traedor({ fecha: '2026-11-10', fetch: fetch as unknown as typeof globalThis.fetch, reloj: () => ahora, esperar: async (ms) => void (ahora += ms), resolver: async () => ['93.184.215.14'], ...acceso }) };
}

describe('parsers', () => {
  it('reads RSS items and dates', () => {
    expect(leerFeed(RSS)[0]).toEqual({ url: 'https://www.medio.es/politica/2026/11/10/debate.html?utm_source=rss', titulo: 'Debate & propuestas', fecha: '2026-11-10' });
  });
  it('reads Atom entries', () => {
    const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link rel="alternate" href="https://a.es/x/y"/><updated>2026-11-09T10:00:00Z</updated></entry></feed>';
    expect(leerFeed(atom)).toEqual([{ url: 'https://a.es/x/y', titulo: 'A', fecha: '2026-11-09' }]);
  });
  it('reads sitemap indexes and urlsets', () => {
    expect(leerSitemap(INDICE).indice).toHaveLength(2);
    expect(leerSitemap(URLSET).urls[0]).toEqual({ url: 'https://diario.es/2026/11/09/nota/', fecha: '2026-11-09' });
  });
  it('keeps same-host links of a section page', () => {
    expect(leerSeccion(SECCION, 'https://www.cis.es/es/avance-de-resultados')).toEqual(['https://www.cis.es/es/avance-de-resultados/estudio-3550']);
  });
  it('does date arithmetic without a clock', () => {
    expect(restarDias('2026-11-01', 2)).toBe('2026-10-30');
    expect(fechaIso('Tue, 10 Nov 2026 23:30:00 +0000')).toBe('2026-11-10');
  });
});

describe('accesoDesdeRegistro', () => {
  it('reads a working method for partial or blocked hosts, inbox only otherwise', () => {
    expect(accesoDesdeRegistro(emisores)).toEqual({ soloBuzon: ['voxespana.es'], soloListado: { 'partido-ejemplo.es': ['https://partido-ejemplo.es/feed/'] }, noTraer: ['fuera.cl', 'voxespana.es'] });
    const psoe: Emisor = { id: 'web-psoe', nombre: 'PSOE', hosts: ['psoe.es'], tipo: 'partido', acceso: { estado: 'bloqueado', comprobado: '2026-11-10', detalle: 'reto' } };
    expect(accesoDesdeRegistro([psoe]).soloBuzon).toEqual(['psoe.es']);
    expect(accesoDesdeRegistro([{ ...psoe, recogida: { metodo: 'rss', url: 'https://psoe.es/feed' } }]).soloListado).toEqual({ 'psoe.es': ['https://psoe.es/feed'] });
  });
  it('never fetches the hosts of an emisor with recogida omitir or a bloqueo', () => {
    const bloqueado: Emisor = { id: 'el-pais', nombre: 'El País', hosts: ['elpais.com'], tipo: 'medio', recogida: { metodo: 'omitir' }, bloqueo: { tipo: 'robots', evidencia: 'User-agent: Claude-User · Disallow: /', consultado: '2026-11-13', robots: 'https://elpais.com/robots.txt', agentes: ['Claude-User'] } };
    expect(accesoDesdeRegistro([bloqueado, emisores[0]!]).noTraer).toEqual(['elpais.com']);
    expect(accesoDesdeRegistro([{ ...bloqueado, recogida: undefined }]).noTraer).toEqual(['elpais.com']);
  });
});

describe('LISTADOS_DEBATES link patterns (from the pages fetched on 2026-11-10)', () => {
  const patron = (id: string) => LISTADOS_DEBATES.find((l) => l.id === id)!.enlaces!;
  it('Moncloa', () => {
    expect(patron('moncloa-intervenciones').test('/presidente/intervenciones/Paginas/2026/20261001-transcripcion-sanchez-foro-la-toja.aspx')).toBe(true);
    expect(patron('moncloa-intervenciones').test('/presidente/intervenciones/Paginas/index.aspx')).toBe(false);
    expect(patron('moncloa-ruedas-de-prensa').test('/consejodeministros/ruedas/Paginas/2026/20260929-transcripcion-rueda-de-prensa-ministros.aspx')).toBe(true);
    expect(patron('moncloa-ruedas-de-prensa').test('/consejodeministros/ruedas/Paginas/index.aspx')).toBe(false);
  });
  it('RTVE', () => {
    const rtve = patron('rtve-debates-y-entrevistas');
    expect(rtve.test('/noticias/20261109/debate-candidatos-29n-rtve-cataluna/17305664.shtml')).toBe(true);
    expect(rtve.test('/noticias/20261110/entrevista-pedro-sanchez-septima-cronica-rtve/17306951.shtml')).toBe(true);
    expect(rtve.test('/play/videos/la-hora-de-la-1/entrevista-miguel-tellado-pp/17297155/')).toBe(true);
    expect(rtve.test('/noticias/20261109/borrasca-origen-subtropical-charles/17305977.shtml')).toBe(false);
    expect(rtve.test('/play/audios/24-horas/conocemos-cara-semana/17305060/')).toBe(false);
  });
});

describe('descubrir', () => {
  it('reads rss/sitemap/api/seccion, emits search tasks, skips omitir and inbox-only hosts', async () => {
    const { traedor: t, fetch } = traedor();
    const resultado = await descubrir({ emisores, alias, candidatos }, t, { fecha: '2026-11-10', dias: 2, listados });

    expect(resultado.candidatos.map((c) => [c.emisor, c.url_canonica, c.metodo, c.genero])).toEqual([
      ['boe', 'https://boe.es/diario_boe/txt.php?id=BOE-A-2026-1', 'api', 'documento'],
      ['cis', 'https://cis.es/es/avance-de-resultados/estudio-3550', 'seccion', 'documento'],
      ['diario', 'https://diario.es/2026/11/09/nota', 'sitemap', 'articulo'],
      ['la-moncloa-gobierno', 'https://lamoncloa.gob.es/presidente/intervenciones/Paginas/2026/prensa101126.aspx', 'seccion', 'transcripcion'],
      ['medio', 'https://medio.es/politica/2026/11/10/debate.html', 'rss', 'articulo'],
      ['web-partido-ejemplo', 'https://partido-ejemplo.es/nota-vivienda', 'rss', 'documento'],
    ]);
    // Pages of partido-ejemplo.es block: the feed text travels with the candidate; other feeds don't carry it.
    expect(resultado.candidatos.find((c) => c.emisor === 'web-partido-ejemplo')!.contenido_feed).toBe('<p>Texto completo de la nota.</p>');
    expect(resultado.candidatos.find((c) => c.emisor === 'medio')!.contenido_feed).toBeUndefined();
    expect(resultado.tareas_busqueda).toEqual([
      {
        emisor: 'busca',
        nombre: 'Busca',
        hosts: ['busca.es'],
        consultas: [
          { partido: 'frente-amplio', terminos: ['Persona Uno', 'Frente Amplio'], excluir: [] },
          { partido: 'pp', terminos: ['Persona Dos', 'PP'], excluir: [] },
          { partido: 'psoe', terminos: ['Persona Tres', 'PSOE'], excluir: [] },
          { partido: 'vox', terminos: ['Persona Cuatro', 'Vox'], excluir: ['Vox Populi'] },
        ],
        busquedas: [
          { partido: 'frente-amplio', texto: 'site:busca.es ("Persona Uno" OR "Frente Amplio")', terminos: ['Persona Uno', 'Frente Amplio'], terminos_omitidos: [], mitades: ['site:busca.es ("Persona Uno")', 'site:busca.es ("Frente Amplio")'] },
          { partido: 'pp', texto: 'site:busca.es ("Persona Dos" OR "PP")', terminos: ['Persona Dos', 'PP'], terminos_omitidos: [], mitades: ['site:busca.es ("Persona Dos")', 'site:busca.es ("PP")'] },
          { partido: 'psoe', texto: 'site:busca.es ("Persona Tres" OR "PSOE")', terminos: ['Persona Tres', 'PSOE'], terminos_omitidos: [], mitades: ['site:busca.es ("Persona Tres")', 'site:busca.es ("PSOE")'] },
          { partido: 'vox', texto: 'site:busca.es ("Persona Cuatro" OR "Vox")', terminos: ['Persona Cuatro', 'Vox'], terminos_omitidos: [], mitades: ['site:busca.es ("Persona Cuatro")', 'site:busca.es ("Vox")'] },
        ],
        desde: '2026-11-08',
        hasta: '2026-11-10',
      },
    ]);
    expect(resultado.omitidos).toEqual([{ emisor: 'fuera', nota: 'Fuera de ámbito.' }]);
    expect(resultado.solo_buzon).toEqual([{ emisor: 'web-vox', hosts: ['voxespana.es'] }]);
    expect(resultado.fallos).toEqual([{ emisor: 'cerrado', listado: 'https://cerrado.es/feed', motivo: 'bloqueado: HTTP 403' }]);
    expect(resultado.bloqueados['cerrado.es']).toMatchObject({ fecha: '2026-11-10', estado_http: 403 });
    // The old sub-sitemap (outside the window) and the inbox-only host are never requested.
    const pedidas = fetch.mock.calls.map(([url]) => String(url));
    expect(pedidas).not.toContain('https://diario.es/post-sitemap1.xml');
    expect(pedidas.filter((url) => url.includes('partido-ejemplo.es'))).toEqual(['https://partido-ejemplo.es/robots.txt', 'https://partido-ejemplo.es/feed/']);
    expect(pedidas.some((url) => url.includes('voxespana.es'))).toBe(false);
  });
});

describe('descubrir con atrasos', () => {
  const atrasos = { desde: '2026-10-05', hasta: '2026-11-08', emisores: ['busca', 'medio'] };
  it('adds one search task per named source, built like any other, with its own window, note and answer file', async () => {
    const sin = await descubrir({ emisores, alias, candidatos }, traedor().traedor, { fecha: '2026-11-10', listados });
    const con = await descubrir({ emisores, alias, candidatos }, traedor().traedor, { fecha: '2026-11-10', listados, atrasos });
    expect(sin.atrasos).toBeUndefined();
    expect('atrasos' in sin).toBe(false);
    expect(con.atrasos).toEqual(atrasos);
    // The day's own work is unchanged: the same candidates and the normal busca task.
    expect(con.candidatos).toEqual(sin.candidatos);
    expect(con.tareas_busqueda.filter((t) => !t.salida)).toEqual(sin.tareas_busqueda);
    const extra = con.tareas_busqueda.filter((t) => t.salida);
    expect(extra.map((t) => [t.emisor, t.salida, t.desde, t.hasta, t.nota])).toEqual([
      ['busca', 'busqueda/busca.atrasos.json', '2026-10-05', '2026-11-08', 'Atrasos: devuelve solo lo publicado del 2026-10-05 al 2026-11-08.'],
      ['medio', 'busqueda/medio.atrasos.json', '2026-10-05', '2026-11-08', 'Atrasos: devuelve solo lo publicado del 2026-10-05 al 2026-11-08.'],
    ]);
    // Same queries as the day's task of busca: four parties, candidate first, one query each.
    const normal = con.tareas_busqueda.find((t) => t.emisor === 'busca' && !t.salida)!;
    expect(extra[0]!.busquedas).toEqual(normal.busquedas);
    for (const tarea of extra) {
      expect(tarea.busquedas.map((b) => b.partido)).toEqual(['frente-amplio', 'pp', 'psoe', 'vox']);
      expect(tarea.busquedas.every((b, i) => b.terminos[0] === Object.values(candidatos)[i])).toBe(true);
    }
    expect(extra[1]!.busquedas[3]!.texto).toBe('site:medio.es ("Persona Cuatro" OR "Vox")');
    // The normal task comes before the atrasos one of the same source.
    expect(con.tareas_busqueda.map((t) => t.salida ?? t.emisor)).toEqual(['busca', 'busqueda/busca.atrasos.json', 'busqueda/medio.atrasos.json']);
  });
  it('refuses unknown ids, omitir and inbox-only sources, bad dates, desde after hasta and hasta after the run date', async () => {
    const pedir = (a: typeof atrasos) => descubrir({ emisores, alias, candidatos }, traedor().traedor, { fecha: '2026-11-10', listados, atrasos: a });
    await expect(pedir({ ...atrasos, emisores: ['nadie'] })).rejects.toThrow(/nadie no es un emisor/);
    await expect(pedir({ ...atrasos, emisores: ['fuera'] })).rejects.toThrow(/fuera tiene recogida omitir/);
    await expect(pedir({ ...atrasos, emisores: ['web-vox'] })).rejects.toThrow(/web-vox tiene recogida omitir/);
    const soloBuzon: Emisor = { id: 'cerrada', nombre: 'Cerrada', hosts: ['cerrada.es'], tipo: 'partido', partido: 'psoe', acceso: { estado: 'bloqueado', comprobado: '2026-11-10', detalle: '403' } };
    await expect(descubrir({ emisores: [...emisores, soloBuzon], alias, candidatos }, traedor().traedor, { fecha: '2026-11-10', listados, atrasos: { ...atrasos, emisores: ['cerrada'] } })).rejects.toThrow(/cerrada es solo buzón/);
    await expect(pedir({ ...atrasos, desde: '2026-10-5' })).rejects.toThrow(/AAAA-MM-DD/);
    await expect(pedir({ ...atrasos, desde: '2026-02-30' })).rejects.toThrow(/AAAA-MM-DD/);
    await expect(pedir({ ...atrasos, desde: '2026-11-09', hasta: '2026-11-08' })).rejects.toThrow(/posterior a hasta/);
    await expect(pedir({ ...atrasos, hasta: '2026-11-11' })).rejects.toThrow(/posterior a la fecha de la ejecución/);
    await expect(pedir({ ...atrasos, emisores: [] })).rejects.toThrow(/al menos un emisor/);
    await expect(pedir({ ...atrasos, emisores: ['busca', 'busca'] })).rejects.toThrow(/repetido/);
  });
});

describe('consultasFuente', () => {
  // Exactly one query per party and source: with one search per term, a party with 24 names got 12 times the searches of one with 2.
  const partidos = (terminos: Record<string, string[]>) => Object.entries(terminos).map(([partido, t]) => ({ partido, terminos: t }));
  const largos = Array.from({ length: 30 }, (_, n) => `Nombre largo número ${n}`);

  it('gives every party exactly one query of the same form, however many terms it has', () => {
    const consultas = consultasFuente(['medio.es'], partidos({ 'frente-amplio': largos, pp: ['PP', 'Feijóo'], psoe: ['PSOE', 'Pedro Sánchez'], vox: ['Vox'] }));
    expect(consultas.map((c) => c.partido)).toEqual(['frente-amplio', 'pp', 'psoe', 'vox']);
    expect(consultas.slice(1).map((c) => c.texto)).toEqual(['site:medio.es ("PP" OR "Feijóo")', 'site:medio.es ("PSOE" OR "Pedro Sánchez")', 'site:medio.es ("Vox")']);
    for (const c of consultas) expect(c.texto.length).toBeLessThanOrEqual(LONGITUD_MAXIMA_CONSULTA);
    expect(textoConsulta(['es.ara.cat', 'en.ara.cat'], ['PP', 'Te"rm'])).toBe('(site:es.ara.cat OR site:en.ara.cat) ("PP" OR "Term")');
  });

  it('keeps the terms in list order while they fit and records the rest as omitted', () => {
    const { terminos, omitidos } = terminosQueCaben(['medio.es'], largos);
    expect([...terminos, ...omitidos]).toEqual(largos);
    expect(textoConsulta(['medio.es'], terminos).length).toBeLessThanOrEqual(LONGITUD_MAXIMA_CONSULTA);
    expect(textoConsulta(['medio.es'], [...terminos, omitidos[0]!]).length).toBeGreaterThan(LONGITUD_MAXIMA_CONSULTA);
    const [fa] = consultasFuente(['medio.es'], partidos({ 'frente-amplio': largos }));
    expect(fa!.terminos).toEqual(terminos);
    expect(fa!.terminos_omitidos).toEqual(omitidos);
    // A short term after the first one that does not fit is left out too: the list order decides.
    expect(terminosQueCaben(['medio.es'], ['a', 'b', 'c'], 'site:medio.es ("a")'.length)).toEqual({ terminos: ['a'], omitidos: ['b', 'c'] });
    expect(terminosQueCaben(['medio.es'], ['x'.repeat(400), 'b'])).toEqual({ terminos: ['x'.repeat(400)], omitidos: ['b'] });
  });

  it('precomputes the saturation halves of the terms in the query: the first ceil(n/2) and the rest, none for a single term', () => {
    expect(mitadesDe(['a', 'b', 'c'])).toEqual([['a', 'b'], ['c']]);
    expect(mitadesDe(['a'])).toBeUndefined();
    const [pp, vox] = consultasFuente(['medio.es'], partidos({ pp: ['PP', 'Feijóo', 'Tellado'], vox: ['Vox'] }));
    expect(pp!.mitades).toEqual(['site:medio.es ("PP" OR "Feijóo")', 'site:medio.es ("Tellado")']);
    expect(vox!.mitades).toBeUndefined();
    const [fa] = consultasFuente(['medio.es'], partidos({ 'frente-amplio': largos }));
    const [primera, segunda] = mitadesDe(fa!.terminos)!;
    expect(fa!.mitades).toEqual([textoConsulta(['medio.es'], primera), textoConsulta(['medio.es'], segunda)]);
    expect(fa!.mitades!.join(' ')).not.toContain(fa!.terminos_omitidos[0]!);
  });
});

describe('candidate first', () => {
  const largos = Array.from({ length: 30 }, (_, n) => `Nombre largo número ${n}`);

  it('puts each party\'s main candidate first, then the rest in list order, without repeating it', () => {
    expect(candidatoPrimero('Ada Colau', ['Frente Amplio', 'IU', 'Ada Colau', 'Mónica García'], 'frente-amplio')).toEqual(['Ada Colau', 'Frente Amplio', 'IU', 'Mónica García']);
    expect(candidatoPrimero('Alberto Nuñez Feijoo', ['PP', 'Alberto Núñez Feijóo'], 'pp')).toEqual(['Alberto Nuñez Feijoo', 'PP']);
    expect(candidatoPrimero('Santiago Abascal', ['Vox'], 'vox')).toEqual(['Santiago Abascal', 'Vox']);
    expect(() => candidatoPrimero(undefined, ['PSOE'], 'psoe')).toThrow(/falta el candidato principal de psoe/);
    expect(() => candidatoPrimero('  ', ['PSOE'], 'psoe')).toThrow(/tarjeta.candidato/);
  });

  it('keeps the candidate in every party\'s single query, by the same rule, however long its list is', () => {
    const listas: Record<string, string[]> = { 'frente-amplio': [...largos, 'Ada Colau'], pp: ['PP', 'Alberto Núñez Feijóo'], psoe: [...largos.slice(0, 5), 'Pedro Sánchez'], vox: ['Vox'] };
    const cand: Record<string, string> = { 'frente-amplio': 'Ada Colau', pp: 'Alberto Núñez Feijóo', psoe: 'Pedro Sánchez', vox: 'Santiago Abascal' };
    const consultas = consultasFuente(['medio.es'], Object.entries(listas).map(([partido, t]) => ({ partido, terminos: candidatoPrimero(cand[partido], t, partido) })));
    expect(consultas).toHaveLength(4);
    for (const c of consultas) {
      expect(c.terminos[0]).toBe(cand[c.partido]);
      expect(c.texto).toContain(`("${cand[c.partido]}"`);
      expect(c.terminos_omitidos).not.toContain(cand[c.partido]);
    }
  });

  it('fails descubrir, not silently, when a party has no candidate in the site data', async () => {
    const raiz = await mkdtemp(join(tmpdir(), 'n29-candidatos-'));
    try {
      const datos = join(raiz, 'apps', '29n', 'src', 'data', 'partidos');
      await mkdir(datos, { recursive: true });
      await writeFile(join(datos, 'pp.json'), JSON.stringify({ tarjeta: { candidato: ' Alberto Núñez Feijóo ' } }));
      await writeFile(join(datos, 'vox.json'), JSON.stringify({ tarjeta: { lema: 'x' } }));
      expect(await leerCandidatos(raiz, ['pp'])).toEqual({ pp: 'Alberto Núñez Feijóo' });
      await expect(leerCandidatos(raiz, ['pp', 'vox'])).rejects.toThrow('partidos/vox.json: falta tarjeta.candidato');
      const t = new Traedor({ fecha: '2026-11-10', fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch, reloj: () => 0, esperar: async () => {}, resolver: async () => ['93.184.215.14'] });
      await expect(descubrir({ emisores: [], alias, candidatos: { ...candidatos, vox: '' } }, t, { fecha: '2026-11-10' })).rejects.toThrow(/falta el candidato principal de vox/);
      const { psoe: _, ...sinPsoe } = alias;
      await expect(descubrir({ emisores: [], alias: sinPsoe, candidatos }, t, { fecha: '2026-11-10' })).rejects.toThrow('descubrir: falta la entrada de psoe en partidos-alias.json');
    } finally {
      await rm(raiz, { recursive: true, force: true });
    }
  });
});
