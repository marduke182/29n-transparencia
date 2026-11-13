import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Traedor, USER_AGENT, bloqueosDelDia, decodificarCuerpo, crearFetchSeguro, direccionInterna, firmaAntibots, gruposIPv6, guardarVetos, leerRobots, limpiarEvidencia, MAX_EVIDENCIA, lookupPublico, motivoBloqueo, motivoHostNoPublico, permitido, vetoClaude } from './traer.ts';

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
  it('matches the token exactly, case-insensitively (RFC 9309): a prefix group does not apply', () => {
    expect(permitido(leerRobots('User-agent: *\nAllow: /\n\nUser-agent: 29n-transparencia\nDisallow: /'), '/a')).toBe(true);
    expect(permitido(leerRobots('User-agent: *\nAllow: /\n\nUser-agent: 29N-Transparencia-Recogida\nDisallow: /'), '/a')).toBe(false);
  });
  it('merges every group naming the token, and falls back to * only when none does', () => {
    const doble = leerRobots('User-agent: 29n-transparencia-recogida\nDisallow: /a/\n\nUser-agent: *\nDisallow: /\n\nUser-agent: 29n-transparencia-recogida\nDisallow: /b/\n');
    expect([permitido(doble, '/a/x'), permitido(doble, '/b/x'), permitido(doble, '/c')]).toEqual([false, false, true]);
  });
  it('skips empty User-agent values: their rules apply to nobody, and do not join the group before', () => {
    const vacio = leerRobots('User-agent: *\nAllow: /\n\nUser-agent:\nDisallow: /\n');
    expect(permitido(vacio, '/a')).toBe(true);
    expect(permitido(leerRobots('User-agent: *\nDisallow: /x/\nUser-agent:\nDisallow: /\n'), '/a')).toBe(true);
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

  it('judges 6to4 by its IPv4 address and refuses Teredo and IPv4-translated addresses outright', () => {
    // 2002:AABB:CCDD::/16 carries AA.BB.CC.DD.
    for (const ip of ['2002:7f00:1::', '2002:a9fe:a9fe::1', '2002:c0a8:101::1', '2002:a00:1::', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '::ffff:0:8.8.8.8', '::ffff:0:808:808', '::ffff:0:0:0']) {
      expect(direccionInterna(ip), ip).toBe(true);
    }
    for (const ip of ['2002:808:808::1', '2002:5db8:d70e::', '2001:4860:4860::8888']) expect(direccionInterna(ip), ip).toBe(false);
  });

  it('refuses any explicit port but 443, in comprobar and in the connecting fetch', async () => {
    const { traedor: t, llamadas } = traedor({}, publica);
    for (const url of ['https://medio.es:8443/a', 'https://medio.es:80/a', 'https://medio.es:22/a']) {
      expect(await t.traer(url), url).toMatchObject({ estado: 'error', motivo: expect.stringMatching(/solo el puerto 443/) });
      await expect(crearFetchSeguro(async () => [{ address: '93.184.215.14', family: 4 }])(url), url).rejects.toThrow(/solo el puerto 443/);
    }
    expect(llamadas).toEqual([]);
    // An explicit :443 is the default port: allowed (and checked like any other URL).
    expect(await t.comprobar('https://medio.es:443/a')).not.toMatchObject({ motivo: expect.stringMatching(/puerto/) });
  });

  it('refuses a redirect to another port before requesting it', async () => {
    const robots = { status: 200, body: 'User-agent: *\nAllow: /' };
    const { traedor: t, llamadas } = traedor({ 'https://medio.es/robots.txt': robots, 'https://medio.es/a': { status: 302, headers: { location: 'https://medio.es:6379/' } } }, publica);
    expect((await t.traer('https://medio.es/a')).estado).toBe('error');
    expect(llamadas.map((l) => l.url)).toEqual(['https://medio.es/robots.txt', 'https://medio.es/a']);
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

// Shapes of the robots.txt files read on 2026-11-13: one group per agent (elpais.com),
// a shared group with Allow lines (www.abc.es, www.elmundo.es), and a `*` group only (www.eldiario.es).
const ROBOTS_POR_AGENTE = 'User-agent: *\nDisallow: /api/\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: Claude-User\nDisallow: /\n\nUser-agent: Claude-SearchBot\nDisallow: /\n';
const ROBOTS_COMPARTIDO = 'User-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: Claude-User\nUser-agent: Claude-SearchBot\nUser-agent: anthropic-ai\nDisallow: /\nAllow: /uestudio/\n\nUser-agent: *\nDisallow: /buscador/\n';
const ROBOTS_ABIERTO = 'User-agent: *\nDisallow: /api/\nDisallow: /buscador/\n';

describe('vetoClaude', () => {
  it('finds a robots.txt that disallows the root to Claude-User or Claude-SearchBot, with the agents, the rule and the allowed paths', () => {
    expect(vetoClaude(ROBOTS_POR_AGENTE)).toEqual({ agentes: ['Claude-User', 'Claude-SearchBot'], evidencia: 'User-agent: Claude-User · Disallow: /', permitido: [] });
    expect(vetoClaude(ROBOTS_COMPARTIDO)).toEqual({
      agentes: ['ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai'],
      evidencia: 'User-agent: ClaudeBot, Claude-User, Claude-SearchBot, anthropic-ai · Disallow: /',
      permitido: ['/uestudio/'],
    });
    // Only Claude-SearchBot is enough; only ClaudeBot (training) is not.
    expect(vetoClaude('User-agent: Claude-SearchBot\nDisallow: /\n')?.agentes).toEqual(['Claude-SearchBot']);
    expect(vetoClaude('User-agent: ClaudeBot\nDisallow: /\n')).toBeUndefined();
    // A `*` group that disallows everything applies to Claude's agents too.
    expect(vetoClaude('User-agent: *\nDisallow: /\n')).toEqual({ agentes: ['*'], evidencia: 'User-agent: * · Disallow: /', permitido: [] });
    // Path rules for `*`, or a Claude group that allows the root, are not a site block.
    expect(vetoClaude(ROBOTS_ABIERTO)).toBeUndefined();
    // `Disallow: /$` closes only the home page; with `Disallow: /` beside it, or as `/*$`, the site is closed.
    expect(vetoClaude('User-agent: Claude-User\nDisallow: /$\n')).toBeUndefined();
    expect(vetoClaude('User-agent: *\nDisallow: /$\n')).toBeUndefined();
    expect(vetoClaude('User-agent: Claude-User\nDisallow: /\nDisallow: /$\n')).toEqual({ agentes: ['Claude-User'], evidencia: 'User-agent: Claude-User · Disallow: /', permitido: [] });
    expect(vetoClaude('User-agent: Claude-User\nDisallow: /$\nDisallow: /\n')?.evidencia).toBe('User-agent: Claude-User · Disallow: /');
    expect(vetoClaude('User-agent: Claude-SearchBot\nDisallow: /*$\n')).toEqual({ agentes: ['Claude-SearchBot'], evidencia: 'User-agent: Claude-SearchBot · Disallow: /*$', permitido: [] });
    expect(vetoClaude('User-agent: *\nDisallow: /\n\nUser-agent: Claude-User\nUser-agent: Claude-SearchBot\nAllow: /\n')).toBeUndefined();
    expect(vetoClaude('')).toBeUndefined();
  });
});

describe('firmaAntibots', () => {
  const cabeceras = (h: Record<string, string>) => new Headers(h);
  it('names the anti-bot service of a 403 or 429, or of a challenge page with any status', () => {
    expect(firmaAntibots(403, cabeceras({ 'x-datadome': 'protected' }), '')).toBe('DataDome (cabecera x-datadome)');
    expect(firmaAntibots(403, cabeceras({}), '<script src="https://ct.captcha-delivery.com/c.js">')).toBe('DataDome (página de reto)');
    expect(firmaAntibots(403, cabeceras({ 'cf-mitigated': 'challenge' }), '')).toBe('Cloudflare (cf-mitigated: challenge)');
    expect(firmaAntibots(200, cabeceras({}), '<title>Just a moment...</title>')).toBe('Cloudflare (página de reto)');
    expect(firmaAntibots(403, cabeceras({ server: 'AkamaiGHost' }), 'Access Denied')).toBe('Akamai (server: AkamaiGHost)');
    expect(firmaAntibots(429, cabeceras({}), '<p>Please confirm you are not a robot</p>')).toBe('página «no eres un robot»');
    expect(firmaAntibots(403, undefined, '<p>Confirma que no eres un robot</p>')).toBe('página «no eres un robot»');
  });
  it('is undefined for a bare 403, a 401 or 451, and for marker headers on a normal answer', () => {
    expect(firmaAntibots(403, cabeceras({}), 'Forbidden')).toBeUndefined();
    expect(firmaAntibots(401, cabeceras({ 'x-datadome': '1' }), '')).toBeUndefined();
    expect(firmaAntibots(451, cabeceras({}), 'not available in your country')).toBeUndefined();
    expect(firmaAntibots(200, cabeceras({ server: 'AkamaiGHost' }), '<p>Artículo</p>')).toBeUndefined();
  });
});

describe('Traedor: sources that block the guide', () => {
  it('never fetches a host in noTraer (bloqueo, or the fixed list), whatever points at it', async () => {
    const { fn, llamadas } = fetchFalso({});
    const traedor = new Traedor({ fecha: '2026-11-13', fetch: fn, noTraer: ['elpais.com'], ...sinEspera() });
    for (const url of ['https://elpais.com/espana/a.html', 'https://www.elpais.com/b', 'https://feeds.elpais.com/rss']) {
      expect(await traedor.traer(url)).toMatchObject({ estado: 'solo-buzon', motivo: expect.stringMatching(/bloquea a la guía/) });
    }
    expect(llamadas).toEqual([]);
  });

  it('the network checks still come first: an internal address is refused as before', async () => {
    const { fn, llamadas } = fetchFalso({});
    const traedor = new Traedor({ fecha: '2026-11-13', fetch: fn, noTraer: ['interno.es'], ...sinEspera(), resolver: async () => ['10.0.0.1'] });
    expect(await traedor.traer('https://interno.es/a')).toMatchObject({ estado: 'error', motivo: expect.stringMatching(/dirección interna/) });
    expect(llamadas).toEqual([]);
  });

  it('records a robots.txt that excludes Claude\'s agents and fetches nothing else from that host', async () => {
    const { fn, llamadas } = fetchFalso({ 'https://www.medio.es/robots.txt': { status: 200, body: ROBOTS_COMPARTIDO }, 'https://abierto.es/robots.txt': { status: 200, body: ROBOTS_ABIERTO }, 'https://abierto.es/a': { status: 200, body: 'ok' } });
    const traedor = new Traedor({ fecha: '2026-11-13', fetch: fn, ...sinEspera() });
    expect(await traedor.traer('https://www.medio.es/espana/a.html')).toMatchObject({ estado: 'robots', motivo: expect.stringMatching(/no admite agentes de Claude/) });
    expect((await traedor.traer('https://www.medio.es/uestudio/x')).estado).toBe('robots');
    expect((await traedor.traer('https://abierto.es/a')).estado).toBe('ok');
    expect(llamadas.map((l) => l.url)).toEqual(['https://www.medio.es/robots.txt', 'https://abierto.es/robots.txt', 'https://abierto.es/a']);
    expect(traedor.vetos).toEqual({
      'medio.es': {
        tipo: 'robots',
        host: 'medio.es',
        consultado: '2026-11-13',
        url: 'https://www.medio.es/espana/a.html',
        evidencia: 'User-agent: ClaudeBot, Claude-User, Claude-SearchBot, anthropic-ai · Disallow: /',
        robots: 'https://www.medio.es/robots.txt',
        agentes: ['ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai'],
        permitido: ['/uestudio/'],
      },
    });
  });

  it('records an anti-bot answer with its status and marker, and a bare 403 only as a block', async () => {
    const { fn } = fetchFalso({
      'https://dd.es/robots.txt': { status: 200, body: '' },
      'https://dd.es/a': { status: 403, body: '<html>captcha-delivery.com</html>' },
      'https://seco.es/robots.txt': { status: 200, body: '' },
      'https://seco.es/a': { status: 403, body: 'Forbidden' },
    });
    const traedor = new Traedor({ fecha: '2026-11-13', fetch: fn, ...sinEspera() });
    expect((await traedor.traer('https://dd.es/a')).estado).toBe('bloqueado');
    expect((await traedor.traer('https://seco.es/a')).estado).toBe('bloqueado');
    expect(traedor.vetos).toEqual({ 'dd.es': { tipo: 'antibots', host: 'dd.es', consultado: '2026-11-13', url: 'https://dd.es/a', evidencia: 'HTTP 403: DataDome (página de reto)', estado_http: 403 } });
    expect(Object.keys(traedor.bloqueados).sort()).toEqual(['dd.es', 'seco.es']);
  });

  it('rereads a robots.txt even on a noTraer host, through the same network checks', async () => {
    const { fn, llamadas } = fetchFalso({ 'https://elpais.com/robots.txt': { status: 200, body: ROBOTS_POR_AGENTE } });
    const traedor = new Traedor({ fecha: '2026-11-13', fetch: fn, noTraer: ['elpais.com'], ...sinEspera() });
    expect(await traedor.textoRobots('https://elpais.com/robots.txt')).toBe(ROBOTS_POR_AGENTE);
    expect(await traedor.textoRobots('https://elpais.com/otra')).toBeUndefined();
    expect(await traedor.textoRobots('http://elpais.com/robots.txt')).toBeUndefined();
    expect(await new Traedor({ fecha: '2026-11-13', fetch: fn, ...sinEspera(), resolver: async () => ['127.0.0.1'] }).textoRobots('https://elpais.com/robots.txt')).toBeUndefined();
    expect(llamadas.map((l) => l.url)).toEqual(['https://elpais.com/robots.txt']);
  });

  it('guardarVetos keeps each host\'s first record and marks an anti-bot block seen for the first time', async () => {
    const carpeta = await mkdtemp(join(tmpdir(), 'n29-vetos-'));
    const ruta = join(carpeta, 'bloqueos-guia.json');
    const antibots = (host: string) => ({ tipo: 'antibots' as const, host, consultado: '2026-11-13', url: `https://${host}/`, evidencia: 'HTTP 403: DataDome (página de reto)', estado_http: 403 });
    await guardarVetos(ruta, {}, {});
    await expect(readFile(ruta, 'utf8')).rejects.toThrow();
    await guardarVetos(ruta, { 'b.es': antibots('b.es'), 'a.es': antibots('a.es') }, { 'a.es': { fecha: '2026-11-10', estado_http: 403, motivo: 'HTTP 403', url: 'https://a.es/' } });
    await guardarVetos(ruta, { 'b.es': { ...antibots('b.es'), evidencia: 'otra' } }, {});
    const guardado = JSON.parse(await readFile(ruta, 'utf8'));
    expect(Object.keys(guardado)).toEqual(['a.es', 'b.es']);
    expect(guardado['a.es'].primera).toBe(false);
    expect(guardado['b.es']).toMatchObject({ primera: true, evidencia: 'HTTP 403: DataDome (página de reto)' });
    await rm(carpeta, { recursive: true, force: true });
  });
});

describe('vetoClaude: RFC 9309 group matching', () => {
  it('a Claude group does not apply to Claude-User, in either order', () => {
    expect(vetoClaude('User-agent: Claude\nDisallow: /\n\nUser-agent: Claude-User\nAllow: /\n')).toBeUndefined();
    expect(vetoClaude('User-agent: Claude-User\nAllow: /\n\nUser-agent: Claude\nDisallow: /\n')).toBeUndefined();
    // With only a Claude group, Claude-User and Claude-SearchBot fall back to `*`.
    expect(vetoClaude('User-agent: Claude\nDisallow: /\n\nUser-agent: *\nAllow: /\n')).toBeUndefined();
  });
  it('merges duplicate Claude-User groups, naming each agent once', () => {
    expect(vetoClaude('User-agent: Claude-User\nDisallow: /privado/\n\nUser-agent: *\nAllow: /\n\nUser-agent: claude-user\nDisallow: /\n')).toEqual({
      agentes: ['Claude-User'],
      evidencia: 'User-agent: Claude-User · Disallow: /',
      permitido: [],
    });
    // One group for both agents: listed once, not once per agent.
    expect(vetoClaude('User-agent: Claude-User\nUser-agent: Claude-SearchBot\nUser-agent: Claude-User\nDisallow: /\n')?.agentes).toEqual(['Claude-User', 'Claude-SearchBot']);
  });
  it('skips empty User-agent values: no group of agents, no veto', () => {
    expect(vetoClaude('User-agent:\nDisallow: /\n')).toBeUndefined();
    expect(vetoClaude('User-agent:\nUser-agent: Claude-SearchBot\nDisallow: /\n')?.agentes).toEqual(['Claude-SearchBot']);
  });
  it('keeps the evidence plain and short: no control characters, no HTML or code marks, at most MAX_EVIDENCIA characters', () => {
    const veto = vetoClaude(`User-agent: Claude-User<script>\u0007\nUser-agent: Claude-User\nDisallow: /\nAllow: /\`x\`<b>${'a'.repeat(400)}\n`)!;
    expect(veto.evidencia).toBe('User-agent: Claude-User script , Claude-User · Disallow: /');
    expect(veto.agentes).toEqual(['Claude-User script', 'Claude-User']);
    expect(veto.permitido[0]).toMatch(/^\/ x b a+…$/);
    expect(veto.permitido[0]!.length).toBe(100);
    expect(limpiarEvidencia(`a\u0000b<c>\`d\`\n${'x'.repeat(500)}`)).toHaveLength(MAX_EVIDENCIA);
    expect(limpiarEvidencia('a\u0000b<c>`d`')).toBe('a b c d');
  });
});
