/**
 * Sources that block the guide: what the Claude sessions may not fetch, and
 * the `bloqueo` entries of the site registry (fuentes.json) the run proposes.
 *
 * - hostsSinClaude: hosts no Claude session may WebFetch (deny rules in every
 *   pass): emisores with `bloqueo`, robots.txt vetos found today, and a fixed
 *   fallback list in case the registry field is missing.
 * - registrarBloqueos: today's robots.txt vetos (bloqueos-guia.json, traer.ts)
 *   become `bloqueo` (the site's shape: tipo robots, evidencia, consultado,
 *   robots, agentes) + recogida omitir on the matching emisor, or a minimal
 *   new emisor for an unknown host. Never removes a bloqueo. Anti-bot vetos
 *   are listed for review only, never written: a challenge can be triggered
 *   by the rate of requests rather than a policy against the guide. A party
 *   website is never written either: the same rule for the four parties.
 * - revisarBloqueos: rereads the robots.txt of each recorded bloqueo; one that
 *   no longer excludes Claude's agents is listed for a person to decide.
 * - cambiosFuentesNoAdmitidos: the allowlist for fuentes.json: only those changes.
 */
import type { Emisor } from './descubrir.ts';
import { hostDe, hostEn, vetoClaude, type Traedor, type VetoGuia } from './traer.ts';

/**
 * Hosts whose robots.txt disallows Claude-User, ClaudeBot and Claude-SearchBot,
 * read on 2026-11-13 (elpais.com, www.elmundo.es, www.abc.es). Denied to every
 * Claude pass even if fuentes.json lacks their `bloqueo`.
 */
export const SIN_AGENTES_CLAUDE_FIJOS: readonly string[] = ['abc.es', 'elmundo.es', 'elpais.com'];

const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** Hosts no Claude session may fetch: the fixed list, every emisor with a bloqueo, and today's robots.txt vetos. Sorted, without repeats. */
export function hostsSinClaude(emisores: readonly Emisor[], vetos: readonly VetoGuia[] = []): string[] {
  const hosts = [...SIN_AGENTES_CLAUDE_FIJOS, ...emisores.filter((e) => e.bloqueo).flatMap((e) => e.hosts), ...vetos.filter((v) => v.tipo === 'robots').map((v) => v.host)];
  return [...new Set(hosts.map((h) => h.toLowerCase().replace(/^www\./, '')))].filter((h) => HOST.test(h)).sort();
}

/**
 * WebFetch deny rules for some hosts. `WebFetch(domain:x)` matches x only;
 * `WebFetch(domain:*.x)` matches its subdomains at any depth (www., feeds.…):
 * Claude Code permissions docs, read on 2026-11-13. A deny rule wins over the
 * template's bare `WebFetch` allow.
 */
export function reglasWebFetch(hosts: readonly string[]): string[] {
  return hosts.flatMap((host) => {
    if (!HOST.test(host)) throw new Error(`ajustes: host no admitido para WebFetch: ${host}`);
    return [`WebFetch(domain:${host})`, `WebFetch(domain:*.${host})`];
  });
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fechaCorta = (fecha: string) => {
  const [anio, mes, dia] = fecha.split('-').map(Number) as [number, number, number];
  return `${dia} ${MESES[mes - 1]} ${anio}`;
};

/** The recogida of an emisor whose robots.txt excludes Claude's agents (the site requires omitir with a bloqueo). */
const recogidaBloqueada = (agentes: readonly string[], fecha: string) => ({
  metodo: 'omitir' as const,
  nota: `Su robots.txt no permite el acceso de los agentes de Claude (${agentes.join(', ')}), consultado el ${fechaCorta(fecha)}. No se recogen.`,
});

type Bloqueo = NonNullable<Emisor['bloqueo']>;

/** The site's bloqueo for a robots.txt veto: the paths it still allows go into the evidence. */
const bloqueoDe = (veto: VetoGuia, fecha: string): Bloqueo => ({
  tipo: 'robots',
  evidencia: `${veto.evidencia}${veto.permitido?.length ? ` · Allow: ${veto.permitido.join(', ')}` : ''}`,
  consultado: fecha,
  robots: veto.robots!,
  agentes: veto.agentes!,
});

/** Same reading: a robots bloqueo with the same robots.txt host and agents (date and wording of the evidence aside). */
const mismoBloqueo = (a: Bloqueo, b: Bloqueo) =>
  a.tipo === b.tipo &&
  hostDe(a.robots ?? 'https://x.invalid') === hostDe(b.robots ?? 'https://y.invalid') &&
  JSON.stringify([...(a.agentes ?? [])].sort()) === JSON.stringify([...(b.agentes ?? [])].sort());

export interface InformeBloqueos {
  fecha: string;
  /** New emisores for unknown hosts: named after the host until a person names them. */
  nuevos: { id: string; host: string; evidencia: string }[];
  /** Existing emisores that got or changed their bloqueo (and recogida omitir). */
  actualizados: { id: string; host: string; evidencia: string; antes?: string }[];
  /** Already recorded with the same reading: no change. */
  ya_registrados: { id: string; host: string }[];
  /** Found today but not written to fuentes.json, with the reason (anti-bot blocks; a subdomain robots.txt). */
  sin_registrar: { host: string; tipo: VetoGuia['tipo']; evidencia: string; motivo: string; primera?: boolean; id?: string }[];
  /** Recorded bloqueos whose robots.txt no longer excludes Claude's agents: never removed automatically. */
  ya_no_bloquean: { id: string; robots: string }[];
  /** Recorded bloqueos whose robots.txt could not be read today. */
  sin_comprobar: { id: string; robots: string }[];
}

/** The emisor of a host: the one listing it exactly, else the one with the longest host it falls under (diariodeavisos.elespanol.com before elespanol.com). */
export function emisorDeHost(emisores: readonly Emisor[], host: string): Emisor | undefined {
  const exacto = emisores.find((e) => e.hosts.includes(host));
  if (exacto) return exacto;
  let mejor: { emisor: Emisor; largo: number } | undefined;
  for (const emisor of emisores) {
    for (const propio of emisor.hosts) if (hostEn(host, [propio]) && (!mejor || propio.length > mejor.largo)) mejor = { emisor, largo: propio.length };
  }
  return mejor?.emisor;
}

const idDeHost = (host: string, usados: Set<string>) => {
  const base = host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let id = base;
  for (let n = 2; usados.has(id); n++) id = `${base}-${n}`;
  return id;
};

/**
 * Writes today's robots.txt vetos into the registry: the matching emisor
 * (emisorDeHost: exact host first, else the longest host it falls under) gets
 * `bloqueo` and recogida omitir unless it already has the same reading; an
 * unknown host gets a minimal emisor (id and nombre from the host, tipo medio)
 * at the end of the list. Only reported, for review: a robots.txt read on a
 * subdomain the emisor does not list (the site requires the robots.txt of one
 * of its hosts), one without agents, a party website (never written alone,
 * the same rule for the four), and every anti-bot veto.
 * Returns a new registry object (the input is not changed) and the report.
 */
export function registrarBloqueos<R extends { emisores: Emisor[] }>(registro: R, vetos: readonly VetoGuia[], fecha: string): { registro: R; informe: InformeBloqueos; cambiado: boolean } {
  const emisores: Emisor[] = registro.emisores.map((e) => ({ ...e }));
  const informe: InformeBloqueos = { fecha, nuevos: [], actualizados: [], ya_registrados: [], sin_registrar: [], ya_no_bloquean: [], sin_comprobar: [] };
  const usados = new Set(emisores.map((e) => e.id));
  let cambiado = false;
  for (const veto of [...vetos].sort((a, b) => a.host.localeCompare(b.host))) {
    const emisor = emisorDeHost(emisores, veto.host);
    const apartar = (motivo: string) =>
      informe.sin_registrar.push({
        host: veto.host,
        tipo: veto.tipo,
        evidencia: veto.evidencia,
        motivo,
        ...(veto.primera !== undefined ? { primera: veto.primera } : {}),
        ...(emisor ? { id: emisor.id } : {}),
      });
    if (veto.tipo !== 'robots') {
      apartar('para revisar: un reto antibots puede deberse a la frecuencia de las peticiones; no se escribe solo');
      continue;
    }
    if (!veto.robots || !veto.agentes?.length) {
      apartar('para revisar: robots.txt sin agentes ni regla que citar; no se escribe solo');
      continue;
    }
    if (emisor?.tipo === 'partido') {
      apartar('para revisar: la web de un partido nunca se escribe sola, la misma regla para los cuatro');
      continue;
    }
    const bloqueo = bloqueoDe(veto, fecha);
    if (!emisor) {
      const host = hostDe(veto.robots);
      if (host !== veto.host || !HOST.test(host)) {
        informe.sin_registrar.push({ host: veto.host, tipo: veto.tipo, evidencia: veto.evidencia, motivo: `robots.txt en otro host (${host})` });
        continue;
      }
      const id = idDeHost(host, usados);
      usados.add(id);
      emisores.push({ id, nombre: host, hosts: [host], tipo: 'medio', recogida: recogidaBloqueada(bloqueo.agentes!, fecha), bloqueo });
      informe.nuevos.push({ id, host, evidencia: veto.evidencia });
      cambiado = true;
      continue;
    }
    if (!emisor.hosts.includes(hostDe(veto.robots))) {
      informe.sin_registrar.push({ host: veto.host, tipo: veto.tipo, evidencia: veto.evidencia, motivo: `robots.txt de un subdominio que ${emisor.id} no lista (${hostDe(veto.robots)})`, id: emisor.id });
      continue;
    }
    if (emisor.bloqueo && mismoBloqueo(emisor.bloqueo, bloqueo) && emisor.recogida?.metodo === 'omitir') {
      informe.ya_registrados.push({ id: emisor.id, host: veto.host });
      continue;
    }
    informe.actualizados.push({ id: emisor.id, host: veto.host, evidencia: veto.evidencia, ...(emisor.recogida ? { antes: `recogida ${emisor.recogida.metodo}` } : {}) });
    emisor.bloqueo = bloqueo;
    emisor.recogida = recogidaBloqueada(bloqueo.agentes!, fecha);
    cambiado = true;
  }
  return { registro: { ...registro, emisores }, informe, cambiado };
}

/**
 * Rereads the robots.txt of every recorded bloqueo (one polite request each,
 * through the Traedor's network checks): those that no longer exclude Claude's
 * agents, and those that could not be read. Nothing is changed.
 */
export async function revisarBloqueos(emisores: readonly Emisor[], traedor: Pick<Traedor, 'textoRobots'>): Promise<Pick<InformeBloqueos, 'ya_no_bloquean' | 'sin_comprobar'>> {
  const salida: Pick<InformeBloqueos, 'ya_no_bloquean' | 'sin_comprobar'> = { ya_no_bloquean: [], sin_comprobar: [] };
  for (const emisor of emisores) {
    const robots = emisor.bloqueo?.robots;
    if (!robots) continue;
    const texto = await traedor.textoRobots(robots);
    if (texto === undefined) salida.sin_comprobar.push({ id: emisor.id, robots });
    else if (!vetoClaude(texto)) salida.ya_no_bloquean.push({ id: emisor.id, robots });
  }
  return salida;
}

type Obj = Record<string, unknown>;
const esObjeto = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** JSON with sorted keys: key order (Prettier, edits in place) does not count as a change. */
export const canonico = (v: unknown): string => JSON.stringify(v, (_k, valor: unknown) => (esObjeto(valor) ? Object.fromEntries(Object.keys(valor).sort().map((k) => [k, valor[k]])) : valor));
const sin = (o: Obj, ...claves: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !claves.includes(k)));

function problemasBloqueo(where: string, emisor: Obj): string[] {
  const problemas: string[] = [];
  const bloqueo = emisor.bloqueo;
  // What registrarBloqueos writes: the site's Bloqueo of tipo robots, with every field.
  const forma =
    esObjeto(bloqueo) &&
    Object.keys(bloqueo).sort().join(',') === 'agentes,consultado,evidencia,robots,tipo' &&
    bloqueo.tipo === 'robots' &&
    typeof bloqueo.evidencia === 'string' &&
    bloqueo.evidencia.trim() !== '' &&
    typeof bloqueo.consultado === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(bloqueo.consultado) &&
    typeof bloqueo.robots === 'string' &&
    /^https:\/\/[^/\s]+\/robots\.txt$/.test(bloqueo.robots) &&
    Array.isArray(emisor.hosts) &&
    emisor.hosts.includes(hostDe(bloqueo.robots)) &&
    Array.isArray(bloqueo.agentes) &&
    bloqueo.agentes.length > 0 &&
    bloqueo.agentes.every((a) => typeof a === 'string' && a.trim() !== '');
  if (!forma) problemas.push(`${where}: bloqueo no tiene la forma esperada`);
  const recogida = emisor.recogida;
  if (!esObjeto(recogida) || recogida.metodo !== 'omitir' || Object.keys(recogida).some((k) => !['metodo', 'nota'].includes(k))) problemas.push(`${where}: con bloqueo, recogida debe ser omitir`);
  return problemas;
}

/**
 * Why the run's fuentes.json differs from the copy taken before it in a way
 * registrarBloqueos never makes, or [] when it does not. Allowed: on an
 * existing emisor that is not a party website, a new or changed `bloqueo` of tipo robots, with every field
 * of the site's shape, and recogida omitir (nothing else of it changed, no
 * bloqueo removed); new emisores at the end with
 * exactly id, nombre (= its host), hosts (one), tipo medio, recogida omitir
 * and bloqueo. Everything else of the file stays the same.
 */
export function cambiosFuentesNoAdmitidos(antes: unknown, despues: unknown): string[] {
  if (!esObjeto(antes) || !esObjeto(despues) || !Array.isArray(antes.emisores) || !Array.isArray(despues.emisores)) return ['fuentes.json: no es un objeto con la lista emisores'];
  const problemas: string[] = [];
  if (canonico(sin(antes, 'emisores')) !== canonico(sin(despues, 'emisores'))) problemas.push('fuentes.json: cambió algo fuera de emisores');
  const A = antes.emisores as unknown[];
  const D = despues.emisores as unknown[];
  if (D.length < A.length) return [...problemas, 'fuentes.json: se quitaron emisores'];
  A.forEach((a, i) => {
    const d = D[i];
    if (!esObjeto(a) || !esObjeto(d) || a.id !== d.id) {
      problemas.push(`fuentes.emisores[${i + 1}]: cambió de sitio o de id`);
      return;
    }
    const where = `fuentes.${String(a.id)}`;
    if (canonico(sin(a, 'bloqueo', 'recogida')) !== canonico(sin(d, 'bloqueo', 'recogida'))) problemas.push(`${where}: cambió algo más que bloqueo y recogida`);
    if (a.bloqueo !== undefined && d.bloqueo === undefined) problemas.push(`${where}: se quitó el bloqueo (nunca se quita solo)`);
    const cambiado = canonico(a.bloqueo) !== canonico(d.bloqueo) || canonico(a.recogida) !== canonico(d.recogida);
    if (cambiado && a.tipo === 'partido') problemas.push(`${where}: la web de un partido no cambia sola (bloqueo y recogida, a mano)`);
    else if (cambiado) problemas.push(...problemasBloqueo(where, d));
  });
  D.slice(A.length).forEach((d, j) => {
    const where = `fuentes.emisores[${A.length + j + 1}]`;
    if (!esObjeto(d)) return problemas.push(`${where}: no es un objeto`);
    const claves = Object.keys(d).sort().join(',');
    if (claves !== 'bloqueo,hosts,id,nombre,recogida,tipo') problemas.push(`${where}: un emisor nuevo solo lleva id, nombre, hosts, tipo, recogida y bloqueo`);
    const hosts = d.hosts;
    if (!Array.isArray(hosts) || hosts.length !== 1 || typeof hosts[0] !== 'string' || !HOST.test(hosts[0]) || d.nombre !== hosts[0]) problemas.push(`${where}: un emisor nuevo tiene un host y se llama como él`);
    if (typeof d.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(d.id)) problemas.push(`${where}: id no es un slug`);
    if (d.tipo !== 'medio') problemas.push(`${where}: un emisor nuevo es de tipo medio`);
    problemas.push(...problemasBloqueo(where, d));
  });
  return problemas;
}
