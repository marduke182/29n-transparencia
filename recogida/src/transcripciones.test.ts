import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crearEjecutar, detectarBinarios, faltan, LIMITE_TOTAL_MS, textoDeVtt, transcribir, type Binarios, type Ejecutar } from './transcripciones.ts';
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
function ejecutarFalso(escenario: { manuales?: boolean; automaticos?: boolean }) {
  const llamadas: { comando: string; args: string[] }[] = [];
  const audios: string[] = [];
  const ejecutar: Ejecutar = vi.fn(async (comando, args) => {
    llamadas.push({ comando, args });
    if (comando === 'yt-dlp' && args.includes('--skip-download')) {
      const carpeta = carpetaDe(args);
      const subtitles = escenario.manuales ? { es: [{ ext: 'vtt' }] } : {};
      const automatic_captions = escenario.automaticos ? { es: [{ ext: 'vtt' }] } : {};
      await writeFile(join(carpeta, 'video.info.json'), JSON.stringify({ id: 'abc123', subtitles, automatic_captions }));
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
    expect(llamadas).toHaveLength(1);
    const args = llamadas[0]!.args;
    for (const flag of ['--skip-download', '--write-subs', '--write-auto-subs', '--ignore-config', '--no-cookies', '--no-cookies-from-browser']) expect(args).toContain(flag);
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
