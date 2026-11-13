/**
 * Transcripts of debates and interviews, in this order of preference:
 *
 * 1. oficial: an official transcript (party PDF, La Moncloa, Congreso Diario
 *    de Sesiones, an RTVE page with the text), fetched through Traedor.
 * 2. subtitulos: Spanish captions with yt-dlp (`--skip-download --write-subs
 *    --write-auto-subs --sub-langs es`), no cookies, no account, slow rate.
 * 3. whisper: only when there are no captions, the audio is downloaded,
 *    transcribed with a local Whisper (openai-whisper or whisper.cpp) and
 *    deleted right after, also on failure.
 *
 * The video URL passes Traedor's checks first (https, public host, not
 * blocked, not inbox-only, robots.txt); each binary runs with a watchdog.
 *
 * RTVE Play: only the Spanish subtitles of RTVE's own API (api2.rtve.es),
 * fetched through Traedor without loading the page; when that is not
 * possible, an aviso, never yt-dlp or Whisper.
 *
 * Only hosts with a dedicated yt-dlp extractor (FUENTES_VIDEO), and yt-dlp is
 * told to use only that one (never the generic extractor). Login, geo-blocks
 * and DRM are reported as an aviso and never worked around.
 *
 * Auto-captions and Whisper are marked `calidad_primaria: false`. The external
 * binaries are detected, never installed: when one is missing the stage stops
 * with the install commands.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { guardar, urlCanonica, type Guardado } from './cache.ts';
import { ORIGEN_VIDEOS } from './buzon.ts';
import { decodificarCuerpo, extraer, type Traedor } from './traer.ts';

/**
 * Video and audio pages yt-dlp may read: hosts with a dedicated extractor in
 * yt-dlp (checked against `yt-dlp --list-extractors` and each extractor's URL
 * pattern, version 2026.10.26), the URL shape that extractor accepts, the only
 * extractors yt-dlp may use for it, and the caption languages, first preferred.
 * Not listed, because yt-dlp has no extractor for them: cadenaser.com,
 * ondacero.es, esradio.libertaddigital.com, ccma.cat (3Cat now serves from
 * 3cat.cat), mitele.es; no official domain with an extractor was found for
 * La Séptima. `whisper` is the language Whisper is told; without it (3Cat,
 * Catalan or Spanish), the video's own language from yt-dlp's info JSON, or
 * Whisper's own detection.
 */
export const FUENTES_VIDEO: readonly { host: string; ruta: (url: URL) => boolean; extractores: readonly string[]; idiomas: readonly string[]; whisper?: string }[] = [
  { host: 'youtube.com', ruta: (u) => u.pathname === '/watch' && /^[\w-]{6,}$/.test(u.searchParams.get('v') ?? ''), extractores: ['youtube'], idiomas: ['es'], whisper: 'es' },
  { host: 'youtu.be', ruta: (u) => /^\/[\w-]{6,}$/.test(u.pathname), extractores: ['youtube'], idiomas: ['es'], whisper: 'es' },
  { host: 'rtve.es', ruta: (u) => RUTA_RTVE_PLAY.test(u.pathname), extractores: ['rtve.es:alacarta'], idiomas: ['es'], whisper: 'es' },
  { host: '3cat.cat', ruta: (u) => /^\/(?:3cat|tv3\/sx3)\/[^/]+\/(?:video|audio)\/\d+\/?$/.test(u.pathname), extractores: ['CCMA'], idiomas: ['ca', 'es'] },
  { host: 'atresplayer.com', ruta: (u) => /^\/(?:[^/]+\/){4}[^/]+_[0-9a-f]{24}\/?$/.test(u.pathname), extractores: ['AtresPlayer'], idiomas: ['es'], whisper: 'es' },
];

/** An RTVE Play video page: /play/videos/<programa>/<slug>/<id>/. */
const RUTA_RTVE_PLAY = /^\/play\/videos\/[^/]+\/[^/]+\/(\d+)\/?$/;

/** The FUENTES_VIDEO entry of an https video URL (no credentials, no port), or undefined. */
export function fuenteVideo(url: string): (typeof FUENTES_VIDEO)[number] | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return undefined;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return FUENTES_VIDEO.find((f) => f.host === host && f.ruta(parsed));
}

/** Whether a URL is an https video page on an allowed host, in the shape its extractor accepts. */
export const esVideo = (url: string) => fuenteVideo(url) !== undefined;

/** The numeric id of an RTVE Play URL, read from the URL itself (the page is not fetched). */
export function idRtvePlay(url: string): string | undefined {
  const fuente = fuenteVideo(url);
  return fuente?.host === 'rtve.es' ? RUTA_RTVE_PLAY.exec(new URL(url).pathname)?.[1] : undefined;
}

/** RTVE's subtitles API for one video id. */
export const urlSubtitulosRtve = (id: string) => `https://api2.rtve.es/api/videos/${id}/subtitulos.json`;

/** The URL of the Spanish track in RTVE's subtitles JSON ({page: {items: [{src, lang}]}}), or undefined. */
export function pistaEspanolRtve(json: unknown): string | undefined {
  const items = (json as { page?: { items?: unknown } } | null)?.page?.items;
  if (!Array.isArray(items)) return undefined;
  const pista = items.find((item) => item && typeof item === 'object' && (item as { lang?: unknown }).lang === 'es' && typeof (item as { src?: unknown }).src === 'string');
  return (pista as { src: string } | undefined)?.src;
}

/** What yt-dlp's error says about access, if it is a login wall, a geo-block or DRM: reported, never worked around. */
export function accesoRestringido(stderr: string): string | undefined {
  // yt-dlp's own messages (extractor/common.py: report_drm, raise_geo_restricted, raise_login_required; YoutubeDL.py).
  if (/\bThis video is DRM protected\b|\bformats? (?:is|are) DRM protected\b/i.test(stderr)) return 'protegido con DRM';
  if (/\bnot available from your location due to geo restriction\b|\bnot made this video available in your country\b|\bGeoRestrictedError\b/i.test(stderr)) return 'bloqueo geográfico';
  if (/\bonly available for registered users\b|\bSign in to confirm\b|\bUse --cookies-from-browser or --cookies for the authentication\b|\bThis video is only available to (?:subscribers|members)\b|\bPremium members only\b/i.test(stderr)) return 'requiere iniciar sesión o suscripción';
  return undefined;
}

export type FuenteTranscripcion = 'oficial' | 'subtitulos' | 'whisper';

export interface Ejecucion {
  codigo: number;
  stdout: string;
  stderr: string;
}
/** Runs a binary without a shell; injected in tests. */
export type Ejecutar = (comando: string, args: string[]) => Promise<Ejecucion>;

/** Watchdog per binary: a hung download or transcription is killed, never waited for. */
export const LIMITE_MS: Record<string, number> = { 'yt-dlp': 30 * 60_000, whisper: 3 * 3_600_000, 'whisper-cli': 3 * 3_600_000 };
/** The longest one transcription can take: captions, then audio, then Whisper. diario.sh's outer limit must exceed it. */
export const LIMITE_TOTAL_MS = 2 * LIMITE_MS['yt-dlp']! + LIMITE_MS.whisper!;

/** Process groups still running: killed whole if this process is told to stop. */
const grupos = new Set<number>();
const matarGrupo = (pid: number) => {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
};
let señalesInstaladas = false;
function instalarSeñales() {
  if (señalesInstaladas) return;
  señalesInstaladas = true;
  for (const [señal, numero] of [['SIGALRM', 14], ['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]] as const) {
    process.once(señal, () => {
      for (const pid of grupos) matarGrupo(pid);
      process.exit(128 + numero);
    });
  }
}

/**
 * Runs a binary without a shell, in its own process group (detached), so that
 * on timeout the whole group dies, children like ffmpeg included. Output is
 * capped at 64 MB.
 */
export function crearEjecutar(limites: Record<string, number> = LIMITE_MS, porDefectoMs = 60_000): Ejecutar {
  return (comando, args) =>
    new Promise((hecho) => {
      instalarSeñales();
      const salida: Buffer[] = [];
      const errores: Buffer[] = [];
      let bytes = 0;
      let terminado = false;
      const hijo = spawn(comando, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8' } });
      const pid = hijo.pid;
      if (pid !== undefined) grupos.add(pid);
      const acabar = (codigo: number, extra = '') => {
        if (terminado) return;
        terminado = true;
        clearTimeout(reloj);
        if (pid !== undefined) {
          matarGrupo(pid);
          grupos.delete(pid);
        }
        hecho({ codigo, stdout: Buffer.concat(salida).toString(), stderr: Buffer.concat(errores).toString() + extra });
      };
      const guardar = (destino: Buffer[]) => (trozo: Buffer) => {
        bytes += trozo.length;
        if (bytes > 64 * 1024 * 1024) return acabar(137, '\nsalida de más de 64 MB');
        destino.push(trozo);
      };
      hijo.stdout.on('data', guardar(salida));
      hijo.stderr.on('data', guardar(errores));
      const limite = limites[comando] ?? porDefectoMs;
      const reloj = setTimeout(() => acabar(124, `\n${comando}: sin terminar en ${Math.round(limite / 1000)} s; se mata su grupo de procesos`), limite);
      hijo.on('error', (error) => acabar(127, `\n${error.message}`));
      hijo.on('close', (codigo, señal) => acabar(codigo ?? (señal ? 128 : 1)));
    });
}

export const ejecutarReal: Ejecutar = crearEjecutar();

/** Install commands, reported when a binary is missing. Nothing is installed automatically. */
export const INSTALAR = {
  'yt-dlp': 'brew install yt-dlp   # o: pipx install yt-dlp',
  ffmpeg: 'brew install ffmpeg   # yt-dlp lo usa para extraer el audio',
  whisper: 'pipx install openai-whisper   # o whisper.cpp: brew install whisper-cpp (y un modelo ggml, p. ej. ggml-small.bin)',
} as const;

export interface Binarios {
  ytDlp: boolean;
  ffmpeg: boolean;
  /** Which local Whisper is available, if any: openai-whisper (`whisper`) or whisper.cpp (`whisper-cli`). */
  whisper: 'whisper' | 'whisper-cli' | undefined;
}

const existe = async (ejecutar: Ejecutar, comando: string) => (await ejecutar('which', [comando])).codigo === 0;

export async function detectarBinarios(ejecutar: Ejecutar = ejecutarReal): Promise<Binarios> {
  const [ytDlp, ffmpeg, whisper, whisperCli] = await Promise.all(['yt-dlp', 'ffmpeg', 'whisper', 'whisper-cli'].map((comando) => existe(ejecutar, comando)));
  return { ytDlp: !!ytDlp, ffmpeg: !!ffmpeg, whisper: whisper ? 'whisper' : whisperCli ? 'whisper-cli' : undefined };
}

/** Install commands for what is missing (empty when everything is there). */
export function faltan(binarios: Binarios): string[] {
  const lista: string[] = [];
  if (!binarios.ytDlp) lista.push(INSTALAR['yt-dlp']);
  if (!binarios.ffmpeg) lista.push(INSTALAR.ffmpeg);
  if (!binarios.whisper) lista.push(INSTALAR.whisper);
  return lista;
}

/**
 * Common yt-dlp flags: ignore user config (it could add cookies), no plugins
 * (a plugin folder would run its code), no cookies, slow requests. The video
 * URL itself passed Traedor.comprobar (https, port 443, public addresses,
 * robots.txt) and esVideo (the host and URL shape of FUENTES_VIDEO), and only
 * that host's extractor runs. Residual risk: yt-dlp's own requests (the
 * extractor's API and media hosts, and their redirects) do not go through
 * lookupPublico, so they are not checked against internal addresses; yt-dlp
 * has no option to restrict them by host or address.
 */
export const YT_DLP_BASE = ['--ignore-config', '--no-plugin-dirs', '--no-cookies', '--no-cookies-from-browser', '--no-playlist', '--sleep-requests', '3', '--sleep-subtitles', '3', '--retries', '1'];

/** Plain text of a WebVTT caption file: no header, timings or tags; repeated rolling lines collapsed. */
export function textoDeVtt(vtt: string): string {
  const lineas: string[] = [];
  for (const bloque of vtt.replace(/\r/g, '').split(/\n\n+/)) {
    for (const linea of bloque.split('\n')) {
      if (!linea.trim() || /^WEBVTT|^NOTE\b|^STYLE\b|^Kind:|^Language:|-->/.test(linea) || /^\d+$/.test(linea.trim())) continue;
      const limpia = linea
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (limpia && limpia !== lineas.at(-1)) lineas.push(limpia);
    }
  }
  return lineas.join('\n');
}

export interface Peticion {
  /** The video page (YouTube, RTVE Play…). */
  video_url: string;
  /** An official transcript, when there is one: preferred over captions. */
  oficial_url?: string;
  /** Run date (ISO). */
  fecha: string;
  /** whisper.cpp model file (only for whisper-cli). */
  modeloWhisper?: string;
  /** ORIGEN_VIDEOS when the owner listed the video in the inbox: written to the meta, so its transcript may back a published item (citas.ts, citableEn). */
  origen?: typeof ORIGEN_VIDEOS;
}

export type ResultadoTranscripcion =
  | { estado: 'ok'; fuente: FuenteTranscripcion; guardado: Guardado }
  /** Not available without working around a restriction (login, geo-block, DRM, robots, a non-public address): an aviso. */
  | { estado: 'aviso'; motivo: string }
  | { estado: 'faltan-binarios'; instalar: string[]; motivo: string }
  | { estado: 'error'; motivo: string };

export interface Dependencias {
  raizCache: string;
  traedor?: Traedor;
  ejecutar?: Ejecutar;
  binarios?: Binarios;
}

const meta = (peticion: Peticion, fuente: FuenteTranscripcion, calidad_primaria: boolean, extra: Record<string, unknown> = {}) => ({
  fuente_transcripcion: fuente,
  video_url: peticion.video_url,
  idioma: 'es',
  calidad_primaria,
  ...(peticion.origen === ORIGEN_VIDEOS ? { origen: ORIGEN_VIDEOS } : {}),
  ...extra,
});

/**
 * RTVE Play subtitles from RTVE's API, without loading the page: the id comes
 * from the URL; the JSON and then the Spanish VTT are fetched through Traedor,
 * with all its checks (https, public address at connect, redirects, size,
 * robots.txt of each host). Undefined when the URL is not RTVE Play; an aviso
 * when a check or the data stops it.
 */
async function subtitulosRtve(peticion: Peticion, traedor: Traedor, raizCache: string): Promise<ResultadoTranscripcion | undefined> {
  const id = idRtvePlay(peticion.video_url);
  if (!id) return undefined;
  const motivoDe = (r: Awaited<ReturnType<Traedor['traer']>>) => (r.estado === 'bloqueado' ? r.bloqueo.motivo : 'motivo' in r ? r.motivo : r.estado);
  const api = urlSubtitulosRtve(id);
  const lista = await traedor.traer(api);
  if (lista.estado !== 'ok') return { estado: 'aviso', motivo: `subtítulos de RTVE no disponibles (${api}): ${lista.estado}: ${motivoDe(lista)}` };
  let json: unknown;
  try {
    json = JSON.parse(decodificarCuerpo(lista.tipo, lista.cuerpo));
  } catch {
    return { estado: 'aviso', motivo: `subtítulos de RTVE: ${api} no es JSON` };
  }
  const pista = pistaEspanolRtve(json);
  if (!pista) return { estado: 'aviso', motivo: `subtítulos de RTVE: el vídeo ${id} no tiene pista en español` };
  const vtt = await traedor.traer(pista);
  if (vtt.estado !== 'ok') return { estado: 'aviso', motivo: `subtítulos de RTVE no disponibles (${pista}): ${vtt.estado}: ${motivoDe(vtt)}` };
  const raw = decodificarCuerpo(vtt.tipo, vtt.cuerpo);
  const texto = textoDeVtt(raw);
  if (!texto.trim()) return { estado: 'aviso', motivo: `subtítulos de RTVE: la pista en español de ${id} está vacía` };
  const guardado = await guardar(raizCache, {
    url: peticion.video_url,
    consultado: peticion.fecha,
    via: 'transcripcion',
    estado_http: vtt.estado_http,
    raw,
    ext: 'vtt',
    texto,
    // RTVE does not say whether a track is made by hand: not primary quality.
    extra: meta(peticion, 'subtitulos', false, { subtitulos: 'rtve-api', subtitulos_url: vtt.url_final, subtitulos_api: api }),
  });
  return { estado: 'ok', fuente: 'subtitulos', guardado };
}

async function oficial(peticion: Peticion, dependencias: Dependencias): Promise<ResultadoTranscripcion | undefined> {
  if (!peticion.oficial_url || !dependencias.traedor) return undefined;
  const respuesta = await dependencias.traedor.traer(peticion.oficial_url);
  if (respuesta.estado !== 'ok') return undefined;
  const { ext, texto, raw } = await extraer(respuesta.tipo, respuesta.cuerpo);
  if (!texto.trim()) return undefined;
  const guardado = await guardar(dependencias.raizCache, {
    url: respuesta.url_final,
    url_canonica: urlCanonica(respuesta.url_final),
    consultado: peticion.fecha,
    via: 'transcripcion',
    estado_http: respuesta.estado_http,
    raw,
    ext,
    texto,
    extra: meta(peticion, 'oficial', true),
  });
  return { estado: 'ok', fuente: 'oficial', guardado };
}

/**
 * Captions with yt-dlp. The info JSON written alongside tells manual
 * subtitles (primary quality) from automatic captions (not primary).
 */
async function subtitulos(peticion: Peticion, ejecutar: Ejecutar, tmp: string, raizCache: string): Promise<ResultadoTranscripcion | undefined> {
  const fuente = fuenteVideo(peticion.video_url)!;
  const salida = await ejecutar('yt-dlp', [
    ...YT_DLP_BASE,
    '--use-extractors',
    fuente.extractores.join(','),
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs',
    fuente.idiomas.join(','),
    '--sub-format',
    'vtt',
    '--write-info-json',
    '-o',
    join(tmp, 'video.%(ext)s'),
    '--',
    peticion.video_url,
  ]);
  if (salida.codigo !== 0) {
    const restriccion = accesoRestringido(salida.stderr);
    if (restriccion) return { estado: 'aviso', motivo: `${restriccion}: no se sortea (${salida.stderr.trim().split('\n')[0]!.slice(0, 200)})` };
    return { estado: 'error', motivo: `yt-dlp terminó con código ${salida.codigo}: ${salida.stderr.trim().slice(0, 300)}` };
  }
  const archivos = await readdir(tmp);
  const idioma = fuente.idiomas.find((i) => archivos.includes(`video.${i}.vtt`));
  if (!idioma) return undefined;
  const vtt = `video.${idioma}.vtt`;
  let manuales = false;
  try {
    const info = JSON.parse(await readFile(join(tmp, 'video.info.json'), 'utf8')) as { subtitles?: Record<string, unknown> };
    manuales = Boolean(info.subtitles?.[idioma]);
  } catch {
    manuales = false;
  }
  const raw = await readFile(join(tmp, vtt), 'utf8');
  const guardado = await guardar(raizCache, {
    url: peticion.video_url,
    consultado: peticion.fecha,
    via: 'transcripcion',
    estado_http: null,
    raw,
    ext: 'vtt',
    texto: textoDeVtt(raw),
    extra: meta(peticion, 'subtitulos', manuales, { subtitulos: manuales ? 'manuales' : 'automaticos', idioma }),
  });
  return { estado: 'ok', fuente: 'subtitulos', guardado };
}

/** Downloads the audio, transcribes it locally and deletes the audio (always). */
async function whisper(peticion: Peticion, ejecutar: Ejecutar, binarios: Binarios, tmp: string, raizCache: string): Promise<ResultadoTranscripcion> {
  const fuente = fuenteVideo(peticion.video_url)!;
  // A fixed language, or the one yt-dlp read for the video (es or ca), or Whisper's own detection.
  let idioma: string | undefined = fuente.whisper;
  if (!idioma) {
    try {
      const info = JSON.parse(await readFile(join(tmp, 'video.info.json'), 'utf8')) as { language?: unknown };
      if (info.language === 'ca' || info.language === 'es') idioma = info.language;
    } catch {
      idioma = undefined;
    }
  }
  const descarga = await ejecutar('yt-dlp', [...YT_DLP_BASE, '--use-extractors', fuente.extractores.join(','), '-f', 'bestaudio', '-x', '--audio-format', 'wav', '--postprocessor-args', 'ffmpeg:-ar 16000 -ac 1', '-o', join(tmp, 'audio.%(ext)s'), '--', peticion.video_url]);
  try {
    if (descarga.codigo !== 0) {
      const restriccion = accesoRestringido(descarga.stderr);
      if (restriccion) return { estado: 'aviso', motivo: `${restriccion}: no se sortea (${descarga.stderr.trim().split('\n')[0]!.slice(0, 200)})` };
      return { estado: 'error', motivo: `yt-dlp (audio) terminó con código ${descarga.codigo}: ${descarga.stderr.trim().slice(0, 300)}` };
    }
    const audio = (await readdir(tmp)).find((archivo) => archivo.startsWith('audio.'));
    if (!audio) return { estado: 'error', motivo: 'yt-dlp no dejó ningún archivo de audio' };
    const entrada = join(tmp, audio);
    let resultado: Ejecucion;
    let modelo: string;
    if (binarios.whisper === 'whisper') {
      modelo = 'small';
      resultado = await ejecutar('whisper', [entrada, ...(idioma ? ['--language', idioma] : []), '--model', modelo, '--output_format', 'txt', '--output_dir', tmp, '--fp16', 'False']);
    } else {
      if (!peticion.modeloWhisper) return { estado: 'error', motivo: 'whisper.cpp necesita --modelo-whisper <archivo ggml>' };
      modelo = peticion.modeloWhisper.split('/').at(-1)!;
      resultado = await ejecutar('whisper-cli', ['-m', peticion.modeloWhisper, '-l', idioma ?? 'auto', '-otxt', '-of', join(tmp, 'audio'), '-f', entrada]);
    }
    if (resultado.codigo !== 0) return { estado: 'error', motivo: `Whisper terminó con código ${resultado.codigo}: ${resultado.stderr.trim().slice(0, 300)}` };
    const texto = (await readFile(join(tmp, 'audio.txt'), 'utf8')).trim();
    const guardado = await guardar(raizCache, {
      url: peticion.video_url,
      consultado: peticion.fecha,
      via: 'transcripcion',
      estado_http: null,
      raw: texto,
      ext: 'txt',
      texto,
      extra: meta(peticion, 'whisper', false, { modelo_whisper: modelo, idioma: idioma ?? 'detectado por Whisper' }),
    });
    return { estado: 'ok', fuente: 'whisper', guardado };
  } finally {
    // Audio is kept only until it is transcribed.
    for (const archivo of await readdir(tmp).catch(() => [] as string[])) {
      if (archivo.startsWith('audio.') && !archivo.endsWith('.txt')) await rm(join(tmp, archivo), { force: true });
    }
  }
}

/** Gets one transcript by the order of preference; caches it with via 'transcripcion'. */
export async function transcribir(peticion: Peticion, dependencias: Dependencias): Promise<ResultadoTranscripcion> {
  const deOficial = await oficial(peticion, dependencias);
  if (deOficial) return deOficial;

  // yt-dlp passes the same checks as any request: https, public host, not
  // blocked, not inbox-only, allowed by robots.txt.
  if (!dependencias.traedor) return { estado: 'error', motivo: 'sin Traedor no se puede comprobar el vídeo: no se ejecuta yt-dlp' };
  if (!esVideo(peticion.video_url)) return { estado: 'error', motivo: `vídeo no permitido: ${peticion.video_url} no es una página de vídeo de un host con extractor propio en yt-dlp` };
  // RTVE Play: only its subtitles API, without loading the page. If a check or
  // the data stops it, that is an aviso: no yt-dlp or Whisper for rtve.es.
  const deRtve = await subtitulosRtve(peticion, dependencias.traedor, dependencias.raizCache);
  if (deRtve) return deRtve;
  const veto = await dependencias.traedor.comprobar(peticion.video_url);
  if (veto) return { estado: 'error', motivo: `vídeo no permitido: ${'motivo' in veto ? veto.motivo : veto.bloqueo.motivo}` };

  const ejecutar = dependencias.ejecutar ?? ejecutarReal;
  const binarios = dependencias.binarios ?? (await detectarBinarios(ejecutar));
  if (!binarios.ytDlp) return { estado: 'faltan-binarios', instalar: faltan(binarios), motivo: 'falta yt-dlp: no se pueden leer subtítulos ni audio' };

  await mkdir(join(dependencias.raizCache, 'tmp'), { recursive: true });
  const tmp = await mkdtemp(join(dependencias.raizCache, 'tmp', 'tr-'));
  try {
    const deSubtitulos = await subtitulos(peticion, ejecutar, tmp, dependencias.raizCache);
    if (deSubtitulos) return deSubtitulos;
    if (!binarios.whisper || !binarios.ffmpeg) {
      return { estado: 'faltan-binarios', instalar: faltan(binarios), motivo: 'sin subtítulos en español y sin Whisper o ffmpeg locales' };
    }
    return await whisper(peticion, ejecutar, binarios, tmp, dependencias.raizCache);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
