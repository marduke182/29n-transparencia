#!/usr/bin/env node
/**
 * Daily collection CLI. Paths come only from N29_SITIO (site repo, read for
 * the registry and written by `fusionar`), N29_CACHE (cache and run folders,
 * never inside a repo) and N29_BUZON (manual inbox). The run date is always
 * an argument: `--fecha YYYY-MM-DD`.
 *
 *   29n-recogida descubrir   --fecha D [--dias 2]
 *   29n-recogida traer       --fecha D             (candidatos de descubrir.json)
 *   29n-recogida buzon       --fecha D [--todo]
 *   29n-recogida transcribir --fecha D --video URL [--oficial URL] [--modelo-whisper ARCHIVO]
 *   29n-recogida binarios
 *   29n-recogida fusionar    --fecha D [--ejecucion CARPETA] [--seco]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { raizCache, rutaDeEntorno } from '../src/cache.ts';
import { leerBuzon } from '../src/buzon.ts';
import { accesoDesdeRegistro, descubrir, leerRegistro, type Descubrimiento } from '../src/descubrir.ts';
import { fusionar } from '../src/fusionar.ts';
import { Traedor, bloqueosDelDia, escribirBloqueados, guardarDesdeFeed, leerBloqueados, traerYGuardar } from '../src/traer.ts';
import { detectarBinarios, faltan, transcribir } from '../src/transcripciones.ts';

const AYUDA = `Uso: 29n-recogida <descubrir|traer|buzon|transcribir|binarios|fusionar> --fecha AAAA-MM-DD [opciones]`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    fecha: { type: 'string' },
    dias: { type: 'string' },
    todo: { type: 'boolean' },
    video: { type: 'string' },
    oficial: { type: 'string' },
    'modelo-whisper': { type: 'string' },
    ejecucion: { type: 'string' },
    seco: { type: 'boolean' },
  },
});

const json = (valor: unknown) => `${JSON.stringify(valor, null, 2)}\n`;

function fecha(): string {
  if (!values.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(values.fecha)) throw new Error('Falta --fecha AAAA-MM-DD (la fecha de la ejecución)');
  return values.fecha;
}

/** A Traedor for the run date, with the day's blocks and the per-host access of fuentes.json. */
async function traedorDelDia(cache: string, dia: string) {
  const ruta = join(cache, 'bloqueados.json');
  const todos = await leerBloqueados(ruta);
  const { emisores } = await leerRegistro(rutaDeEntorno('N29_SITIO'));
  const traedor = new Traedor({ fecha: dia, bloqueados: bloqueosDelDia(todos, dia), ...accesoDesdeRegistro(emisores) });
  const guardar = () => escribirBloqueados(ruta, { ...todos, ...traedor.bloqueados });
  return { traedor, guardar };
}

const carpetaEjecucion = (cache: string, dia: string) => join(cache, 'ejecuciones', dia);

async function main() {
  const [orden] = positionals;
  switch (orden) {
    case 'descubrir': {
      const dia = fecha();
      const cache = raizCache();
      const registro = await leerRegistro(rutaDeEntorno('N29_SITIO'));
      const { traedor, guardar } = await traedorDelDia(cache, dia);
      const resultado = await descubrir(registro, traedor, { fecha: dia, dias: values.dias ? Number(values.dias) : undefined });
      await guardar();
      const carpeta = carpetaEjecucion(cache, dia);
      await mkdir(carpeta, { recursive: true });
      await writeFile(join(carpeta, 'descubrir.json'), json(resultado));
      console.log(`${resultado.candidatos.length} candidatos, ${resultado.tareas_busqueda.length} tareas de búsqueda, ${resultado.fallos.length} fallos → ${join(carpeta, 'descubrir.json')}`);
      return;
    }
    case 'traer': {
      const dia = fecha();
      const cache = raizCache();
      const carpeta = carpetaEjecucion(cache, dia);
      const descubierto = JSON.parse(await readFile(join(carpeta, 'descubrir.json'), 'utf8')) as Descubrimiento;
      const { traedor, guardar } = await traedorDelDia(cache, dia);
      const informe = [];
      for (const candidato of descubierto.candidatos) {
        if (candidato.contenido_feed) {
          // The host's pages block: keep the feed's own text, never request the page.
          const guardado = await guardarDesdeFeed(cache, dia, { url: candidato.url, contenido: candidato.contenido_feed, listado: candidato.listado, extra: { emisor: candidato.emisor, genero: candidato.genero } });
          informe.push({ url: candidato.url, estado: 'feed', id: guardado.id, cache: guardado.estado });
          continue;
        }
        const { respuesta, guardado } = await traerYGuardar(traedor, cache, candidato.url, candidato.metodo, { emisor: candidato.emisor, genero: candidato.genero });
        informe.push({ url: candidato.url, estado: respuesta.estado, ...(guardado ? { id: guardado.id, cache: guardado.estado } : {}), ...('motivo' in respuesta ? { motivo: respuesta.motivo } : {}) });
      }
      await guardar();
      await writeFile(join(carpeta, 'traer.json'), json({ fecha: dia, resultados: informe, bloqueados: traedor.bloqueados }));
      console.log(`${informe.filter((r) => r.estado === 'ok').length}/${informe.length} traídos; bloqueados: ${Object.keys(traedor.bloqueados).join(', ') || 'ninguno'}`);
      return;
    }
    case 'buzon': {
      const dia = fecha();
      const resultado = await leerBuzon(rutaDeEntorno('N29_BUZON'), raizCache(), values.todo ? {} : { fecha: dia });
      for (const rechazo of resultado.rechazados) console.error(`rechazado ${rechazo.archivo}: ${rechazo.motivo}`);
      console.log(`${resultado.guardados.length} guardados, ${resultado.rechazados.length} rechazados`);
      if (resultado.rechazados.length) process.exitCode = 1;
      return;
    }
    case 'binarios': {
      const binarios = await detectarBinarios();
      console.log(json(binarios));
      const instalar = faltan(binarios);
      if (instalar.length) console.log(`Para instalar lo que falta:\n${instalar.join('\n')}`);
      return;
    }
    case 'transcribir': {
      const dia = fecha();
      if (!values.video) throw new Error('Falta --video URL');
      const cache = raizCache();
      const { traedor, guardar } = await traedorDelDia(cache, dia);
      const resultado = await transcribir(
        { video_url: values.video, oficial_url: values.oficial, fecha: dia, modeloWhisper: values['modelo-whisper'] ? resolve(values['modelo-whisper']) : undefined },
        { raizCache: cache, traedor },
      );
      await guardar();
      if (resultado.estado === 'ok') console.log(`${resultado.fuente}: ${resultado.guardado.dir} (${resultado.guardado.estado})`);
      else {
        console.error(resultado.motivo);
        if (resultado.estado === 'faltan-binarios') console.error(`Para instalar lo que falta:\n${resultado.instalar.join('\n')}`);
        process.exitCode = 1;
      }
      return;
    }
    case 'fusionar': {
      const dia = fecha();
      const carpeta = values.ejecucion ? resolve(values.ejecucion) : join(carpetaEjecucion(raizCache(), dia), 'adjudicado');
      const plan = await fusionar({ sitio: rutaDeEntorno('N29_SITIO'), carpeta, fecha: dia, escribir: !values.seco });
      console.log(json(plan));
      return;
    }
    default:
      console.error(AYUDA);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
