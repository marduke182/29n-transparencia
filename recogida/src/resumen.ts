/**
 * Resumen diario para la revisión del propietario: compara las fichas de los
 * cuatro partidos (y sus perfiles de documentos, si los hay) antes y después de
 * la recogida del día y escribe un Markdown con un bloque por partido, en el
 * orden de PARTY_IDS y con los mismos encabezados en todos, aunque estén vacíos.
 * Dentro de cada lista, los elementos se agrupan por la pregunta del votante a la
 * que responden (preguntas.ts, criterios/preguntas.md), luego por sección y estado.
 *
 * Determinista: la fecha llega como argumento, sin reloj ni aleatoriedad, y
 * todo se ordena con Intl.Collator('es').
 *
 * Uso: node src/resumen.ts --fecha AAAA-MM-DD --antes <carpeta>
 *   - después: $N29_SITIO/src/data/{partidos,perfiles}/<id>.json y fuentes.json;
 *   - antes: <carpeta>/{partidos,perfiles}/<id>.json, relativa a $N29_CACHE;
 *   - buzón: los archivos de $N29_BUZON/<id>/<fecha>/ (ver buzon.ts), si N29_BUZON está definido.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { urlDeArchivo } from './buzon.ts';
import { PARTY_IDS, type PartyId } from './cache.ts';
import { contarPalabras } from './citas.ts';
import { IDS_PREGUNTA, PREGUNTAS, preguntaDe } from './preguntas.ts';

export { PARTY_IDS };

export const PARTY_SHORT: Record<PartyId, string> = {
  'frente-amplio': 'Frente Amplio',
  pp: 'PP',
  psoe: 'PSOE',
  vox: 'Vox',
};

/** Orden de las secciones de la ficha; las del perfil y la tarjeta van detrás. */
const ORDEN_SECCIONES = [
  'tarjeta',
  'candidatura',
  'lema-y-frases',
  'temas',
  'por-escrito',
  'verificacion',
  'historial',
  'cambios',
  'criticos-defensores',
  'encuestas',
  'perfil.propuestas',
  'perfil.mensajes',
];

/** Tipos de emisor que cuentan como prensa: un PARCIAL que solo se apoya en ellos no tiene fuente primaria. */
const TIPOS_PRENSA = ['medio', 'agencia'];

const collator = new Intl.Collator('es', { numeric: true });
const comparar = (a: string, b: string) => collator.compare(a, b);

export interface Instantanea {
  partidos: Partial<Record<PartyId, unknown>>;
  perfiles: Partial<Record<PartyId, unknown>>;
}

export interface EmisorMinimo {
  nombre: string;
  hosts: string[];
  tipo: string;
}

export interface EntradaResumen {
  /** Fecha de la ejecución, AAAA-MM-DD. */
  fecha: string;
  antes: Instantanea;
  despues: Instantanea;
  /** Archivos del buzón de cada partido para la fecha; sin él, el bloque dice que no se leyó. */
  buzon?: Partial<Record<PartyId, unknown[]>>;
  /** Registro de fuentes, para clasificar hosts; sin él ningún host cuenta como prensa. */
  emisores?: EmisorMinimo[];
}

type Obj = Record<string, unknown>;
const esObjeto = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const esTexto = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function hostDe(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** JSON con las claves ordenadas, para comparar elementos sin depender del orden de los campos. */
function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  if (esObjeto(v)) {
    const claves = Object.keys(v).sort();
    return `{${claves.map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Un elemento de la ficha o del perfil, con su clave de identidad. */
interface Elemento {
  clave: string;
  seccion: string;
  estado: string;
  texto: string;
  datos: Obj;
}

function publicados(partido: unknown, perfil: unknown): Map<string, Elemento> {
  const mapa = new Map<string, Elemento>();
  const p = esObjeto(partido) ? partido : {};
  for (const seccion of lista(p.secciones)) {
    if (!esObjeto(seccion)) continue;
    const id = String(seccion.id);
    for (const item of lista(seccion.items)) {
      if (!esObjeto(item) || !esTexto(item.ref)) continue;
      mapa.set(item.ref, {
        clave: item.ref,
        seccion: id,
        estado: String(item.estado ?? '—'),
        texto: String(item.texto ?? ''),
        datos: item,
      });
    }
  }
  if (esObjeto(p.tarjeta)) mapa.set('tarjeta', { clave: 'tarjeta', seccion: 'tarjeta', estado: '—', texto: '', datos: p.tarjeta });
  const perfilObj = esObjeto(perfil) ? perfil : {};
  for (const item of lista(perfilObj.propuestas)) {
    if (!esObjeto(item)) continue;
    const clave = `propuesta:${String(item.cita_documento ?? '')}:${String(item.cita ?? item.texto ?? '')}`;
    mapa.set(clave, { clave, seccion: 'perfil.propuestas', estado: '—', texto: String(item.texto ?? ''), datos: item });
  }
  for (const item of lista(perfilObj.mensajes)) {
    if (!esObjeto(item)) continue;
    const clave = `mensaje:${String(item.texto ?? '')}`;
    mapa.set(clave, { clave, seccion: 'perfil.mensajes', estado: '—', texto: String(item.texto ?? ''), datos: item });
  }
  return mapa;
}

/**
 * Entradas de `descartados` ({ref, estado, motivo}) o `en_espera` (elementos
 * completos, como los de las secciones, con un campo `seccion` obligatorio), por ref.
 */
function apartados(partido: unknown, campo: 'descartados' | 'en_espera'): Map<string, Obj> {
  const mapa = new Map<string, Obj>();
  const p = esObjeto(partido) ? partido : {};
  for (const e of lista(p[campo])) if (esObjeto(e) && esTexto(e.ref)) mapa.set(e.ref, e);
  return mapa;
}

/** Todas las URL de una ficha y su perfil. */
function urlsDe(partido: unknown, perfil: unknown): string[] {
  const urls: unknown[] = [];
  const p = esObjeto(partido) ? partido : {};
  const t = esObjeto(p.tarjeta) ? p.tarjeta : {};
  urls.push(t.fuente_lema, t.fuente_propuesta, ...lista(t.fuentes_propuesta));
  for (const seccion of lista(p.secciones)) {
    for (const item of lista(esObjeto(seccion) ? seccion.items : [])) {
      if (!esObjeto(item)) continue;
      for (const f of lista(item.fuentes)) if (esObjeto(f)) urls.push(f.url);
      if (esObjeto(item.cita)) urls.push(item.cita.url);
    }
  }
  const perfilObj = esObjeto(perfil) ? perfil : {};
  for (const d of lista(perfilObj.documentos)) if (esObjeto(d)) urls.push(d.url);
  return urls.filter(esTexto);
}

function recuentos(partido: unknown) {
  let criticos = 0;
  let defensores = 0;
  let palabras = 0;
  const p = esObjeto(partido) ? partido : {};
  for (const seccion of lista(p.secciones)) {
    for (const item of lista(esObjeto(seccion) ? seccion.items : [])) {
      if (!esObjeto(item)) continue;
      if (item.postura === 'critico') criticos++;
      if (item.postura === 'defensor') defensores++;
      if (typeof item.texto === 'string') palabras += contarPalabras(item.texto);
    }
  }
  return { criticos, defensores, palabras };
}

const indiceSeccion = (s: string) => {
  const i = ORDEN_SECCIONES.indexOf(s);
  return i === -1 ? ORDEN_SECCIONES.length : i;
};

interface Linea {
  seccion: string;
  estado: string;
  clave: string;
  nota: string;
  /** Datos del elemento (para separar verificacion en Q3 y Q6 por `bulo`). */
  datos?: Obj;
}

/** Grupo de pregunta de una línea: Q1..Q8, o «otros» para la tarjeta, el perfil y lo no publicado. */
const OTROS = 'otros';
const grupoPregunta = (l: Linea): string => preguntaDe(l.seccion, l.datos) ?? OTROS;
const indicePregunta = (g: string) => {
  const i = (IDS_PREGUNTA as string[]).indexOf(g);
  return i === -1 ? IDS_PREGUNTA.length : i;
};
const tituloPregunta = (g: string) =>
  g === OTROS ? 'Sin pregunta (tarjeta, perfil o sin sección)' : `${g} · ${PREGUNTAS[g as keyof typeof PREGUNTAS].texto}`;

function ordenar(lineas: Linea[]): Linea[] {
  return [...lineas].sort(
    (a, b) =>
      indicePregunta(grupoPregunta(a)) - indicePregunta(grupoPregunta(b)) ||
      indiceSeccion(a.seccion) - indiceSeccion(b.seccion) ||
      comparar(a.seccion, b.seccion) ||
      comparar(a.estado, b.estado) ||
      comparar(a.clave, b.clave),
  );
}

const recortar = (texto: string, max = 100) => {
  const t = texto.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Lista agrupada por pregunta, sección y estado: «- **Qn · pregunta** (n)»,
 * debajo «  - `seccion` · ESTADO (n)» y debajo cada elemento.
 */
function bloqueLista(titulo: string, lineas: Linea[], vacio: string): string[] {
  const salida = [`### ${titulo} (${lineas.length})`, ''];
  if (!lineas.length) return [...salida, vacio, ''];
  let pregunta = '';
  let grupo = '';
  for (const l of ordenar(lineas)) {
    const p = grupoPregunta(l);
    if (p !== pregunta) {
      pregunta = p;
      grupo = '';
      salida.push(`- **${tituloPregunta(p)}** (${lineas.filter((x) => grupoPregunta(x) === p).length})`);
    }
    const g = `${l.seccion}\u0000${l.estado}`;
    if (g !== grupo) {
      grupo = g;
      const n = lineas.filter((x) => grupoPregunta(x) === p && x.seccion === l.seccion && x.estado === l.estado).length;
      salida.push(`  - \`${l.seccion}\` · ${l.estado} (${n})`);
    }
    salida.push(`    - ${l.clave}${l.nota ? `: ${l.nota}` : ''}`);
  }
  return [...salida, ''];
}

function camposCambiados(a: Obj, b: Obj): string[] {
  const claves = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return claves.filter((k) => canonico(a[k]) !== canonico(b[k])).sort(comparar);
}

function bloquePartido(id: PartyId, e: EntradaResumen, emisorDe: Map<string, EmisorMinimo>): string[] {
  const antesP = e.antes.partidos[id];
  const despuesP = e.despues.partidos[id];
  const antes = publicados(antesP, e.antes.perfiles[id]);
  const despues = publicados(despuesP, e.despues.perfiles[id]);
  const descAntes = apartados(antesP, 'descartados');
  const descDespues = apartados(despuesP, 'descartados');
  const esperaAntes = apartados(antesP, 'en_espera');
  const esperaDespues = apartados(despuesP, 'en_espera');

  const anadidos: Linea[] = [];
  const cambiados: Linea[] = [];
  for (const [clave, el] of despues) {
    const previo = antes.get(clave);
    if (!previo) {
      const origen = descAntes.has(clave) ? ' (antes en descartados)' : esperaAntes.has(clave) ? ' (antes en espera)' : '';
      const nombre = el.seccion.startsWith('perfil.') ? '' : clave;
      anadidos.push({ seccion: el.seccion, estado: el.estado, clave: nombre || recortar(el.texto, 60), nota: `${recortar(el.texto)}${origen}`, datos: el.datos });
    } else if (canonico(previo.datos) !== canonico(el.datos)) {
      const campos = camposCambiados(previo.datos, el.datos);
      const movida = previo.seccion !== el.seccion ? `; sección ${previo.seccion} → ${el.seccion}` : '';
      const estado = previo.estado !== el.estado ? `${previo.estado} → ${el.estado}` : el.estado;
      cambiados.push({ seccion: el.seccion, estado, clave, nota: `campos: ${campos.join(', ')}${movida}`, datos: el.datos });
    }
  }

  const movidos = (nuevos: Map<string, Obj>, previos: Map<string, Obj>) => {
    const salida: Linea[] = [];
    for (const [ref, entrada] of nuevos) {
      if (previos.has(ref)) continue;
      const seccion = esTexto(entrada.seccion) ? entrada.seccion : (antes.get(ref)?.seccion ?? '(no publicado)');
      const estado = esTexto(entrada.estado) ? entrada.estado : '—';
      const nota = entrada.motivo ?? entrada.texto ?? antes.get(ref)?.texto ?? '';
      salida.push({ seccion, estado, clave: ref, nota: recortar(String(nota)), datos: { ...antes.get(ref)?.datos, ...entrada } });
    }
    return salida;
  };
  const aDescartados = movidos(descDespues, descAntes);
  const aEspera = movidos(esperaDespues, esperaAntes);

  const retirados: Linea[] = [];
  for (const [clave, el] of antes) {
    if (despues.has(clave) || descDespues.has(clave) || esperaDespues.has(clave)) continue;
    const nombre = el.seccion.startsWith('perfil.') ? recortar(el.texto, 60) : clave;
    retirados.push({ seccion: el.seccion, estado: el.estado, clave: nombre, nota: el.seccion.startsWith('perfil.') ? '' : recortar(el.texto), datos: el.datos });
  }

  // PARCIAL que solo se apoyan en prensa (medios y agencias del registro), en el estado de después.
  const parciales = [...despues.values()].filter((el) => el.estado === 'PARCIAL');
  const soloPrensa = parciales
    .filter((el) => {
      const hosts = lista(el.datos.fuentes).map((f) => (esObjeto(f) && esTexto(f.url) ? hostDe(f.url) : ''));
      return hosts.length > 0 && hosts.every((h) => TIPOS_PRENSA.includes(emisorDe.get(h)?.tipo ?? ''));
    })
    .map((el) => el.clave)
    .sort(comparar);

  const hostsAntes = new Set(urlsDe(antesP, e.antes.perfiles[id]).map(hostDe));
  const hostsNuevos = [...new Set(urlsDe(despuesP, e.despues.perfiles[id]).map(hostDe))]
    .filter((h) => h && !hostsAntes.has(h))
    .sort(comparar);

  const buzon = lista(e.buzon?.[id])
    .map((item) => {
      const o = esObjeto(item) ? item : {};
      const url = esTexto(o.url) ? o.url : '';
      const titulo = esTexto(o.titulo) ? o.titulo : url || '(sin título)';
      const fecha = esTexto(o.fecha) ? o.fecha : '';
      const medio = esTexto(o.medio) ? o.medio : url ? hostDe(url) : '';
      return { fecha, linea: `- ${[fecha, medio].filter(Boolean).join(' · ')}${fecha || medio ? ': ' : ''}${recortar(titulo)}${url && url !== titulo ? ` <${url}>` : ''}` };
    })
    .sort((a, b) => comparar(a.fecha, b.fecha) || comparar(a.linea, b.linea));

  const r0 = recuentos(antesP);
  const r1 = recuentos(despuesP);
  const dif = (a: number, b: number) => (b - a > 0 ? `+${b - a}` : String(b - a));

  const salida = [`## ${PARTY_SHORT[id]}`, ''];
  if (despuesP === undefined) salida.push('_Sin ficha después de la recogida._', '');
  salida.push(
    ...bloqueLista('Añadidos', anadidos, '_Ninguno._'),
    ...bloqueLista('Modificados', cambiados, '_Ninguno._'),
    ...bloqueLista('Pasados a descartados', aDescartados, '_Ninguno._'),
    ...bloqueLista('Pasados a en espera', aEspera, '_Ninguno._'),
    ...bloqueLista('Retirados sin rastro', retirados, '_Ninguno._'),
    `### PARCIAL solo con prensa (${soloPrensa.length} de ${parciales.length})`,
    '',
    soloPrensa.length ? soloPrensa.map((ref) => `- ${ref}`).join('\n') : '_Ninguno._',
    '',
    `### Fuentes nuevas (${hostsNuevos.length})`,
    '',
    hostsNuevos.length
      ? hostsNuevos
          .map((h) => {
            const em = emisorDe.get(h);
            return `- ${h}: ${em ? `${em.nombre} (${em.tipo})` : 'sin registrar'}`;
          })
          .join('\n')
      : '_Ninguna._',
    '',
    `### Buzón (${buzon.length})`,
    '',
    buzon.length ? buzon.map((b) => b.linea).join('\n') : '_Vacío._',
    '',
    '### Recuentos',
    '',
    '| | Antes | Después | Diferencia |',
    '|---|---:|---:|---:|',
    `| Críticos | ${r0.criticos} | ${r1.criticos} | ${dif(r0.criticos, r1.criticos)} |`,
    `| Defensores | ${r0.defensores} | ${r1.defensores} | ${dif(r0.defensores, r1.defensores)} |`,
    `| Palabras (texto publicado) | ${r0.palabras} | ${r1.palabras} | ${dif(r0.palabras, r1.palabras)} |`,
    '',
  );
  return salida;
}

/** El resumen completo en Markdown. */
export function resumen(e: EntradaResumen): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.fecha)) throw new Error(`fecha "${e.fecha}" no es AAAA-MM-DD`);
  const emisorDe = new Map<string, EmisorMinimo>();
  for (const em of e.emisores ?? []) for (const h of em.hosts) if (!emisorDe.has(h)) emisorDe.set(h, em);
  const lineas = [`# Resumen de la recogida del ${e.fecha}`, ''];
  if (!e.emisores?.length) lineas.push('_Sin registro de fuentes: ningún host cuenta como prensa._', '');
  if (!e.buzon) lineas.push('_Sin buzón: no se leyó ninguna carpeta del buzón._', '');
  for (const id of PARTY_IDS) lineas.push(...bloquePartido(id, e, emisorDe));
  return lineas.join('\n').replace(/\n+$/, '\n');
}

function leerJson(ruta: string): unknown {
  return existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : undefined;
}

function instantanea(carpeta: string): Instantanea {
  const partidos: Instantanea['partidos'] = {};
  const perfiles: Instantanea['perfiles'] = {};
  for (const id of PARTY_IDS) {
    partidos[id] = leerJson(join(carpeta, 'partidos', `${id}.json`));
    perfiles[id] = leerJson(join(carpeta, 'perfiles', `${id}.json`));
  }
  return { partidos, perfiles };
}

/** Los archivos del buzón de la fecha, por partido, con la URL que buzon.ts les asignaría. */
function leerBuzonDelDia(raiz: string, fecha: string): NonNullable<EntradaResumen['buzon']> {
  const salida: NonNullable<EntradaResumen['buzon']> = {};
  for (const id of PARTY_IDS) {
    const carpeta = join(raiz, id, fecha);
    const archivos = existsSync(carpeta) ? readdirSync(carpeta).sort() : [];
    salida[id] = archivos
      .filter((a: string) => !a.startsWith('.') && !a.endsWith('.url'))
      .map((archivo: string) => {
        const base = archivo.replace(/\.[^.]+$/, '');
        const sidecar = archivos.includes(`${base}.url`) ? readFileSync(join(carpeta, `${base}.url`), 'utf8') : undefined;
        const html = /\.html?$/i.test(archivo) ? readFileSync(join(carpeta, archivo), 'utf8') : undefined;
        return { titulo: archivo, url: urlDeArchivo(html, sidecar), fecha };
      });
  }
  return salida;
}

function argumento(args: string[], nombre: string): string | undefined {
  const i = args.indexOf(nombre);
  return i === -1 ? undefined : args[i + 1];
}

function main(args: string[]): number {
  const sitio = process.env.N29_SITIO;
  const cache = process.env.N29_CACHE;
  const fecha = argumento(args, '--fecha');
  const antes = argumento(args, '--antes');
  if (!sitio || !cache || !fecha || !antes) {
    process.stderr.write('Uso: N29_SITIO=… N29_CACHE=… [N29_BUZON=…] node src/resumen.ts --fecha AAAA-MM-DD --antes <carpeta>\n');
    return 2;
  }
  const datos = resolve(sitio, 'src', 'data');
  const raizBuzon = process.env.N29_BUZON;
  const buzon = raizBuzon ? leerBuzonDelDia(raizBuzon, fecha) : undefined;
  const fuentes = leerJson(join(datos, 'fuentes.json'));
  const emisores = (esObjeto(fuentes) ? lista(fuentes.emisores) : []).filter(
    (em): em is EmisorMinimo => esObjeto(em) && Array.isArray(em.hosts) && esTexto(em.tipo) && esTexto(em.nombre),
  );
  process.stdout.write(resumen({ fecha, antes: instantanea(resolve(cache, antes)), despues: instantanea(datos), buzon, emisores }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
