import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accesoRestringido, crearEjecutar, detectarBinarios, esVideo, faltan, fuenteVideo, idRtvePlay, LIMITE_TOTAL_MS, pistaEspanolRtve, textoDeVtt, transcribir, urlSubtitulosRtve, type Binarios, type Ejecutar } from './transcripciones.ts';
import { Traedor } from './traer.ts';

const VTT = `WEBVTT
Kind: captions
Language: es

00:00:01.000 --> 00:00:03.000
<c>Buenas noches</c> y bienvenidos

00:00:03.000 --> 00:00:05.000
Buenas noches y bienvenidos
al debate

00:00:05.000 --> 00:00:07.000
al debate
`;

const VIDEO = 'https://www.youtube.com/watch?v=abc123';
const TODOS: Binarios = { ytDlp: true, ffmpeg: true, whisper: 'whisper' };

let cache: string;
beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), 'n29-tr-'));
});
afterEach(async () => {
  await rm(cache, { recursive: true, force: true });
});

/** A Traedor whose network answers robots.txt with "allow all" (or the given rules). */
const abierto = (opciones: { robots?: string; soloBuzon?: string[]; bloqueados?: Record<string, { fecha: string; estado_http: number; motivo: string; url: string }> } = {}) => {
  const fetch = vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith('/robots.txt') ? new Response(opciones.robots ?? 'User-agent: *\nAllow: /', { status: 200 }) : new Response('', { status: 404 }),
  );
  return new Traedor({ fecha: '2026-11-10', fetch: fetch as unknown as typeof globalThis.fetch, reloj: () => 0, esperar: async () => {}, resolver: async () => ['93.184.215.14'], soloBuzon: opciones.soloBuzon ?? [], bloqueados: opciones.bloqueados });
};

const valorDe = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
const carpetaDe = (args: string[]) => valorDe(args, '-o').replace(/\/[^/]+$/, '');

/** A fake yt-dlp/whisper: writes the files the real tools would, per scenario. */
function ejecutarFalso(escenario: { manuales?: boolean; automaticos?: boolean; idioma?: string }) {
  const llamadas: { comando: string; args: string[] }[] = [];
  const audios: string[] = [];
  const ejecutar: Ejecutar = vi.fn(async (comando, args) => {
    llamadas.push({ comando, args });
    if (comando === 'yt-dlp' && args.includes('--skip-download')) {
      const carpeta = carpetaDe(args);
      const subtitles = escenario.manuales ? { es: [{ ext: 'vtt' }] } : {};
      const automatic_captions = escenario.automaticos ? { es: [{ ext: 'vtt' }] } : {};
      await writeFile(join(carpeta, 'video.info.json'), JSON.stringify({ id: 'abc123', subtitles, automatic_captions, ...(escenario.idioma ? { language: escenario.idioma } : {}) }));
      if (escenario.manuales || escenario.automaticos) await writeFile(join(carpeta, 'video.es.vtt'), VTT);
      return { codigo: 0, stdout: '', stderr: '' };
    }
    if (comando === 'yt-dlp') {
      const audio = join(carpetaDe(args), 'audio.wav');
      audios.push(audio);
      await writeFile(audio, 'RIFF....');
      return { codigo: 0, stdout: '', stderr: '' };
    }
    if (comando === 'whisper') {
      await writeFile(join(valorDe(args, '--output_dir'), 'audio.txt'), 'Texto transcrito por Whisper.\n');
      return { codigo: 0, stdout: '', stderr: '' };
    }
    return { codigo: 127, stdout: '', stderr: 'no encontrado' };
  });
  return { ejecutar, llamadas, audios };
}

describe('textoDeVtt', () => {
  it('drops header, timings and tags, and collapses rolling repeats', () => {
    expect(textoDeVtt(VTT)).toBe('Buenas noches y bienvenidos\nal debate');
  });
});

describe('detectarBinarios', () => {
  it('detects the binaries with which and lists install commands for the missing ones', async () => {
    const ejecutar: Ejecutar = async (_comando, [nombre]) => ({ codigo: nombre === 'yt-dlp' || nombre === 'whisper-cli' ? 0 : 1, stdout: '', stderr: '' });
    const binarios = await detectarBinarios(ejecutar);
    expect(binarios).toEqual({ ytDlp: true, ffmpeg: false, whisper: 'whisper-cli' });
    expect(faltan(binarios)).toEqual([expect.stringContaining('brew install ffmpeg')]);
    expect(faltan({ ytDlp: false, ffmpeg: false, whisper: undefined })).toHaveLength(3);
  });
});

describe('transcribir', () => {
  it('uses yt-dlp captions only, without cookies or user config; manual subtitles are primary quality', async () => {
    const { ejecutar, llamadas } = ejecutarFalso({ manuales: true });
    const resultado = await transcribir({ video_url: VIDEO, fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar, binarios: TODOS });
    expect(resultado.estado).toBe('ok');
    if (resultado.estado !== 'ok') return;
    expect(resultado.fuente).toBe('subtitulos');
    expect(resultado.guardado.meta).toMatchObject({ via: 'transcripcion', fuente_transcripcion: 'subtitulos', video_url: VIDEO, idioma: 'es', calidad_primaria: true });
    // A video nobody listed carries no origin; one the owner listed is marked buzon-videos.
    expect(resultado.guardado.meta.origen).toBeUndefined();
    const delDueno = await transcribir({ video_url: VIDEO, fecha: '2026-11-11', origen: 'buzon-videos' }, { raizCache: cache, traedor: abierto(), ejecutar: ejecutarFalso({ manuales: true }).ejecutar, binarios: TODOS });
    expect(delDueno).toMatchObject({ estado: 'ok', guardado: { meta: { origen: 'buzon-videos', video_url: VIDEO } } });
    expect(llamadas).toHaveLength(1);
    const args = llamadas[0]!.args;
    for (const flag of ['--skip-download', '--write-subs', '--write-auto-subs', '--ignore-config', '--no-plugin-dirs', '--no-cookies', '--no-cookies-from-browser']) expect(args).toContain(flag);
    expect(valorDe(args, '--sub-langs')).toBe('es');
    expect(args.some((arg) => /^--cookies(=|$)|--username|--password/.test(arg))).toBe(false);
    expect(await readFile(join(resultado.guardado.dir, 'texto.txt'), 'utf8')).toBe('Buenas noches y bienvenidos\nal debate\n');
  });

  it('marks automatic captions as not primary quality', async () => {
    const { ejecutar } = ejecutarFalso({ automaticos: true });
    const resultado = await transcribir({ video_url: VIDEO, fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar, binarios: TODOS });
    expect(resultado).toMatchObject({ estado: 'ok', guardado: { meta: { fuente_transcripcion: 'subtitulos', calidad_primaria: false, subtitulos: 'automaticos' } } });
  });

  it('falls back to Whisper only without captions, and deletes the audio', async () => {
    const { ejecutar, llamadas, audios } = ejecutarFalso({});
    const resultado = await transcribir({ video_url: VIDEO, fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar, binarios: TODOS });
    expect(resultado).toMatchObject({ estado: 'ok', fuente: 'whisper', guardado: { meta: { fuente_transcripcion: 'whisper', calidad_primaria: false, idioma: 'es' } } });
    expect(llamadas.map((l) => l.comando)).toEqual(['yt-dlp', 'yt-dlp', 'whisper']);
    expect(valorDe(llamadas[2]!.args, '--language')).toBe('es');
    expect(audios).toHaveLength(1);
    await expect(readFile(audios[0]!)).rejects.toThrow();
    // Only the cached document remains: the temporary folder is gone.
    expect(await readdir(join(cache, 'tmp'))).toEqual([]);
  });

  it('deletes the audio also when Whisper fails', async () => {
    const { ejecutar, audios } = ejecutarFalso({});
    const fallo: Ejecutar = async (comando, args) => (comando === 'whisper' ? { codigo: 1, stdout: '', stderr: 'boom' } : ejecutar(comando, args));
    const resultado = await transcribir({ video_url: VIDEO, fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar: fallo, binarios: TODOS });
    expect(resultado).toMatchObject({ estado: 'error' });
    await expect(readFile(audios[0]!)).rejects.toThrow();
  });

  it('fails gracefully with install commands when binaries are missing', async () => {
    const { ejecutar, llamadas } = ejecutarFalso({});
    const sinYtDlp = await transcribir({ video_url: VIDEO, fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar, binarios: { ytDlp: false, ffmpeg: false, whisper: undefined } });
    expect(sinYtDlp).toMatchObject({ estado: 'faltan-binarios', instalar: expect.arrayContaining([expect.stringContaining('yt-dlp')]) });
    expect(llamadas).toEqual([]);

    const sinWhisper = await transcribir({ video_url: VIDEO, fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar, binarios: { ytDlp: true, ffmpeg: true, whisper: undefined } });
    expect(sinWhisper).toMatchObject({ estado: 'faltan-binarios', instalar: [expect.stringContaining('whisper')] });
    expect(llamadas.map((l) => l.comando)).toEqual(['yt-dlp']);
  });

  it('prefers an official transcript and never runs yt-dlp then', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/robots.txt')
        ? new Response('', { status: 404 })
        : new Response('<article><p>Transcripción oficial de la rueda de prensa.</p></article>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const traedor = new Traedor({ fecha: '2026-11-10', fetch: fetch as unknown as typeof globalThis.fetch, reloj: () => 0, esperar: async () => {}, resolver: async () => ['93.184.215.14'] });
    const { ejecutar, llamadas } = ejecutarFalso({ manuales: true });
    const resultado = await transcribir(
      { video_url: VIDEO, oficial_url: 'https://www.lamoncloa.gob.es/presidente/intervenciones/Paginas/2026/x.aspx', fecha: '2026-11-10' },
      { raizCache: cache, traedor, ejecutar, binarios: TODOS },
    );
    expect(resultado).toMatchObject({ estado: 'ok', fuente: 'oficial', guardado: { meta: { via: 'transcripcion', fuente_transcripcion: 'oficial', calidad_primaria: true, video_url: VIDEO } } });
    expect(llamadas).toEqual([]);
  });

  it('passes -- before the URL to yt-dlp', async () => {
    const { ejecutar, llamadas } = ejecutarFalso({ manuales: true });
    await transcribir({ video_url: VIDEO, fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar, binarios: TODOS });
    expect(llamadas[0]!.args.slice(-2)).toEqual(['--', VIDEO]);
  });

  it('never runs yt-dlp on a blocked, inbox-only, robots-disallowed, non-https or missing-check video', async () => {
    const casos = [
      { url: VIDEO, traedor: abierto({ bloqueados: { 'youtube.com': { fecha: '2026-11-10', estado_http: 403, motivo: 'HTTP 403', url: VIDEO } } }) },
      { url: VIDEO, traedor: abierto({ soloBuzon: ['youtube.com'] }) },
      { url: VIDEO, traedor: abierto({ robots: 'User-agent: *\nDisallow: /watch' }) },
      { url: 'http://www.youtube.com/watch?v=abc123', traedor: abierto() },
      { url: VIDEO, traedor: undefined },
    ];
    for (const caso of casos) {
      const { ejecutar, llamadas } = ejecutarFalso({ manuales: true });
      const resultado = await transcribir({ video_url: caso.url, fecha: '2026-11-10' }, { raizCache: cache, traedor: caso.traedor, ejecutar, binarios: TODOS });
      expect(resultado.estado).toBe('error');
      expect(llamadas).toEqual([]);
    }
  });

  it('kills the whole process group on timeout, children included', async () => {
    const archivo = join(cache, 'nieto.pid');
    const ejecutar = crearEjecutar({ sh: 300 });
    const resultado = await ejecutar('sh', ['-c', `sleep 30 & echo $! > "${archivo}"; wait`]);
    expect(resultado.codigo).toBe(124);
    const nieto = Number((await readFile(archivo, 'utf8')).trim());
    await new Promise((hecho) => setTimeout(hecho, 200));
    expect(() => process.kill(nieto, 0)).toThrow();
  });

  it('runs a normal command and returns its output', async () => {
    expect(await crearEjecutar()('sh', ['-c', 'echo hola; echo aviso >&2; exit 3'])).toEqual({ codigo: 3, stdout: 'hola\n', stderr: 'aviso\n' });
    expect(LIMITE_TOTAL_MS).toBe(4 * 3_600_000);
  });
});

describe('vídeos permitidos (hosts con extractor propio en yt-dlp)', () => {
  it('accepts only the URL shapes of the dedicated extractors, https, without credentials or port', () => {
    const si = [
      'https://www.youtube.com/watch?v=abc123',
      'https://youtu.be/abc123',
      'https://www.rtve.es/play/videos/telediario-1/debate/17306884/',
      'https://www.3cat.cat/3cat/debat-electoral/video/6312345/',
      'https://www.3cat.cat/3cat/entrevista/audio/1234567/',
      'https://www.atresplayer.com/antena3/programas/debate/temporada-1/debate-electoral_6512a1b2c3d4e5f6a7b8c9d0/',
    ];
    const no = [
      'http://www.youtube.com/watch?v=abc123',
      'https://usuario:clave@youtu.be/abc123',
      'https://www.youtube.com:8443/watch?v=abc123',
      'https://www.rtve.es/noticias/20261110/debate/123.shtml',
      'https://www.rtve.es/play/videos/telediario-1/',
      'https://cadenaser.com/2026/11/10/entrevista/',
      'https://www.ondacero.es/programas/herrera/audios-podcast/x_2026111012345.html',
      'https://esradio.libertaddigital.com/fonoteca/2026-11-10/entrevista-123.html',
      'https://www.ccma.cat/tv3/alacarta/debat/video/6312345/',
      'https://www.mitele.es/programas-tv/debate/temporada-1/x-40_1234567/player/',
      'https://www.3cat.cat/3cat/debat-electoral/',
      'https://www.atresplayer.com/antena3/programas/debate/',
    ];
    for (const url of si) expect(esVideo(url), url).toBe(true);
    for (const url of no) expect(esVideo(url), url).toBe(false);
    expect(fuenteVideo(si[3]!)).toMatchObject({ extractores: ['CCMA'], idiomas: ['ca', 'es'] });
  });

  it('tells yt-dlp to use only the host\'s extractor, and the host\'s caption languages', async () => {
    const { ejecutar, llamadas } = ejecutarFalso({ manuales: true });
    await transcribir({ video_url: 'https://www.atresplayer.com/antena3/programas/debate/temporada-1/debate-electoral_6512a1b2c3d4e5f6a7b8c9d0/', fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar, binarios: TODOS });
    const args = llamadas[0]!.args;
    expect(valorDe(args, '--use-extractors')).toBe('AtresPlayer');
    expect(valorDe(args, '--sub-langs')).toBe('es');
    for (const flag of ['--ignore-config', '--no-plugin-dirs', '--no-cookies', '--no-cookies-from-browser']) expect(args).toContain(flag);
    expect(args.slice(-2)[0]).toBe('--');
  });

  it('records login, geo-blocks and DRM as an aviso, and never downloads the audio then', async () => {
    const errores = {
      'requiere iniciar sesión o suscripción': 'ERROR: [AtresPlayer] x: This video is only available for registered users. Use --username and --password',
      'bloqueo geográfico': 'ERROR: [CCMA] 6312345: The uploader has not made this video available in your country (geo restricted)',
      'protegido con DRM': 'ERROR: [AtresPlayer] x: This video is DRM protected',
    };
    for (const [motivo, stderr] of Object.entries(errores)) {
      expect(accesoRestringido(stderr)).toBe(motivo);
      const llamadas: string[][] = [];
      const ejecutar: Ejecutar = async (_comando, args) => {
        llamadas.push(args);
        return { codigo: 1, stdout: '', stderr };
      };
      const resultado = await transcribir({ video_url: 'https://www.3cat.cat/3cat/debat-electoral/video/6312345/', fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar, binarios: TODOS });
      expect(resultado).toMatchObject({ estado: 'aviso', motivo: expect.stringContaining(`${motivo}: no se sortea`) });
      expect(llamadas).toHaveLength(1);
      expect(llamadas[0]).toContain('--skip-download');
    }
    expect(accesoRestringido('ERROR: Unable to download webpage: HTTP Error 500')).toBeUndefined();
    // yt-dlp's exact wording, not loose words.
    expect(accesoRestringido('ERROR: [youtube] x: This video is not available from your location due to geo restriction')).toBe('bloqueo geográfico');
    for (const otro of ['WARNING: Unable to extract login form', 'Downloading DRMless formats', 'geography quiz: not a block', 'Logging in']) expect(accesoRestringido(otro), otro).toBeUndefined();
  });

  it('tells Whisper the 3Cat video\'s own language when yt-dlp reads it, and lets Whisper detect it otherwise', async () => {
    const VIDEO_3CAT = 'https://www.3cat.cat/3cat/debat-electoral/video/6312345/';
    const conIdioma = ejecutarFalso({ idioma: 'ca' });
    const ca = await transcribir({ video_url: VIDEO_3CAT, fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar: conIdioma.ejecutar, binarios: TODOS });
    expect(ca).toMatchObject({ estado: 'ok', fuente: 'whisper', guardado: { meta: { idioma: 'ca' } } });
    expect(valorDe(conIdioma.llamadas.find((l) => l.comando === 'whisper')!.args, '--language')).toBe('ca');
    expect(valorDe(conIdioma.llamadas[0]!.args, '--sub-langs')).toBe('ca,es');
    const sinIdioma = ejecutarFalso({});
    const auto = await transcribir({ video_url: VIDEO_3CAT.replace('6312345', '6312346'), fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar: sinIdioma.ejecutar, binarios: TODOS });
    expect(auto).toMatchObject({ estado: 'ok', guardado: { meta: { idioma: 'detectado por Whisper' } } });
    expect(sinIdioma.llamadas.find((l) => l.comando === 'whisper')!.args).not.toContain('--language');
    // YouTube keeps Spanish.
    const yt = ejecutarFalso({ idioma: 'en' });
    await transcribir({ video_url: VIDEO, fecha: '2026-11-10' }, { raizCache: cache, traedor: abierto(), ejecutar: yt.ejecutar, binarios: TODOS });
    expect(valorDe(yt.llamadas.find((l) => l.comando === 'whisper')!.args, '--language')).toBe('es');
  });

});

describe('subtítulos de RTVE Play por su API', () => {
  const PLAY = 'https://www.rtve.es/play/videos/telediario-1/debate-electoral/17306884/';
  const API = 'https://api2.rtve.es/api/videos/17306884/subtitulos.json';
  const PISTA = 'https://www.rtve.es/resources/vtt/3/9/1794264098593.vtt';
  const lista = () => readFile(join(import.meta.dirname, '..', 'fixtures', 'rtve', 'subtitulos.json'), 'utf8');

  /** A Traedor over fixed routes; the hosts in `internos` resolve to a non-public address. */
  const red = async (rutas: Record<string, { status: number; body: string; tipo?: string }>, internos: string[] = []) => {
    const pedidas: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
      pedidas.push(String(url));
      if (String(url).endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /', { status: 200 });
      const ruta = rutas[String(url)];
      return ruta ? new Response(ruta.body, { status: ruta.status, headers: { 'content-type': ruta.tipo ?? 'text/plain' } }) : new Response('', { status: 404 });
    });
    const resolver = async (host: string) => (internos.includes(host) ? ['192.0.0.166'] : ['199.232.34.137']);
    return { pedidas, traedor: new Traedor({ fecha: '2026-11-10', fetch: fetch as unknown as typeof globalThis.fetch, reloj: () => 0, esperar: async () => {}, resolver, soloBuzon: [] }) };
  };

  it('reads the id from the URL and picks the Spanish track', async () => {
    expect(idRtvePlay(PLAY)).toBe('17306884');
    expect(idRtvePlay('https://www.youtube.com/watch?v=abc123')).toBeUndefined();
    expect(urlSubtitulosRtve('17306884')).toBe(API);
    expect(pistaEspanolRtve(JSON.parse(await lista()))).toBe(PISTA);
    expect(pistaEspanolRtve({ page: { items: [{ src: 'x', lang: 'en' }] } })).toBeUndefined();
    expect(pistaEspanolRtve(null)).toBeUndefined();
  });

  it('stores the cleaned Spanish subtitles with the RTVE Play URL as source, without loading the page or running yt-dlp', async () => {
    const { pedidas, traedor } = await red({ [API]: { status: 200, body: await lista(), tipo: 'application/json' }, [PISTA]: { status: 200, body: VTT, tipo: 'text/vtt' } });
    const { ejecutar, llamadas } = ejecutarFalso({ manuales: true });
    const resultado = await transcribir({ video_url: PLAY, fecha: '2026-11-10' }, { raizCache: cache, traedor, ejecutar, binarios: TODOS });
    expect(resultado).toMatchObject({ estado: 'ok', fuente: 'subtitulos', guardado: { meta: { url: PLAY, via: 'transcripcion', subtitulos: 'rtve-api', subtitulos_url: PISTA, subtitulos_api: API, calidad_primaria: false } } });
    if (resultado.estado !== 'ok') return;
    expect((await readFile(join(resultado.guardado.dir, 'texto.txt'), 'utf8')).trimEnd()).toBe('Buenas noches y bienvenidos\nal debate');
    expect(pedidas).not.toContain(PLAY);
    expect(llamadas).toEqual([]);
  });

  it('records an aviso, with no yt-dlp or Whisper, when the API path fails', async () => {
    type Ruta = { status: number; body: string; tipo?: string };
    const casos: { rutas: Record<string, Ruta>; internos: string[]; motivo: RegExp }[] = [
      // The VTT host resolves to a non-public address: refused at the check, never fetched.
      { rutas: { [API]: { status: 200, body: await lista(), tipo: 'application/json' } }, internos: ['www.rtve.es'], motivo: /no traído|pública|interna|dirección/ },
      { rutas: { [API]: { status: 200, body: JSON.stringify({ page: { items: [{ src: PISTA, lang: 'en' }] } }), tipo: 'application/json' } }, internos: ['www.rtve.es'], motivo: /no tiene pista en español/ },
      { rutas: { [API]: { status: 200, body: 'no es json' } }, internos: ['www.rtve.es'], motivo: /no es JSON/ },
      { rutas: {}, internos: ['www.rtve.es'], motivo: /subtítulos de RTVE no disponibles/ },
    ];
    for (const caso of casos) {
      const { pedidas, traedor } = await red(caso.rutas, caso.internos);
      const { ejecutar, llamadas } = ejecutarFalso({ manuales: true });
      const resultado = await transcribir({ video_url: PLAY, fecha: '2026-11-10' }, { raizCache: cache, traedor, ejecutar, binarios: TODOS });
      expect(resultado.estado).toBe('aviso');
      if (resultado.estado === 'aviso') expect(resultado.motivo).toMatch(caso.motivo);
      expect(llamadas).toEqual([]);
      expect(pedidas.some((u) => u.startsWith('https://www.rtve.es/'))).toBe(false);
    }
  });

  it('respects robots.txt of api2.rtve.es, and does not fall back to yt-dlp even when www.rtve.es is public and allowed', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url) === 'https://api2.rtve.es/robots.txt'
        ? new Response('User-agent: *\nAllow: /js/\nDisallow: /', { status: 200 })
        : String(url).endsWith('/robots.txt')
          ? new Response('User-agent: *\nAllow: /', { status: 200 })
          : new Response('{}', { status: 200 }),
    );
    const traedor = new Traedor({ fecha: '2026-11-10', fetch: fetch as unknown as typeof globalThis.fetch, reloj: () => 0, esperar: async () => {}, resolver: async () => ['199.232.34.137'], soloBuzon: [] });
    const { ejecutar, llamadas } = ejecutarFalso({ manuales: true });
    const resultado = await transcribir({ video_url: PLAY, fecha: '2026-11-10' }, { raizCache: cache, traedor, ejecutar, binarios: TODOS });
    expect(resultado).toMatchObject({ estado: 'aviso', motivo: expect.stringMatching(/^subtítulos de RTVE no disponibles \(https:\/\/api2\.rtve\.es\/api\/videos\/17306884\/subtitulos\.json\): robots/) });
    expect(fetch.mock.calls.map(([u]) => String(u))).toEqual(['https://api2.rtve.es/robots.txt']);
    expect(llamadas).toEqual([]);
  });
});
