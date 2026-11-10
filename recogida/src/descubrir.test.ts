import { describe, expect, it, vi } from 'vitest';
import { LISTADOS_DEBATES, accesoDesdeRegistro, descubrir, fechaIso, leerFeed, leerSeccion, leerSitemap, restarDias, type Alias, type Emisor, type Listado } from './descubrir.ts';
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
    id: 'web-podemos',
    nombre: 'Web de Podemos',
    hosts: ['podemos.info'],
    tipo: 'partido',
    partido: 'podemos',
    acceso: { estado: 'parcial', comprobado: '2026-11-10', detalle: 'Artículos 403; feed legible.' },
    recogida: { metodo: 'rss', url: 'https://podemos.info/feed/' },
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
  pp: { nombres: ['PP'], marcas_regionales: [], miembros: [], personas: ['Persona Uno'], excluir: [] },
  vox: { nombres: ['Vox'], marcas_regionales: [], miembros: [], personas: [], excluir: ['Vox Populi'] },
};
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
  'https://podemos.info/feed/': {
    status: 200,
    type: 'application/rss+xml; charset=utf-8',
    body: `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>Nota</title><link>https://podemos.info/nota-vivienda/</link><pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate><content:encoded><![CDATA[<p>Texto completo de la nota.</p>]]></content:encoded></item></channel></rss>`,
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
    expect(accesoDesdeRegistro(emisores)).toEqual({ soloBuzon: ['voxespana.es'], soloListado: { 'podemos.info': ['https://podemos.info/feed/'] } });
    const psoe: Emisor = { id: 'web-psoe', nombre: 'PSOE', hosts: ['psoe.es'], tipo: 'partido', acceso: { estado: 'bloqueado', comprobado: '2026-11-10', detalle: 'reto' } };
    expect(accesoDesdeRegistro([psoe]).soloBuzon).toEqual(['psoe.es']);
    expect(accesoDesdeRegistro([{ ...psoe, recogida: { metodo: 'rss', url: 'https://psoe.es/feed' } }]).soloListado).toEqual({ 'psoe.es': ['https://psoe.es/feed'] });
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
    const resultado = await descubrir({ emisores, alias }, t, { fecha: '2026-11-10', dias: 2, listados });

    expect(resultado.candidatos.map((c) => [c.emisor, c.url_canonica, c.metodo, c.genero])).toEqual([
      ['boe', 'https://boe.es/diario_boe/txt.php?id=BOE-A-2026-1', 'api', 'documento'],
      ['cis', 'https://cis.es/es/avance-de-resultados/estudio-3550', 'seccion', 'documento'],
      ['diario', 'https://diario.es/2026/11/09/nota', 'sitemap', 'articulo'],
      ['la-moncloa-gobierno', 'https://lamoncloa.gob.es/presidente/intervenciones/Paginas/2026/prensa101126.aspx', 'seccion', 'transcripcion'],
      ['medio', 'https://medio.es/politica/2026/11/10/debate.html', 'rss', 'articulo'],
      ['web-podemos', 'https://podemos.info/nota-vivienda', 'rss', 'documento'],
    ]);
    // Pages of podemos.info block: the feed text travels with the candidate; other feeds don't carry it.
    expect(resultado.candidatos.find((c) => c.emisor === 'web-podemos')!.contenido_feed).toBe('<p>Texto completo de la nota.</p>');
    expect(resultado.candidatos.find((c) => c.emisor === 'medio')!.contenido_feed).toBeUndefined();
    expect(resultado.tareas_busqueda).toEqual([
      {
        emisor: 'busca',
        nombre: 'Busca',
        hosts: ['busca.es'],
        consultas: [
          { partido: 'pp', terminos: ['PP', 'Persona Uno'], excluir: [] },
          { partido: 'vox', terminos: ['Vox'], excluir: ['Vox Populi'] },
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
    expect(pedidas.filter((url) => url.includes('podemos.info'))).toEqual(['https://podemos.info/robots.txt', 'https://podemos.info/feed/']);
    expect(pedidas.some((url) => url.includes('voxespana.es'))).toBe(false);
  });
});
