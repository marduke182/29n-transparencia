#!/usr/bin/env node
/**
 * Compares two runs of one day, the live run and a shadow run (bin/sombra.sh):
 * their adjudicated proposals (adjudicado/<partido>.json) and shared facts
 * (hechos.json). Markdown on stdout: counts per party, section and state;
 * items in one run but not the other (by section and canonical source URL);
 * for items in both, changes of state and of quotes. Reads only.
 *
 *   node bin/comparar.ts <carpeta de la ejecución en vivo> <carpeta de la sombra>
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PARTY_IDS, urlCanonica } from '../src/cache.ts';

type Objeto = Record<string, unknown>;
const esObjeto = (v: unknown): v is Objeto => typeof v === 'object' && v !== null && !Array.isArray(v);
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const canonica = (url: unknown) => {
  try {
    return typeof url === 'string' ? urlCanonica(url) : '';
  } catch {
    return String(url);
  }
};

/** One proposal as the comparison sees it. */
export interface Propuesta {
  clave: string;
  seccion: string;
  estado: string;
  texto: string;
  citas: string[];
}

/** The quotes of an item: its `cita` and every «…» fragment of its text fields. */
const citasDe = (item: Objeto) =>
  [...(esObjeto(item.cita) && typeof item.cita.texto === 'string' ? [item.cita.texto] : []), ...['texto', 'matiz', 'afirmacion', 'antes', 'ahora'].flatMap((c) => (typeof item[c] === 'string' ? [...(item[c] as string).matchAll(/«([^»]+)»/g)].map((m) => m[1]!) : []))].sort();

/** The proposals of one adjudication answer, keyed by section and canonical first source (a perfil proposal by its kind and document). */
export function propuestasDe(contenido: unknown): Propuesta[] {
  const propuestas = esObjeto(contenido) ? lista(contenido.propuestas) : [];
  return propuestas.flatMap((p) => {
    if (!esObjeto(p)) return [];
    if (p.destino === 'perfil') {
      const dato = esObjeto(p[String(p.tipo)]) ? (p[String(p.tipo)] as Objeto) : {};
      const url = dato.url ?? lista(dato.documentos)[0];
      return [{ clave: `perfil:${String(p.tipo)} ${canonica(url)}`, seccion: `perfil:${String(p.tipo)}`, estado: '-', texto: String(dato.texto ?? dato.titulo ?? ''), citas: esObjeto(dato.cita) && typeof dato.cita.texto === 'string' ? [dato.cita.texto] : [] }];
    }
    const item = esObjeto(p.item) ? p.item : {};
    const url = lista(item.fuentes).map((f) => (esObjeto(f) ? f.url : undefined)).find((u) => typeof u === 'string');
    const seccion = String(p.seccion ?? '');
    return [{ clave: `${seccion} ${canonica(url)}`, seccion, estado: String(item.estado ?? ''), texto: String(item.texto ?? ''), citas: citasDe(item) }];
  });
}

const contar = (valores: string[]) => {
  const cuenta = new Map<string, number>();
  for (const v of valores) cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
  return [...cuenta.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
};
const corto = (texto: string) => (texto.length > 160 ? `${texto.slice(0, 157)}…` : texto);

/** The comparison of two days' proposals and facts, as Markdown. */
export function comparar(vivo: Partial<Record<string, unknown>>, sombra: Partial<Record<string, unknown>>, hechos: { vivo?: unknown; sombra?: unknown }): string {
  const lineas = ['# Comparación de la adjudicación: en vivo y en sombra', ''];
  lineas.push('| Partido | En vivo | En sombra | Solo en vivo | Solo en sombra | Estado distinto | Citas distintas |', '|---|---|---|---|---|---|---|');
  const detalle: string[] = [];
  for (const partido of PARTY_IDS) {
    const a = propuestasDe(vivo[partido]);
    const b = propuestasDe(sombra[partido]);
    const porClave = (xs: Propuesta[]) => new Map(xs.map((x) => [x.clave, x]));
    const ma = porClave(a);
    const mb = porClave(b);
    const soloA = a.filter((x) => !mb.has(x.clave));
    const soloB = b.filter((x) => !ma.has(x.clave));
    const ambos = a.filter((x) => mb.has(x.clave)).map((x) => [x, mb.get(x.clave)!] as const);
    const estado = ambos.filter(([x, y]) => x.estado !== y.estado);
    const citas = ambos.filter(([x, y]) => x.citas.join('|') !== y.citas.join('|'));
    lineas.push(`| ${partido} | ${a.length} | ${b.length} | ${soloA.length} | ${soloB.length} | ${estado.length} | ${citas.length} |`);
    detalle.push(`## ${partido}`, '');
    for (const [nombre, f] of [['sección', (x: Propuesta) => x.seccion], ['estado', (x: Propuesta) => x.estado]] as const) {
      const ca = new Map(contar(a.map(f)));
      const cb = new Map(contar(b.map(f)));
      const claves = [...new Set([...ca.keys(), ...cb.keys()])].sort();
      detalle.push(`Por ${nombre}: ${claves.map((k) => `${k} ${ca.get(k) ?? 0}→${cb.get(k) ?? 0}`).join(', ') || 'nada'}.`, '');
    }
    detalle.push(`### Solo en vivo (${soloA.length})`, '', ...(soloA.length ? soloA.map((x) => `- \`${x.clave}\` (${x.estado}): ${corto(x.texto)}`) : ['_Ninguno._']), '');
    detalle.push(`### Solo en sombra (${soloB.length})`, '', ...(soloB.length ? soloB.map((x) => `- \`${x.clave}\` (${x.estado}): ${corto(x.texto)}`) : ['_Ninguno._']), '');
    detalle.push(`### Estado distinto (${estado.length})`, '', ...(estado.length ? estado.map(([x, y]) => `- \`${x.clave}\`: ${x.estado} → ${y.estado}`) : ['_Ninguno._']), '');
    detalle.push(`### Citas distintas (${citas.length})`, '', ...(citas.length ? citas.map(([x, y]) => `- \`${x.clave}\`: «${x.citas.join('» «')}» → «${y.citas.join('» «')}»`) : ['_Ninguna._']), '');
  }
  const claves = (h: unknown) => new Set((esObjeto(h) ? lista(h.hechos) : []).flatMap((x) => (esObjeto(x) && typeof x.hecho === 'string' ? [x.hecho] : [])));
  const ha = claves(hechos.vivo);
  const hb = claves(hechos.sombra);
  lineas.push('', `Hechos compartidos: ${ha.size} en vivo, ${hb.size} en sombra; solo en vivo: ${[...ha].filter((k) => !hb.has(k)).sort().join(', ') || 'ninguno'}; solo en sombra: ${[...hb].filter((k) => !ha.has(k)).sort().join(', ') || 'ninguno'}.`, '');
  return [...lineas, ...detalle].join('\n').replace(/\n+$/, '\n');
}

const leer = (ruta: string): unknown => (existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : undefined);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [vivo, sombra] = process.argv.slice(2);
  if (!vivo || !sombra) {
    process.stderr.write('Uso: node bin/comparar.ts <ejecución en vivo> <ejecución en sombra>\n');
    process.exit(2);
  }
  const de = (ej: string) => Object.fromEntries(PARTY_IDS.map((p) => [p, leer(join(ej, 'adjudicado', `${p}.json`))]));
  process.stdout.write(comparar(de(vivo), de(sombra), { vivo: leer(join(vivo, 'hechos.json')), sombra: leer(join(sombra, 'hechos.json')) }));
}
