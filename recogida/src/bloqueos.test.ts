import { describe, expect, it } from 'vitest';
import { SIN_AGENTES_CLAUDE_FIJOS, cambiosFuentesNoAdmitidos, emisorDeHost, hostsSinClaude, registrarBloqueos, reglasWebFetch, revisarBloqueos } from './bloqueos.ts';
import type { Emisor } from './descubrir.ts';
import type { VetoGuia } from './traer.ts';

const FECHA = '2026-11-13';
const emisores: Emisor[] = [
  { id: 'el-pais', nombre: 'El País', hosts: ['elpais.com'], tipo: 'medio', recogida: { metodo: 'omitir', nota: 'x' }, bloqueo: { tipo: 'robots', evidencia: 'User-agent: Claude-User · Disallow: /', consultado: '2026-11-13', robots: 'https://elpais.com/robots.txt', agentes: ['Claude-User', 'Claude-SearchBot'] } },
  { id: 'medio', nombre: 'Medio', hosts: ['medio.es'], tipo: 'medio', recogida: { metodo: 'rss', url: 'https://medio.es/rss' } },
  { id: 'busca', nombre: 'Busca', hosts: ['busca.es'], tipo: 'medio' },
];
const registro = { meta: { version: 1 }, emisores };

const robots = (host: string, extra: Partial<VetoGuia> = {}): VetoGuia => ({
  tipo: 'robots',
  host,
  consultado: FECHA,
  url: `https://www.${host}/a`,
  evidencia: 'User-agent: Claude-User · Disallow: /',
  robots: `https://www.${host}/robots.txt`,
  agentes: ['Claude-User'],
  ...extra,
});
const antibots = (host: string, primera: boolean): VetoGuia => ({ tipo: 'antibots', host, consultado: FECHA, url: `https://${host}/a`, evidencia: 'HTTP 403: DataDome (página de reto)', estado_http: 403, primera });

describe('hostsSinClaude and reglasWebFetch', () => {
  it('denies the fixed list, every emisor with bloqueo and today\'s robots vetos, host and subdomains', () => {
    expect(SIN_AGENTES_CLAUDE_FIJOS).toEqual(['abc.es', 'elmundo.es', 'elpais.com']);
    expect(hostsSinClaude(emisores, [robots('nuevo.es'), antibots('dd.es', true)])).toEqual(['abc.es', 'elmundo.es', 'elpais.com', 'nuevo.es']);
    expect(hostsSinClaude([])).toEqual(['abc.es', 'elmundo.es', 'elpais.com']);
    expect(reglasWebFetch(['elpais.com'])).toEqual(['WebFetch(domain:elpais.com)', 'WebFetch(domain:*.elpais.com)']);
    expect(() => reglasWebFetch(['*'])).toThrow(/no admitido/);
  });
});

describe('registrarBloqueos', () => {
  it('adds a minimal emisor for an unknown host, named after it, for review', () => {
    const { registro: nuevo, informe, cambiado } = registrarBloqueos(registro, [robots('nuevo-medio.com', { permitido: ['/libre/'] })], FECHA);
    expect(cambiado).toBe(true);
    expect(nuevo.meta).toEqual({ version: 1 });
    expect(nuevo.emisores.slice(0, 3)).toEqual(emisores);
    expect(nuevo.emisores[3]).toEqual({
      id: 'nuevo-medio-com',
      nombre: 'nuevo-medio.com',
      hosts: ['nuevo-medio.com'],
      tipo: 'medio',
      recogida: { metodo: 'omitir', nota: 'Su robots.txt no permite el acceso de los agentes de Claude (Claude-User), consultado el 13 nov 2026. No se recogen.' },
      bloqueo: { tipo: 'robots', evidencia: 'User-agent: Claude-User · Disallow: / · Allow: /libre/', consultado: FECHA, robots: 'https://www.nuevo-medio.com/robots.txt', agentes: ['Claude-User'] },
    });
    expect(informe.nuevos).toEqual([{ id: 'nuevo-medio-com', host: 'nuevo-medio.com', evidencia: 'User-agent: Claude-User · Disallow: /' }]);
    // The input is not changed, and the change passes the allowlist.
    expect(registro.emisores).toHaveLength(3);
    expect(cambiosFuentesNoAdmitidos(registro, nuevo)).toEqual([]);
  });

  it('sets bloqueo and recogida omitir on an existing emisor (subdomains included), leaving the rest of it', () => {
    const { registro: nuevo, informe } = registrarBloqueos(registro, [robots('medio.es')], FECHA);
    expect(nuevo.emisores[1]).toEqual({ ...emisores[1], recogida: expect.objectContaining({ metodo: 'omitir' }), bloqueo: { tipo: 'robots', evidencia: 'User-agent: Claude-User · Disallow: /', consultado: FECHA, robots: 'https://www.medio.es/robots.txt', agentes: ['Claude-User'] } });
    expect(informe.actualizados).toEqual([{ id: 'medio', host: 'medio.es', evidencia: 'User-agent: Claude-User · Disallow: /', antes: 'recogida rss' }]);
    expect(cambiosFuentesNoAdmitidos(registro, nuevo)).toEqual([]);
    // A robots.txt read on a subdomain the emisor does not list is reported, not written.
    const sub = registrarBloqueos(registro, [robots('feeds.medio.es', { robots: 'https://feeds.medio.es/robots.txt' })], FECHA);
    expect(sub.cambiado).toBe(false);
    expect(sub.informe.sin_registrar).toEqual([expect.objectContaining({ host: 'feeds.medio.es', id: 'medio', motivo: expect.stringMatching(/subdominio/) })]);
  });

  it('changes nothing when the same reading is already recorded', () => {
    const mismo = robots('elpais.com', { robots: 'https://elpais.com/robots.txt', agentes: ['Claude-SearchBot', 'Claude-User'], consultado: '2026-11-20' });
    const { registro: nuevo, informe, cambiado } = registrarBloqueos(registro, [mismo], '2026-11-20');
    expect(cambiado).toBe(false);
    expect(nuevo.emisores).toEqual(emisores);
    expect(informe.ya_registrados).toEqual([{ id: 'el-pais', host: 'elpais.com' }]);
  });

  it('reports anti-bot blocks, first time or not, without writing them (the site\'s bloqueo describes a robots.txt)', () => {
    const { cambiado, informe } = registrarBloqueos(registro, [antibots('dd.es', true), antibots('busca.es', false)], FECHA);
    expect(cambiado).toBe(false);
    expect(informe.sin_registrar).toEqual([
      expect.objectContaining({ host: 'busca.es', id: 'busca', tipo: 'antibots', primera: false, motivo: expect.stringMatching(/^para revisar/) }),
      expect.objectContaining({ host: 'dd.es', tipo: 'antibots', primera: true }),
    ]);
  });

  it('never writes a party website: reported for review, the same rule for the four', () => {
    const web: Emisor = { id: 'web-pp', nombre: 'Web del PP', hosts: ['pp.es'], tipo: 'partido', partido: 'pp', acceso: { estado: 'abierto', comprobado: FECHA, detalle: 'ok' } };
    const { cambiado, informe } = registrarBloqueos({ emisores: [...emisores, web] }, [robots('pp.es')], FECHA);
    expect(cambiado).toBe(false);
    expect(informe.sin_registrar).toEqual([expect.objectContaining({ host: 'pp.es', id: 'web-pp', tipo: 'robots', motivo: expect.stringMatching(/^para revisar: la web de un partido/) })]);
    // And the allowlist refuses any bloqueo or recogida change on it.
    const antes = { emisores: [web] };
    const tocado = { emisores: [{ ...web, recogida: { metodo: 'omitir', nota: 'x' }, bloqueo: { tipo: 'robots', evidencia: 'e', consultado: FECHA, robots: 'https://pp.es/robots.txt', agentes: ['Claude-User'] } }] };
    expect(cambiosFuentesNoAdmitidos(antes, tocado)).toEqual(['fuentes.web-pp: la web de un partido no cambia sola (bloqueo y recogida, a mano)']);
  });

  it('reports a robots veto without agents for review, with its own reason', () => {
    const { cambiado, informe } = registrarBloqueos(registro, [robots('nuevo.es', { agentes: [] })], FECHA);
    expect(cambiado).toBe(false);
    expect(informe.sin_registrar).toEqual([expect.objectContaining({ host: 'nuevo.es', tipo: 'robots', motivo: 'para revisar: robots.txt sin agentes ni regla que citar; no se escribe solo' })]);
  });

  it('matches a host to its own emisor before a parent domain\'s, in either registry order', () => {
    const padre: Emisor = { id: 'el-espanol', nombre: 'El Español', hosts: ['elespanol.com'], tipo: 'medio' };
    const hijo: Emisor = { id: 'diario-de-avisos', nombre: 'Diario de Avisos', hosts: ['diariodeavisos.elespanol.com'], tipo: 'medio' };
    for (const orden of [[padre, hijo], [hijo, padre]]) {
      expect(emisorDeHost(orden, 'diariodeavisos.elespanol.com')?.id).toBe('diario-de-avisos');
      expect(emisorDeHost(orden, 'elespanol.com')?.id).toBe('el-espanol');
      expect(emisorDeHost(orden, 'otro.elespanol.com')?.id).toBe('el-espanol');
      const veto = robots('diariodeavisos.elespanol.com', { robots: 'https://diariodeavisos.elespanol.com/robots.txt' });
      const { informe } = registrarBloqueos({ emisores: orden }, [veto], FECHA);
      expect(informe.actualizados.map((a) => a.id)).toEqual(['diario-de-avisos']);
    }
  });

  it('gives a new emisor an id not yet used', () => {
    const conId: Emisor[] = [...emisores, { id: 'otro-es', nombre: 'Otro', hosts: ['otro.net'], tipo: 'medio' }];
    expect(registrarBloqueos({ emisores: conId }, [robots('otro.es')], FECHA).registro.emisores.at(-1)!.id).toBe('otro-es-2');
  });
});

describe('revisarBloqueos', () => {
  it('lists recorded bloqueos whose robots.txt no longer excludes Claude\'s agents, or could not be read; changes nothing', async () => {
    const textos: Record<string, string | undefined> = { 'https://elpais.com/robots.txt': 'User-agent: *\nDisallow: /api/\n' };
    const otro: Emisor = { ...emisores[0]!, id: 'otro', hosts: ['otro.es'], bloqueo: { tipo: 'robots', evidencia: 'x', consultado: FECHA, robots: 'https://otro.es/robots.txt', agentes: ['Claude-User'] } };
    const sigue: Emisor = { ...emisores[0]!, id: 'sigue', hosts: ['sigue.es'], bloqueo: { tipo: 'robots', evidencia: 'x', consultado: FECHA, robots: 'https://sigue.es/robots.txt', agentes: ['Claude-User'] } };
    textos['https://sigue.es/robots.txt'] = 'User-agent: Claude-User\nDisallow: /\n';
    expect(await revisarBloqueos([...emisores, otro, sigue], { textoRobots: async (url) => textos[url] })).toEqual({
      ya_no_bloquean: [{ id: 'el-pais', robots: 'https://elpais.com/robots.txt' }],
      sin_comprobar: [{ id: 'otro', robots: 'https://otro.es/robots.txt' }],
    });
  });
});

describe('cambiosFuentesNoAdmitidos (allowlist of fuentes.json)', () => {
  const copia = () => structuredClone(registro) as unknown as { meta: unknown; emisores: Record<string, unknown>[] };
  it('accepts no change, and key order alone', () => {
    expect(cambiosFuentesNoAdmitidos(registro, copia())).toEqual([]);
    const reordenado = copia();
    reordenado.emisores[1] = Object.fromEntries(Object.entries(reordenado.emisores[1]!).reverse());
    expect(cambiosFuentesNoAdmitidos(registro, reordenado)).toEqual([]);
  });
  it('refuses any other change', () => {
    const nombre = copia();
    nombre.emisores[1]!.nombre = 'Otro';
    expect(cambiosFuentesNoAdmitidos(registro, nombre)).toEqual(['fuentes.medio: cambió algo más que bloqueo y recogida']);
    const sinBloqueo = copia();
    delete sinBloqueo.emisores[0]!.bloqueo;
    expect(cambiosFuentesNoAdmitidos(registro, sinBloqueo)).toContain('fuentes.el-pais: se quitó el bloqueo (nunca se quita solo)');
    const recogida = copia();
    recogida.emisores[1]!.recogida = { metodo: 'busqueda' };
    expect(cambiosFuentesNoAdmitidos(registro, recogida)).toEqual(['fuentes.medio: bloqueo no tiene la forma esperada', 'fuentes.medio: con bloqueo, recogida debe ser omitir']);
    const fuera = copia();
    fuera.meta = { version: 2 };
    expect(cambiosFuentesNoAdmitidos(registro, fuera)).toEqual(['fuentes.json: cambió algo fuera de emisores']);
    const quitado = copia();
    quitado.emisores.pop();
    expect(cambiosFuentesNoAdmitidos(registro, quitado)).toEqual(['fuentes.json: se quitaron emisores']);
    const movido = copia();
    movido.emisores.reverse();
    expect(cambiosFuentesNoAdmitidos(registro, movido)).toContain('fuentes.emisores[1]: cambió de sitio o de id');
    const nuevo = registrarBloqueos(registro, [robots('nuevo.es')], FECHA).registro as unknown as ReturnType<typeof copia>;
    nuevo.emisores[3]!.nota = 'algo';
    nuevo.emisores[3]!.tipo = 'oficial';
    expect(cambiosFuentesNoAdmitidos(registro, nuevo)).toEqual([
      'fuentes.emisores[4]: un emisor nuevo solo lleva id, nombre, hosts, tipo, recogida y bloqueo',
      'fuentes.emisores[4]: un emisor nuevo es de tipo medio',
    ]);
    expect(cambiosFuentesNoAdmitidos(registro, null)).toEqual(['fuentes.json: no es un objeto con la lista emisores']);
    // Only the site's shape of tipo robots: no other keys, no anti-bot kind, its robots.txt on one of its hosts.
    const conBloqueo = registrarBloqueos(registro, [robots('medio.es')], FECHA).registro as unknown as ReturnType<typeof copia>;
    for (const cambio of [{ permitido: ['/a/'] }, { tipo: 'antibots' }, { robots: 'https://otro.es/robots.txt' }, { agentes: [] }, { evidencia: '' }]) {
      const malo = structuredClone(conBloqueo);
      Object.assign(malo.emisores[1]!.bloqueo as object, cambio);
      expect(cambiosFuentesNoAdmitidos(registro, malo), JSON.stringify(cambio)).toEqual(['fuentes.medio: bloqueo no tiene la forma esperada']);
    }
  });
});
