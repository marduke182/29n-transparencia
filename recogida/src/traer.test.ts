import { describe, expect, it, vi } from 'vitest';
import { Traedor, USER_AGENT, bloqueosDelDia, decodificarCuerpo, crearFetchSeguro, direccionInterna, gruposIPv6, leerRobots, lookupPublico, motivoBloqueo, motivoHostNoPublico, permitido } from './traer.ts';

type Ruta = { status: number; body?: string; headers?: Record<string, string> };

/** A fake fetch serving fixed routes; records every request and its headers. */
function fetchFalso(rutas: Record<string, Ruta>) {
  const llamadas: { url: string; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), headers: init?.headers as Record<string, string> });
    const ruta = rutas[String(url)] ?? { status: 404, body: '' };
    return new Response(ruta.body ?? '', { status: ruta.status, headers: { 'content-type': 'text/html', ...ruta.headers } });
  });
  return { fn: fn as unknown as typeof fetch, llamadas };
}

const sinEspera = () => {
  let ahora = 0;
  const esperas: number[] = [];
  return {
    resolver: async () => ['93.184.215.14'],
    reloj: () => ahora,
    esperar: async (ms: number) => {
      esperas.push(ms);
      ahora += ms;
    },
    esperas,
  };
};

describe('robots.txt', () => {
  const robots = leerRobots('User-agent: *\nDisallow: /privado/\nAllow: /privado/publico\nCrawl-delay: 10\n\nUser-agent: OtroBot\nDisallow: /');
  it('applies the * group with longest-match precedence', () => {
    expect(permitido(robots, '/noticia')).toBe(true);
    expect(permitido(robots, '/privado/x')).toBe(false);
    expect(permitido(robots, '/privado/publico/x')).toBe(true);
    expect(robots.esperaMs).toBe(10_000);
  });
  it('prefers a group naming our token', () => {
    const propio = leerRobots('User-agent: *\nAllow: /\n\nUser-agent: 29n-transparencia-recogida\nDisallow: /');
    expect(permitido(propio, '/a')).toBe(false);
  });
});

describe('decodificarCuerpo', () => {
  it('uses the charset of the content type', () => {
    expect(decodificarCuerpo('text/html; charset=iso-8859-1', new Uint8Array([0x65, 0x6c, 0x65, 0x63, 0x63, 0x69, 0xf3, 0x6e]))).toBe('elección');
    expect(decodificarCuerpo('text/html', new TextEncoder().encode('elección'))).toBe('elección');
  });
});

describe('motivoBloqueo', () => {
  it('detects statuses, challenge pages and geo-blocks', () => {
    expect(motivoBloqueo(403, '')).toBe('HTTP 403');
    expect(motivoBloqueo(429, '')).toBe('HTTP 429');
    expect(motivoBloqueo(503, '<title>Just a moment...</title>')).toMatch(/reto/);
    expect(motivoBloqueo(200, '<script src="/_Incapsula_Resource?x"></script>')).toMatch(/reto/);
    expect(motivoBloqueo(200, 'Este contenido no está disponible en tu país')).toMatch(/geográfico/);
    expect(motivoBloqueo(200, '<p>Una noticia</p>')).toBeUndefined();
  });
});

describe('Traedor', () => {
  it('sends the honest User-Agent, reads robots once and waits between requests to the same host', async () => {
    const { fn, llamadas } = fetchFalso({
      'https://medio.es/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' },
      'https://medio.es/a': { status: 200, body: '<p>a</p>' },
      'https://medio.es/b': { status: 200, body: '<p>b</p>' },
    });
    const tiempo = sinEspera();
    const traedor = new Traedor({ fecha: '2026-11-10', fetch: fn, ...tiempo });
    expect((await traedor.traer('https://medio.es/a')).estado).toBe('ok');
    expect((await traedor.traer('https://medio.es/b')).estado).toBe('ok');
    expect(llamadas.map((l) => l.url)).toEqual(['https://medio.es/robots.txt', 'https://medio.es/a', 'https://medio.es/b']);
    expect(llamadas.every((l) => l.headers['User-Agent'] === USER_AGENT)).toBe(true);
    expect(tiempo.esperas).toEqual([5000, 5000]);
  });

  it('a 403 records the host as bloqueado with the date and stops that host, with no retry', async () => {
    const { fn, llamadas } = fetchFalso({
      'https://medio.es/robots.txt': { status: 200, body: '' },
      'https://medio.es/a': { status: 403, body: 'Forbidden' },
      'https://otro.es/robots.txt': { status: 404 },
      'https://otro.es/c': { status: 200, body: 'ok' },
    });
    const traedor = new Traedor({ fecha: '2026-11-10', fetch: fn, ...sinEspera() });
    const primera = await traedor.traer('https://medio.es/a');
    expect(primera).toMatchObject({ estado: 'bloqueado', bloqueo: { fecha: '2026-11-10', estado_http: 403, motivo: 'HTTP 403' } });
    expect((await traedor.traer('https://medio.es/b')).estado).toBe('bloqueado');
    expect((await traedor.traer('https://www.medio.es/a')).estado).toBe('bloqueado');
    expect((await traedor.traer('https://otro.es/c')).estado).toBe('ok');
    // One request to /a, none after the block, never with another User-Agent.
    expect(llamadas.filter((l) => l.url.startsWith('https://medio.es/')).map((l) => l.url)).toEqual(['https://medio.es/robots.txt', 'https://medio.es/a']);
    expect(new Set(llamadas.map((l) => l.headers['User-Agent']))).toEqual(new Set([USER_AGENT]));
    expect(traedor.bloqueados['medio.es']).toMatchObject({ fecha: '2026-11-10', estado_http: 403 });
  });

  it('treats a challenge page with status 200 as a block', async () => {
    const { fn } = fetchFalso({
      'https://medio.es/robots.txt': { status: 200, body: '' },
      'https://medio.es/a': { status: 200, body: '<html><title>Attention Required! | Cloudflare</title></html>' },
    });
    const traedor = new Traedor({ fecha: '2026-11-10', fetch: fn, ...sinEspera() });
    expect((await traedor.traer('https://medio.es/a')).estado).toBe('bloqueado');
  });

  it('never fetches inbox-only hosts (psoe.es and voxespana.es by default)', async () => {
    const { fn, llamadas } = fetchFalso({});
    const traedor = new Traedor({ fecha: '2026-11-10', fetch: fn, ...sinEspera() });
    for (const url of ['https://www.psoe.es/x', 'https://voxespana.es/y']) expect((await traedor.traer(url)).estado).toBe('solo-buzon');
    expect(llamadas).toEqual([]);
  });

  it('on a soloListado host reads only the listed feed, never its pages', async () => {
    const { fn, llamadas } = fetchFalso({
      'https://partido-ejemplo.es/robots.txt': { status: 200, body: '' },
      'https://partido-ejemplo.es/feed/': { status: 200, body: '<rss></rss>', headers: { 'content-type': 'application/rss+xml' } },
    });
    const traedor = new Traedor({ fecha: '2026-11-10', fetch: fn, ...sinEspera(), soloBuzon: [], soloListado: { 'partido-ejemplo.es': ['https://partido-ejemplo.es/feed/'] } });
    expect((await traedor.traer('https://partido-ejemplo.es/feed/')).estado).toBe('ok');
    expect(await traedor.traer('https://partido-ejemplo.es/noticias/x/')).toMatchObject({ estado: 'solo-buzon' });
    expect(llamadas.map((l) => l.url)).toEqual(['https://partido-ejemplo.es/robots.txt', 'https://partido-ejemplo.es/feed/']);
  });

  it('a 403 on a soloListado feed still blocks the host', async () => {
    const { fn } = fetchFalso({ 'https://partido-ejemplo.es/robots.txt': { status: 200, body: '' }, 'https://partido-ejemplo.es/feed/': { status: 403 } });
    const traedor = new Traedor({ fecha: '2026-11-10', fetch: fn, ...sinEspera(), soloBuzon: [], soloListado: { 'partido-ejemplo.es': ['https://partido-ejemplo.es/feed/'] } });
    expect(await traedor.traer('https://partido-ejemplo.es/feed/')).toMatchObject({ estado: 'bloqueado', bloqueo: { estado_http: 403 } });
  });

  it('respects a robots Disallow and follows redirects through the same checks', async () => {
    const { fn, llamadas } = fetchFalso({
      'https://medio.es/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /privado' },
      'https://medio.es/viejo': { status: 301, headers: { location: 'https://psoe.es/nuevo' } },
    });
    const traedor = new Traedor({ fecha: '2026-11-10', fetch: fn, ...sinEspera() });
    expect((await traedor.traer('https://medio.es/privado/a')).estado).toBe('robots');
    expect((await traedor.traer('https://medio.es/viejo')).estado).toBe('solo-buzon');
    expect(llamadas.map((l) => l.url)).toEqual(['https://medio.es/robots.txt', 'https://medio.es/viejo']);
  });

  it('skips hosts blocked earlier the same day', async () => {
    const { fn, llamadas } = fetchFalso({});
    const previos = { 'medio.es': { fecha: '2026-11-10', estado_http: 429, motivo: 'HTTP 429', url: 'https://medio.es/a' } };
    const traedor = new Traedor({ fecha: '2026-11-10', fetch: fn, ...sinEspera(), bloqueados: bloqueosDelDia(previos, '2026-11-10') });
    expect((await traedor.traer('https://medio.es/z')).estado).toBe('bloqueado');
    expect(llamadas).toEqual([]);
    expect(bloqueosDelDia(previos, '2026-11-11')).toEqual({});
  });
});

describe('red pública', () => {
  it('classifies internal addresses', () => {
    const internas = [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '198.18.0.1', '198.19.255.255', '192.0.0.8', '192.0.2.1', '198.51.100.7', '203.0.113.10',
      '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1', '64:ff9b::8.8.8.8',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::127.0.0.1', '::a00:1', '[::1]', 'fe80::1%en0', 'no-es-ip',
    ];
    for (const ip of internas) expect(direccionInterna(ip), ip).toBe(true);
    for (const ip of ['93.184.215.14', '8.8.8.8', '172.32.0.1', '198.20.0.1', '2a00:1450::1', '::ffff:8.8.8.8', '::ffff:808:808', '::8.8.8.8']) expect(direccionInterna(ip), ip).toBe(false);
  });

  it('refuses IP literals, localhost, .local and single-label hosts', () => {
    expect(motivoHostNoPublico('127.0.0.1')).toMatch(/dirección IP/);
    expect(motivoHostNoPublico('[::1]')).toMatch(/dirección IP/);
    expect(motivoHostNoPublico('localhost')).toMatch(/no es un host público/);
    expect(motivoHostNoPublico('impresora.local')).toMatch(/no es un host público/);
    expect(motivoHostNoPublico('intranet')).toMatch(/no es un host público/);
    expect(motivoHostNoPublico('medio.es')).toBeUndefined();
  });

  const traedor = (rutas: Record<string, Ruta>, resolver: (host: string) => Promise<string[]>) => {
    const falso = fetchFalso(rutas);
    return { ...falso, traedor: new Traedor({ fecha: '2026-11-10', fetch: falso.fn, ...sinEspera(), resolver }) };
  };
  const publica = async () => ['93.184.215.14'];

  it('requires https and never requests a non-public host', async () => {
    const { traedor: t, llamadas } = traedor({}, publica);
    expect(await t.traer('http://medio.es/a')).toMatchObject({ estado: 'error', motivo: expect.stringMatching(/solo https/) });
    expect(await t.traer('https://127.0.0.1/a')).toMatchObject({ estado: 'error', motivo: expect.stringMatching(/dirección IP/) });
    expect(await t.traer('https://nas.local/a')).toMatchObject({ estado: 'error' });
    expect(llamadas).toEqual([]);
  });

  it('checks every redirect hop: an http, IP or internal-resolving target is refused before any request to it', async () => {
    const resolver = async (host: string) => (host === 'interno.es' ? ['10.0.0.5'] : ['93.184.215.14']);
    const robots = { status: 200, body: 'User-agent: *\nAllow: /' };
    for (const destino of ['http://medio.es/b', 'https://169.254.169.254/latest/meta-data/', 'https://interno.es/admin']) {
      const { traedor: t, llamadas } = traedor({ 'https://medio.es/robots.txt': robots, 'https://medio.es/a': { status: 302, headers: { location: destino } } }, resolver);
      const respuesta = await t.traer('https://medio.es/a');
      expect(respuesta.estado, destino).toBe('error');
      expect(llamadas.map((l) => l.url)).toEqual(['https://medio.es/robots.txt', 'https://medio.es/a']);
    }
  });

  it('expands IPv6 groups, with embedded dotted quads', () => {
    expect(gruposIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(gruposIPv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(gruposIPv6('1.2.3.4')).toBeUndefined();
  });

  it('checks addresses again at connect time: lookupPublico drops internal ones and fails when none is left', async () => {
    const lookup = (direcciones: { address: string; family: number }[]) => (opciones: { all?: boolean } | undefined) =>
      new Promise<unknown>((hecho) => lookupPublico(async () => direcciones)('medio.es', opciones, (error, direccion, familia) => hecho(error ? error.message : { direccion, familia })));
    expect(await lookup([{ address: '10.0.0.1', family: 4 }, { address: '93.184.215.14', family: 4 }])(undefined)).toEqual({ direccion: '93.184.215.14', familia: 4 });
    expect(await lookup([{ address: '10.0.0.1', family: 4 }, { address: '93.184.215.14', family: 4 }])({ all: true })).toEqual({ direccion: [{ address: '93.184.215.14', family: 4 }], familia: undefined });
    expect(await lookup([{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }])(undefined)).toMatch(/solo resuelve a direcciones internas/);
  });

  it('DNS rebinding: a host public at check time but internal at connect time is never reached', async () => {
    const fetch = crearFetchSeguro(async () => [{ address: '169.254.169.254', family: 4 }]);
    const t = new Traedor({ fecha: '2026-11-10', fetch, ...sinEspera() });
    const respuesta = await t.traer('https://medio.es/a');
    expect(respuesta.estado).toBe('robots');
    await expect(fetch('https://medio.es/robots.txt')).rejects.toThrow(/direcciones internas/);
    await expect(crearFetchSeguro()('http://medio.es/a')).rejects.toThrow(/solo https/);
  });

  it('refuses a host that does not resolve', async () => {
    const { traedor: t, llamadas } = traedor({}, async () => {
      throw new Error('ENOTFOUND');
    });
    expect(await t.traer('https://no-existe.es/a')).toMatchObject({ estado: 'error', motivo: expect.stringMatching(/no resuelve/) });
    expect(llamadas).toEqual([]);
  });
});
