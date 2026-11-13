#!/usr/bin/env node
/**
 * Daily collection CLI. Paths come only from N29_SITIO (site repo, read for
 * the registry and written by `fusionar`), N29_CACHE (cache and run folders,
 * never inside a repo) and N29_BUZON (manual inbox). The run date is always
 * an argument: `--fecha YYYY-MM-DD`.
 *
 *   29n-recogida descubrir   --fecha D [--dias 2] [--atrasos-desde D1 --atrasos-hasta D2 --atrasos-emisores a,b]
 *   29n-recogida traer       --fecha D             (candidatos de descubrir.json)
 *   29n-recogida buzon       --fecha D [--todo]
 *   29n-recogida enlaces     --fecha D             ($N29_BUZON/enlaces/<D>.txt → enlaces.json)
 *   29n-recogida transcribir --fecha D --video URL [--oficial URL] [--modelo-whisper ARCHIVO]
 *   29n-recogida binarios
 *   29n-recogida fusionar    --fecha D [--ejecucion CARPETA] [--seco]
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { raizCache, rutaDeEntorno } from '../src/cache.ts';
import { leerBuzon, leerListaEnlaces } from '../src/buzon.ts';
import { accesoDesdeRegistro, descubrir, leerCandidatos, leerRegistro, type Atrasos, type Descubrimiento } from '../src/descubrir.ts';
import { lectorCache } from '../src/citas.ts';
import { fusionar } from '../src/fusionar.ts';
import { Traedor, bloqueosDelDia, escribirBloqueados, guardarDesdeFeed, guardarVetos, leerBloqueados, traerEnlaces, traerYGuardar } from '../src/traer.ts';
import { detectarBinarios, faltan, transcribir } from '../src/transcripciones.ts';

const AYUDA = `Uso: 29n-recogida <descubrir|traer|buzon|enlaces|transcribir|binarios|fusionar> --fecha AAAA-MM-DD [opciones]`;

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
    'atrasos-desde': { type: 'string' },
    'atrasos-hasta': { type: 'string' },
    'atrasos-emisores': { type: 'string' },
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
  // The blocks the guide lists (robots.txt against Claude's agents, anti-bot answers) go to the run's bloqueos-guia.json.
  const guardar = async () => {
    await escribirBloqueados(ruta, { ...todos, ...traedor.bloqueados });
    await guardarVetos(join(carpetaEjecucion(cache, dia), 'bloqueos-guia.json'), traedor.vetos, todos);
  };
  return { traedor, guardar };
}

/** The atrasos of descubrir: the three options together, or none. */
function atrasos(): Atrasos | undefined {
  const desde = values['atrasos-desde'];
  const hasta = values['atrasos-hasta'];
  const emisores = values['atrasos-emisores'];
  const dados = [desde, hasta, emisores].filter((valor) => valor !== undefined).length;
  if (dados === 0) return undefined;
  if (dados !== 3) throw new Error('--atrasos-desde, --atrasos-hasta y --atrasos-emisores van juntas (las tres o ninguna)');
  return { desde: desde!, hasta: hasta!, emisores: emisores!.split(',').map((id) => id.trim()) };
}

const carpetaEjecucion = (cache: string, dia: string) => join(cache, 'ejecuciones', dia);

async function main() {
  const [orden] = positionals;
  switch (orden) {
    case 'descubrir': {
      const dia = fecha();
      const cache = raizCache();
      const registro = { ...(await leerRegistro(rutaDeEntorno('N29_SITIO'))), candidatos: await leerCandidatos(rutaDeEntorno('N29_SITIO')) };
      const { traedor, guardar } = await traedorDelDia(cache, dia);
      const pedidos = atrasos();
      const resultado = await descubrir(registro, traedor, { fecha: dia, dias: values.dias ? Number(values.dias) : undefined, ...(pedidos ? { atrasos: pedidos } : {}) });
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
    case 'enlaces': {
      // The owner's links list: fetched like any discovered article, no date window; problems are avisos, never failures.
      const dia = fecha();
      const cache = raizCache();
      const ruta = join(rutaDeEntorno('N29_BUZON'), 'enlaces', `${dia}.txt`);
      const lista = leerListaEnlaces(existsSync(ruta) ? await readFile(ruta, 'utf8') : '');
      const { traedor, guardar } = await traedorDelDia(cache, dia);
      const resultado = await traerEnlaces(traedor, cache, lista);
      await guardar();
      const carpeta = carpetaEjecucion(cache, dia);
      await mkdir(carpeta, { recursive: true });
      await writeFile(join(carpeta, 'enlaces.json'), json({ fecha: dia, ...resultado }));
      for (const aviso of resultado.avisos) console.log(`aviso línea ${aviso.linea}: ${aviso.motivo}`);
      console.log(`${resultado.enlaces.filter((e) => e.estado === 'ok').length}/${resultado.enlaces.length} enlaces traídos, ${resultado.avisos.length} avisos`);
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
      else if (resultado.estado === 'aviso') {
        // Login, geo-block, DRM, robots or a non-public address: recorded, never worked around.
        console.error(`aviso: ${resultado.motivo}`);
        process.exitCode = 1;
      } else {
        console.error(resultado.motivo);
        if (resultado.estado === 'faltan-binarios') console.error(`Para instalar lo que falta:\n${resultado.instalar.join('\n')}`);
        process.exitCode = 1;
      }
      return;
    }
    case 'fusionar': {
      const dia = fecha();
      const carpeta = values.ejecucion ? resolve(values.ejecucion) : join(carpetaEjecucion(raizCache(), dia), 'adjudicado');
      // Quotes are checked against the run's cache (citas.ts): one not found literally leaves its item out.
      const plan = await fusionar({ sitio: rutaDeEntorno('N29_SITIO'), carpeta, fecha: dia, escribir: !values.seco, leer: lectorCache(raizCache()) });
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
