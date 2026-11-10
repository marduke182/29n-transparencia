/**
 * Fixed network for `diario.sh --seco`: loaded with `node --import`, it
 * replaces fetch with the answers in $N29_RED_FIJA/rutas.json
 * ({ url: { estado, tipo, archivo } }). Any other URL fails as a network
 * error, so no real host is ever contacted (robots.txt of an unknown host
 * counts as unavailable and nothing more is requested from it). DNS answers
 * one fixed public address for every host, without
 * sending any query, so traer.ts's internal-address check still runs.
 *
 * The answers are instant, so the clock that spaces requests to one host
 * (traer.ts) is advanced a minute per reading: the polite interval is still
 * computed, never waited for. Nothing else in the CLI reads that clock.
 */
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raiz = process.env.N29_RED_FIJA;
if (!raiz) throw new Error('red-fija.mjs: falta N29_RED_FIJA');
const rutas = JSON.parse(readFileSync(join(raiz, 'rutas.json'), 'utf8'));

const fetchFijo = async (entrada) => {
  const url = String(entrada instanceof Request ? entrada.url : entrada);
  const ruta = rutas[url];
  if (!ruta) throw new TypeError(`fetch failed (red fija: sin respuesta para ${url})`);
  return new Response(readFileSync(join(raiz, ruta.archivo)), { status: ruta.estado, headers: { 'content-type': ruta.tipo } });
};
// traer.ts uses this instead of its node:https fetch (Symbol RED_FIJA there).
globalThis[Symbol.for('29n-transparencia.red-fija')] = fetchFijo;
globalThis.fetch = fetchFijo;

let reloj = 0;
performance.now = () => (reloj += 60_000);

const fija = '93.184.215.14';
dns.promises.lookup = async (_host, opciones) => (opciones && typeof opciones === 'object' && opciones.all ? [{ address: fija, family: 4 }] : { address: fija, family: 4 });
