/**
 * Polite fetching for the daily collection.
 *
 * - Requests go through crearFetchSeguro: https only, never to an internal
 *   address (checked when resolving and again at connect time), no
 *   automatic redirects (each hop passes `comprobar`).
 * - One honest User-Agent, always the same. Never another one, a proxy or a
 *   headless browser.
 * - robots.txt is read once per host and respected (Allow/Disallow, longest
 *   match, `*` and `$`; Crawl-delay raises the per-host interval).
 * - At most one request every `intervaloMs` (5 s by default) per host.
 * - 401, 403, 429, 451, a challenge page or a geo-block: the host is recorded
 *   as `bloqueado` with the run date and no further request goes to it.
 * - Access per host comes from fuentes.json (`accesoDesdeRegistro` in
 *   descubrir.ts): a host whose pages block but whose listed method works
 *   (a party site's feed) is `soloListado`: only that URL is fetched, never its
 *   pages. A blocked host with no working method is `soloBuzon`: never fetched,
 *   inbox only (buzon.ts). Without a registry, psoe.es and voxespana.es are
 *   inbox-only by default. Hosts that block the guide (`noTraer`: emisores
 *   with a `bloqueo`, and SIN_AGENTES_CLAUDE_FIJOS) are never fetched,
 *   whatever points at them.
 * - Blocks the guide lists on /fuentes/ (`vetos`): a robots.txt that disallows
 *   the site root to Claude's agents (AGENTES_CLAUDE; that host is then not
 *   fetched either), and an anti-bot answer (403/429 or a challenge page with
 *   a known signature). Each with the date and its evidence.
 */
import dns from 'node:dns';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { dirname } from 'node:path';
import { guardar, textoDePdf, urlCanonica, type Guardado, type PartyId, type Via } from './cache.ts';
import { ORIGEN_ENLACES, textoDeHtml, type AvisoEnlace, type Enlace } from './buzon.ts';

export const USER_AGENT = '29n-transparencia-recogida/1.0 (+https://29n.jrquintana.dev/metodologia/)';
/** Product token matched against robots.txt groups. */
const TOKEN_ROBOTS = '29n-transparencia-recogida';

/** Inbox-only hosts when no registry-derived list is given. */
export const SOLO_BUZON_POR_DEFECTO = ['psoe.es', 'voxespana.es'];

export const INTERVALO_MS = 5000;
const MAX_REDIRECCIONES = 5;
const MAX_BYTES = 25 * 1024 * 1024;

export const hostDe = (url: string) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');

/** True when `host` is one of `hosts` or a subdomain of one. */
export const hostEn = (host: string, hosts: readonly string[]) => hosts.some((otro) => host === otro || host.endsWith(`.${otro}`));

/** Decodes a body with the charset of its content type (UTF-8 by default). */
export function decodificarCuerpo(tipo: string, cuerpo: Uint8Array): string {
  const charset = /charset=["']?([\w-]+)/i.exec(tipo)?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(cuerpo);
  } catch {
    return new TextDecoder().decode(cuerpo);
  }
}

/** Resolves a host to its addresses; injected in tests (and by the --seco fixed network). */
export type Resolver = (host: string) => Promise<string[]>;

/** Looked up at call time, so a fixed network can replace dns.promises.lookup. */
export const resolverReal: Resolver = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** Address ranges never requested: loopback, private, link-local, CGNAT, benchmarking, documentation, multicast, reserved, NAT64. */
const INTERNAS = (() => {
  const lista = new BlockList();
  for (const [red, prefijo] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) lista.addSubnet(red, prefijo, 'ipv4');
  for (const [red, prefijo] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) lista.addSubnet(red, prefijo, 'ipv6');
  return lista;
})();

/** The eight 16-bit groups of an IPv6 address (with an embedded dotted quad, if any), or undefined. */
export function gruposIPv6(direccion: string): number[] | undefined {
  if (isIP(direccion) !== 6) return undefined;
  let texto = direccion.toLowerCase();
  const cuadro = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(texto);
  if (cuadro) {
    const [a, b, c, d] = cuadro.slice(1).map(Number) as [number, number, number, number];
    texto = `${texto.slice(0, cuadro.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [izquierda, derecha] = texto.split('::') as [string, string | undefined];
  const parte = (t: string | undefined) => (t ? t.split(':').filter(Boolean).map((g) => parseInt(g, 16)) : []);
  const a = parte(izquierda);
  const b = parte(derecha);
  const grupos = derecha === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
  return grupos.length === 8 ? grupos : undefined;
}

/**
 * Whether an address must never be requested (IPv4 and IPv6). IPv4-mapped
 * (::ffff:a.b.c.d, also in hex) and IPv4-compatible (::a.b.c.d) addresses are
 * judged by their IPv4 address. Anything that is not an IP address counts as internal.
 */
export function direccionInterna(direccion: string): boolean {
  const ip = direccion.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (isIP(ip) === 4) return INTERNAS.check(ip, 'ipv4');
  const grupos = gruposIPv6(ip);
  if (!grupos) return true;
  if (grupos.slice(0, 5).every((g) => g === 0) && (grupos[5] === 0xffff || (grupos[5] === 0 && (grupos[6]! > 0 || grupos[7]! > 1)))) {
    const v4 = [grupos[6]! >> 8, grupos[6]! & 0xff, grupos[7]! >> 8, grupos[7]! & 0xff].join('.');
    return INTERNAS.check(v4, 'ipv4');
  }
  return INTERNAS.check(ip, 'ipv6');
}

/** Resolves with the system resolver and keeps only public addresses; injected in tests. */
export type ResolverDirecciones = (host: string) => Promise<{ address: string; family: number }[]>;
const resolverDirecciones: ResolverDirecciones = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * A `lookup` for node:https that resolves the host at connect time and drops
 * internal addresses, failing when none is left: what is checked is what is
 * connected to (no DNS rebinding between the check and the request).
 */
export function lookupPublico(resolver: ResolverDirecciones = resolverDirecciones) {
  return (host: string, opciones: { all?: boolean } | number | undefined, callback: (error: Error | null, direccion?: string | { address: string; family: number }[], familia?: number) => void) => {
    resolver(host).then(
      (direcciones) => {
        const publicas = direcciones.filter((d) => !direccionInterna(d.address));
        if (!publicas.length) return callback(Object.assign(new Error(`${host} solo resuelve a direcciones internas`), { code: 'ENOTFOUND' }));
        if (typeof opciones === 'object' && opciones?.all) return callback(null, publicas);
        callback(null, publicas[0]!.address, publicas[0]!.family);
      },
      (error: Error) => callback(error),
    );
  };
}

const TIEMPO_MAXIMO_MS = 60_000;

/**
 * The default fetch of Traedor: one GET with node:https, never following
 * redirects (Traedor checks each hop), connecting only to public addresses
 * (lookupPublico), with a time limit and a size cap. https only.
 */
export function crearFetchSeguro(resolver?: ResolverDirecciones): typeof fetch {
  const lookup = lookupPublico(resolver);
  return (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = new URL(entrada instanceof Request ? entrada.url : String(entrada));
    if (url.protocol !== 'https:') throw new TypeError(`solo https: ${url.protocol}`);
    const cabeceras: Record<string, string> = {};
    new Headers(init?.headers).forEach((valor, clave) => {
      cabeceras[clave] = valor;
    });
    return new Promise<Response>((resolver, rechazar) => {
      const peticion = https.request(url, { method: 'GET', headers: cabeceras, lookup: lookup as never, timeout: TIEMPO_MAXIMO_MS }, (respuesta) => {
        const trozos: Buffer[] = [];
        let total = 0;
        respuesta.on('data', (trozo: Buffer) => {
          total += trozo.length;
          if (total > MAX_BYTES) {
            respuesta.destroy(new Error(`respuesta de más de ${MAX_BYTES} bytes`));
            return;
          }
          trozos.push(trozo);
        });
        respuesta.on('error', rechazar);
        respuesta.on('end', () => {
          const estado = respuesta.statusCode ?? 0;
          const headers = new Headers();
          for (const [clave, valor] of Object.entries(respuesta.headers)) {
            for (const v of Array.isArray(valor) ? valor : valor === undefined ? [] : [valor]) headers.append(clave, v);
          }
          if (estado < 200 || estado > 599) return rechazar(new Error(`estado HTTP no admitido: ${estado}`));
          const cuerpo = [204, 205, 304].includes(estado) ? null : Buffer.concat(trozos);
          resolver(new Response(cuerpo, { status: estado, headers }));
        });
      });
      peticion.on('timeout', () => peticion.destroy(new Error(`sin respuesta en ${TIEMPO_MAXIMO_MS / 1000} s`)));
      peticion.on('error', rechazar);
      peticion.end();
    });
  }) as typeof fetch;
}

/** The fixed network of `diario.sh --seco` (fixtures/diario/red-fija.mjs) registers its fetch here. */
export const RED_FIJA = Symbol.for('29n-transparencia.red-fija');
const redFija = () => (globalThis as Record<symbol, unknown>)[RED_FIJA] as typeof fetch | undefined;

/** Why a host is never requested (IP literal, localhost, .local, single label), or undefined. */
export function motivoHostNoPublico(host: string): string | undefined {
  const limpio = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(limpio)) return `${host} es una dirección IP: solo se piden nombres de host públicos`;
  if (limpio === 'localhost' || limpio.endsWith('.localhost') || limpio.endsWith('.local') || limpio.endsWith('.internal') || !limpio.includes('.')) return `${host} no es un host público`;
  return undefined;
}

export interface Bloqueo {
  fecha: string;
  estado_http: number | null;
  motivo: string;
  url: string;
}

export type Respuesta =
  | { estado: 'ok'; url: string; url_final: string; estado_http: number; tipo: string; cuerpo: Uint8Array }
  | { estado: 'bloqueado'; url: string; bloqueo: Bloqueo }
  | { estado: 'robots' | 'solo-buzon' | 'error'; url: string; motivo: string; estado_http?: number };

export interface Opciones {
  /** Run date (ISO), written into every `bloqueado` record. */
  fecha: string;
  fetch?: typeof fetch;
  /** Waits; injected in tests. */
  esperar?: (ms: number) => Promise<void>;
  /** Monotonic clock in ms; injected in tests. */
  reloj?: () => number;
  intervaloMs?: number;
  /** Hosts already recorded as blocked (e.g. read from bloqueados.json). */
  bloqueados?: Record<string, Bloqueo>;
  /** Hosts never fetched (inbox only). Default: SOLO_BUZON_POR_DEFECTO. */
  soloBuzon?: readonly string[];
  /** Hosts whose pages block: only these URLs (their listing) may be fetched. */
  soloListado?: Readonly<Record<string, readonly string[]>>;
  /** Hosts never fetched: emisores with a bloqueo in fuentes.json, and the fixed list of bloqueos.ts. */
  noTraer?: readonly string[];
  /** DNS resolution, to refuse hosts that resolve to internal addresses. Default: resolverReal. */
  resolver?: Resolver;
}

interface Regla {
  permitir: boolean;
  patron: string;
}

interface Robots {
  reglas: Regla[];
  esperaMs: number;
}

interface GrupoRobots {
  /** User agents of the group, lowercase. */
  agentes: string[];
  /** The same, as written in the file. */
  escritos: string[];
  reglas: Regla[];
  espera?: number;
}

/** Groups of a robots.txt, in file order. */
function gruposRobots(texto: string): GrupoRobots[] {
  const grupos: GrupoRobots[] = [];
  let actual: (typeof grupos)[number] | undefined;
  let leyendoAgentes = false;
  for (const lineaCruda of texto.split(/\r?\n/)) {
    const linea = lineaCruda.replace(/#.*/, '').trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(linea);
    if (!match) continue;
    const campo = match[1]!.toLowerCase();
    const valor = match[2]!.trim();
    if (campo === 'user-agent') {
      if (!leyendoAgentes || !actual) {
        actual = { agentes: [], escritos: [], reglas: [] };
        grupos.push(actual);
      }
      // An empty value names no agent: the group still holds its rules, which then apply to nobody.
      if (valor) {
        actual.agentes.push(valor.toLowerCase());
        actual.escritos.push(valor);
      }
      leyendoAgentes = true;
      continue;
    }
    leyendoAgentes = false;
    if (!actual) continue;
    if (campo === 'allow' || campo === 'disallow') {
      if (valor) actual.reglas.push({ permitir: campo === 'allow', patron: valor });
    } else if (campo === 'crawl-delay') {
      const segundos = Number(valor);
      if (Number.isFinite(segundos) && segundos > 0) actual.espera = segundos * 1000;
    }
  }
  return grupos;
}

/**
 * The rules that apply to a product token (RFC 9309, 2.2.1): every group whose
 * user-agent equals the token, case-insensitively, merged in file order; only
 * when none names it, every `*` group, merged. `comodin` tells which.
 */
function grupoPara(grupos: GrupoRobots[], token: string): (GrupoRobots & { comodin: boolean }) | undefined {
  const fundir = (lista: GrupoRobots[], comodin: boolean) =>
    lista.length
      ? {
          agentes: lista.flatMap((g) => g.agentes),
          escritos: lista.flatMap((g) => g.escritos),
          reglas: lista.flatMap((g) => g.reglas),
          espera: lista.map((g) => g.espera).find((e) => e !== undefined),
          comodin,
        }
      : undefined;
  return fundir(grupos.filter((g) => g.agentes.includes(token.toLowerCase())), false) ?? fundir(grupos.filter((g) => g.agentes.includes('*')), true);
}

/** Parses robots.txt and keeps the group for our token, or else `*`. */
export function leerRobots(texto: string): Robots {
  const grupo = grupoPara(gruposRobots(texto), TOKEN_ROBOTS);
  return { reglas: grupo?.reglas ?? [], esperaMs: grupo?.espera ?? 0 };
}

/**
 * Anthropic's agents that read pages for a Claude session: Claude-User (a
 * fetch asked for by a user) and Claude-SearchBot (search). A site whose
 * robots.txt disallows its root to either is not read by Claude, nor fetched
 * by this pipeline. Checked against Anthropic's crawler documentation on
 * 13 Nov 2026.
 */
export const AGENTES_CLAUDE = ['Claude-User', 'Claude-SearchBot'] as const;

/**
 * Whether a robots.txt disallows the site root to Claude's agents
 * (AGENTES_CLAUDE, each by its own group or else `*`), with the evidence: the
 * Anthropic user agents of the deciding groups as written (`*` when a group
 * applies only as the default), the first deciding rule (with that group's
 * Anthropic agents), and the paths those groups still allow.
 */
export function vetoClaude(texto: string): { agentes: string[]; evidencia: string; permitido: string[] } | undefined {
  const grupos = gruposRobots(texto);
  const decisivos: { grupo: GrupoRobots & { comodin: boolean }; regla: Regla }[] = [];
  for (const token of AGENTES_CLAUDE) {
    const grupo = grupoPara(grupos, token);
    const regla = grupo && reglaDecisiva(grupo.reglas, '/');
    // A rule anchored with `$` (`Disallow: /$`) closes only the home page, not the site.
    if (grupo && regla && !regla.permitir && !regla.patron.endsWith('$')) decisivos.push({ grupo, regla });
  }
  if (!decisivos.length) return undefined;
  const anthropic = (g: GrupoRobots & { comodin: boolean }) => (g.comodin ? ['*'] : g.escritos.filter((a) => /claude|anthropic/i.test(a)));
  const agentes = [...new Set(decisivos.flatMap((d) => anthropic(d.grupo)))].map((a) => limpiarEvidencia(a, 100)).filter(Boolean);
  const permitidas = [...new Set(decisivos.flatMap((d) => d.grupo.reglas.filter((r) => r.permitir && r.patron.startsWith('/') && r.patron !== '/').map((r) => limpiarEvidencia(r.patron, 100))))].filter(Boolean);
  const primero = decisivos[0]!;
  return { agentes, evidencia: limpiarEvidencia(`User-agent: ${anthropic(primero.grupo).join(', ')} · Disallow: ${primero.regla.patron}`), permitido: permitidas };
}

/** Longest evidence text kept. */
export const MAX_EVIDENCIA = 300;

/**
 * Evidence text from a page or a robots.txt, safe to store and to show: no
 * control characters, no `<`, `>` or backticks (HTML and code spans), one
 * space between words, at most `maximo` characters (ending in «…»). Markdown
 * is escaped where it is shown (resumen.ts).
 */
export function limpiarEvidencia(texto: string, maximo = MAX_EVIDENCIA): string {
  const limpio = texto.replace(/[\u0000-\u001f\u007f-\u009f<>`]/g, ' ').replace(/\s+/g, ' ').trim();
  return limpio.length > maximo ? `${limpio.slice(0, maximo - 1).trimEnd()}…` : limpio;
}

/** A block the guide lists on /fuentes/: robots.txt against Claude's agents, or an anti-bot answer. */
export interface VetoGuia {
  tipo: 'robots' | 'antibots';
  host: string;
  /** Run date. */
  consultado: string;
  /** The URL whose request found it. */
  url: string;
  /** The rule line, or the status code and the anti-bot marker. */
  evidencia: string;
  /** robots: the robots.txt read, the agents it names and the paths it still allows. */
  robots?: string;
  agentes?: string[];
  permitido?: string[];
  /** antibots: the HTTP status. */
  estado_http?: number;
  /** antibots: no earlier record of a block of this host in bloqueados.json. */
  primera?: boolean;
}

function coincide(patron: string, ruta: string): boolean {
  const regex = patron
    .split('')
    .map((caracter, indice) => {
      if (caracter === '*') return '.*';
      if (caracter === '$' && indice === patron.length - 1) return '$';
      return caracter.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${regex}`).test(ruta);
}

/** Whether robots allows a path+query: the longest matching rule wins, Allow on ties. */
export function permitido(robots: Robots, rutaYConsulta: string): boolean {
  return reglaDecisiva(robots.reglas, rutaYConsulta)?.permitir ?? true;
}

/** The rule that decides a path: the longest matching one, Allow on ties; undefined when none matches. */
function reglaDecisiva(reglas: Regla[], rutaYConsulta: string): Regla | undefined {
  let mejor: Regla | undefined;
  for (const regla of reglas) {
    if (!coincide(regla.patron, rutaYConsulta)) continue;
    if (!mejor || regla.patron.length > mejor.patron.length || (regla.patron.length === mejor.patron.length && regla.permitir)) mejor = regla;
  }
  return mejor;
}

/** Markers of anti-bot challenge pages (Cloudflare, Incapsula, Akamai, DataDome, captchas). */
const RETOS = [
  /cf-chl|challenge-platform|cf_chl_opt/i,
  /<title>\s*(just a moment|attention required|un momento)/i,
  /_Incapsula_Resource|incapsula incident id/i,
  /captcha-delivery|datadome/i,
  /\bg-recaptcha\b|\bh-captcha\b|cf-turnstile/i,
  /<title>\s*access denied\s*<\/title>[\s\S]*reference\s*#/i,
];
/** Markers of a geo-block. */
const GEOBLOQUEO = [/not available in your (country|region)/i, /no est[aá] disponible en (tu|su) (pa[ií]s|regi[oó]n)/i, /geo[- ]?(block|restrict)/i];

/** Anti-bot signatures in headers and bodies, with the name the guide gives them. */
const FIRMAS_ANTIBOTS: { nombre: string; cabecera?: [string, RegExp]; cuerpo?: RegExp }[] = [
  { nombre: 'Cloudflare (cf-mitigated: challenge)', cabecera: ['cf-mitigated', /challenge/i] },
  { nombre: 'Cloudflare (página de reto)', cuerpo: /cf-chl|challenge-platform|cf_chl_opt|cf-turnstile|<title>\s*(just a moment|attention required|un momento)/i },
  { nombre: 'DataDome (cabecera x-datadome)', cabecera: ['x-datadome', /./] },
  { nombre: 'DataDome (página de reto)', cuerpo: /captcha-delivery|datadome/i },
  { nombre: 'Akamai (server: AkamaiGHost)', cabecera: ['server', /akamaighost/i] },
  { nombre: 'Akamai (página de acceso denegado)', cuerpo: /<title>\s*access denied\s*<\/title>[\s\S]*reference\s*#/i },
  { nombre: 'Imperva/Incapsula', cuerpo: /_Incapsula_Resource|incapsula incident id/i },
  { nombre: 'captcha (reCAPTCHA o hCaptcha)', cuerpo: /\bg-recaptcha\b|\bh-captcha\b/i },
  { nombre: 'página «no eres un robot»', cuerpo: /(confirm|verify|prove) (that )?you('| a)re (not a (ro)?bot|(a )?human)|are you a (ro)?bot|no (eres|soy) un robot|verifica(r)? que eres (humano|una persona)/i },
];

/**
 * The anti-bot signature of a blocking answer, or undefined: a 403 or 429
 * whose headers or body carry a known marker, or a challenge page with any
 * status. A bare 403 (no marker), a 401, a 451 or a geo-block is not one.
 */
export function firmaAntibots(estado: number, cabeceras: Pick<Headers, 'get'> | undefined, cuerpo: string): string | undefined {
  const inicio = cuerpo.slice(0, 200_000);
  for (const firma of FIRMAS_ANTIBOTS) {
    const porCabecera = firma.cabecera && cabeceras ? firma.cabecera[1].test(cabeceras.get(firma.cabecera[0]) ?? '') : false;
    const porCuerpo = firma.cuerpo ? firma.cuerpo.test(inicio) : false;
    if (!porCabecera && !porCuerpo) continue;
    if (estado === 403 || estado === 429 || porCuerpo) return firma.nombre;
  }
  return undefined;
}

/** Why a response is a block (status, challenge or geo-block), or undefined. */
export function motivoBloqueo(estado: number, cuerpo: string): string | undefined {
  if (estado === 401) return 'HTTP 401';
  if (estado === 403) return 'HTTP 403';
  if (estado === 429) return 'HTTP 429';
  if (estado === 451) return 'HTTP 451 (bloqueo legal o geográfico)';
  const inicio = cuerpo.slice(0, 200_000);
  if (RETOS.some((patron) => patron.test(inicio))) return `página de reto antibots (HTTP ${estado})`;
  if (GEOBLOQUEO.some((patron) => patron.test(inicio))) return `bloqueo geográfico (HTTP ${estado})`;
  return undefined;
}

/**
 * A fetcher with per-host state for one run. Not concurrent: call `traer`
 * sequentially (the CLI does), so the per-host interval holds.
 */
export class Traedor {
  readonly fecha: string;
  readonly bloqueados: Record<string, Bloqueo>;
  private readonly fetch: typeof fetch;
  private readonly esperar: (ms: number) => Promise<void>;
  private readonly reloj: () => number;
  private readonly intervaloMs: number;
  private readonly soloBuzon: readonly string[];
  private readonly soloListado: Readonly<Record<string, readonly string[]>>;
  private readonly noTraer: readonly string[];
  /** Blocks for the guide found by this fetcher, by host (the first one wins). */
  readonly vetos: Record<string, VetoGuia> = {};
  private readonly ultimo = new Map<string, number>();
  private readonly robots = new Map<string, Robots | 'bloqueado' | 'no-disponible'>();
  private readonly resolver: Resolver;
  private readonly resueltos = new Map<string, string | null>();
  /** Requests actually sent, in order (for logs and tests). */
  readonly peticiones: string[] = [];

  constructor(opciones: Opciones) {
    this.fecha = opciones.fecha;
    this.fetch = opciones.fetch ?? redFija() ?? crearFetchSeguro();
    this.esperar = opciones.esperar ?? ((ms) => new Promise((hecho) => setTimeout(hecho, ms)));
    this.reloj = opciones.reloj ?? (() => performance.now());
    this.intervaloMs = opciones.intervaloMs ?? INTERVALO_MS;
    this.bloqueados = { ...opciones.bloqueados };
    this.soloBuzon = opciones.soloBuzon ?? SOLO_BUZON_POR_DEFECTO;
    this.soloListado = opciones.soloListado ?? {};
    this.noTraer = opciones.noTraer ?? [];
    this.resolver = opciones.resolver ?? resolverReal;
  }

  /** Why a host may not be requested at all (not public, or resolving to an internal address), or undefined. Cached per host. */
  private async motivoRed(host: string): Promise<string | undefined> {
    if (this.resueltos.has(host)) return this.resueltos.get(host) ?? undefined;
    let motivo = motivoHostNoPublico(host);
    if (!motivo) {
      try {
        const direcciones = await this.resolver(host);
        if (!direcciones.length) motivo = `${host} no resuelve`;
        else if (direcciones.some(direccionInterna)) motivo = `${host} resuelve a una dirección interna`;
      } catch (error) {
        motivo = `${host} no resuelve: ${(error as Error).message}`;
      }
    }
    this.resueltos.set(host, motivo ?? null);
    return motivo;
  }

  /**
   * The checks every request passes before it is sent: https only, a public
   * host that resolves to public addresses, not inbox-only, the host's listing
   * only, not blocked, and allowed by robots.txt. undefined when the URL may be
   * requested. Used on every redirect hop, and by transcribir before yt-dlp.
   */
  async comprobar(url: string): Promise<Exclude<Respuesta, { estado: 'ok' }> | undefined> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { estado: 'error', url, motivo: `URL no válida: ${url}` };
    }
    if (parsed.protocol !== 'https:') return { estado: 'error', url, motivo: `solo https: ${parsed.protocol}` };
    if (parsed.username || parsed.password) return { estado: 'error', url, motivo: 'URL con credenciales' };
    const host = hostDe(url);
    const red = await this.motivoRed(parsed.hostname);
    if (red) return { estado: 'error', url, motivo: red };
    if (hostEn(host, this.noTraer)) return { estado: 'solo-buzon', url, motivo: `${host} bloquea a la guía (bloqueo en fuentes.json o robots.txt contra los agentes de Claude): no se trae (solo el buzón)` };
    if (hostEn(host, this.soloBuzon)) return { estado: 'solo-buzon', url, motivo: `${host} bloquea a clientes automatizados: solo por el buzón` };
    const listados = Object.entries(this.soloListado).find(([otro]) => hostEn(host, [otro]))?.[1];
    if (listados && !listados.some((permitida) => urlCanonica(permitida) === urlCanonica(url))) {
      return { estado: 'solo-buzon', url, motivo: `las páginas de ${host} bloquean a clientes automatizados: solo su listado o el buzón` };
    }
    const previo = this.bloqueados[host];
    if (previo) return { estado: 'bloqueado', url, bloqueo: previo };
    const robots = await this.robotsDe(parsed, host);
    if (robots === 'bloqueado') return { estado: 'bloqueado', url, bloqueo: this.bloqueados[host]! };
    if (robots === 'no-disponible') return { estado: 'robots', url, motivo: `robots.txt de ${host} no disponible: no se pide nada a este host` };
    const veto = this.vetos[host];
    if (veto?.tipo === 'robots') return { estado: 'robots', url, motivo: `robots.txt de ${host} no admite agentes de Claude (${veto.evidencia}): no se trae` };
    if (!permitido(robots, parsed.pathname + parsed.search)) return { estado: 'robots', url, motivo: `robots.txt de ${host} no permite ${parsed.pathname}` };
    return undefined;
  }

  /** Waits for the host's slot and sends one GET with the honest User-Agent. */
  private async pedir(url: string, host: string, aceptar: string): Promise<Response> {
    const robots = this.robots.get(host);
    const espera = Math.max(this.intervaloMs, typeof robots === 'object' ? robots.esperaMs : 0);
    const ultimo = this.ultimo.get(host);
    if (ultimo !== undefined) {
      const falta = ultimo + espera - this.reloj();
      if (falta > 0) await this.esperar(falta);
    }
    this.ultimo.set(host, this.reloj());
    this.peticiones.push(url);
    return this.fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: aceptar }, redirect: 'manual' });
  }

  private bloquear(host: string, url: string, estado: number | null, motivo: string, firma?: string): Respuesta {
    const bloqueo: Bloqueo = { fecha: this.fecha, estado_http: estado, motivo, url };
    this.bloqueados[host] = bloqueo;
    if (firma && estado !== null) this.vetos[host] ??= { tipo: 'antibots', host, consultado: this.fecha, url, evidencia: limpiarEvidencia(`HTTP ${estado}: ${firma}`), estado_http: estado };
    return { estado: 'bloqueado', url, bloqueo };
  }

  private async robotsDe(origen: URL, host: string): Promise<Robots | 'bloqueado' | 'no-disponible'> {
    const guardado = this.robots.get(host);
    if (guardado) return guardado;
    const url = `${origen.protocol}//${origen.host}/robots.txt`;
    const pedida = origen.toString();
    let resultado: Robots | 'bloqueado' | 'no-disponible';
    try {
      const respuesta = await this.pedir(url, host, 'text/plain');
      const texto = await respuesta.text();
      const motivo = motivoBloqueo(respuesta.status, texto);
      if (motivo) {
        this.bloquear(host, url, respuesta.status, `robots.txt: ${motivo}`, firmaAntibots(respuesta.status, respuesta.headers, texto));
        resultado = 'bloqueado';
      } else if (respuesta.status >= 500) resultado = 'no-disponible';
      else if (respuesta.status >= 400) resultado = { reglas: [], esperaMs: 0 };
      else {
        resultado = leerRobots(texto);
        const veto = vetoClaude(texto);
        if (veto) {
          this.vetos[host] ??= {
            tipo: 'robots',
            host,
            consultado: this.fecha,
            url: pedida,
            evidencia: veto.evidencia,
            robots: url,
            agentes: veto.agentes,
            ...(veto.permitido.length ? { permitido: veto.permitido } : {}),
          };
        }
      }
    } catch {
      resultado = 'no-disponible';
    }
    this.robots.set(host, resultado);
    return resultado;
  }

  /** Why a host blocks the guide (noTraer, or a robots.txt veto found by this fetcher), or undefined. */
  vetado(host: string): string | undefined {
    const limpio = host.toLowerCase().replace(/^www\./, '');
    if (hostEn(limpio, this.noTraer)) return `${limpio} bloquea a la guía (bloqueo en fuentes.json o robots.txt contra los agentes de Claude)`;
    const veto = Object.values(this.vetos).find((v) => v.tipo === 'robots' && hostEn(limpio, [v.host]));
    return veto ? `robots.txt de ${veto.host} no admite agentes de Claude (${veto.evidencia})` : undefined;
  }

  /**
   * The text of one robots.txt, to see whether a recorded bloqueo still holds.
   * robots.txt is read even on hosts never fetched (noTraer, inbox only), but
   * with every network check of comprobar (https, a public host resolving to
   * public addresses), the per-host interval and no redirects. undefined when
   * it could not be read.
   */
  async textoRobots(url: string): Promise<string | undefined> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/robots.txt' || parsed.search) return undefined;
    if (await this.motivoRed(parsed.hostname)) return undefined;
    try {
      const respuesta = await this.pedir(url, hostDe(url), 'text/plain');
      if (respuesta.status !== 200) return undefined;
      return await respuesta.text();
    } catch {
      return undefined;
    }
  }

  /** Fetches one URL, following up to 5 redirects through the same checks. */
  async traer(url: string, aceptar = 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5'): Promise<Respuesta> {
    let actual = url;
    for (let salto = 0; salto <= MAX_REDIRECCIONES; salto++) {
      const veto = await this.comprobar(actual);
      if (veto) return { ...veto, url } as Respuesta;
      const host = hostDe(actual);

      let respuesta: Response;
      try {
        respuesta = await this.pedir(actual, host, aceptar);
      } catch (error) {
        return { estado: 'error', url, motivo: `fallo de red: ${(error as Error).message}` };
      }
      if (respuesta.status >= 300 && respuesta.status < 400 && respuesta.headers.get('location')) {
        actual = new URL(respuesta.headers.get('location')!, actual).toString();
        continue;
      }
      const cuerpo = new Uint8Array(await respuesta.arrayBuffer());
      if (cuerpo.byteLength > MAX_BYTES) return { estado: 'error', url, motivo: `respuesta demasiado grande (${cuerpo.byteLength} bytes)` };
      const tipo = (respuesta.headers.get('content-type') ?? '').toLowerCase();
      const comoTexto = tipo.includes('pdf') ? '' : decodificarCuerpo(tipo, cuerpo.slice(0, 200_000));
      const motivo = motivoBloqueo(respuesta.status, comoTexto);
      if (motivo) return this.bloquear(host, actual, respuesta.status, motivo, firmaAntibots(respuesta.status, respuesta.headers, comoTexto));
      if (respuesta.status >= 400) return { estado: 'error', url, motivo: `HTTP ${respuesta.status}`, estado_http: respuesta.status };
      return { estado: 'ok', url, url_final: actual, estado_http: respuesta.status, tipo, cuerpo };
    }
    return { estado: 'error', url, motivo: 'demasiadas redirecciones' };
  }
}

/** Extension and plain text of a fetched body, by content type (PDF via pdfjs-dist). */
export async function extraer(tipo: string, cuerpo: Uint8Array): Promise<{ ext: string; texto: string; raw: string | Uint8Array }> {
  if (tipo.includes('pdf')) return { ext: 'pdf', texto: await textoDePdf(cuerpo), raw: cuerpo };
  const texto = decodificarCuerpo(tipo, cuerpo);
  if (tipo.includes('html')) return { ext: 'html', texto: textoDeHtml(texto), raw: texto };
  if (tipo.includes('json')) return { ext: 'json', texto, raw: texto };
  if (tipo.includes('xml')) return { ext: 'xml', texto, raw: texto };
  return { ext: 'txt', texto, raw: texto };
}

/** Fetches one URL and stores it in the cache; returns the fetch result and, when ok, what was stored. */
export async function traerYGuardar(traedor: Traedor, raizCache: string, url: string, via: Via = 'web', extra?: Record<string, unknown>): Promise<{ respuesta: Respuesta; guardado?: Guardado }> {
  const respuesta = await traedor.traer(url);
  if (respuesta.estado !== 'ok') return { respuesta };
  const { ext, texto, raw } = await extraer(respuesta.tipo, respuesta.cuerpo);
  const guardado = await guardar(raizCache, {
    url: respuesta.url_final,
    url_canonica: urlCanonica(respuesta.url_final),
    consultado: traedor.fecha,
    via,
    estado_http: respuesta.estado_http,
    raw,
    ext,
    texto,
    extra,
  });
  return { respuesta, guardado };
}

/** bloqueados.json in the cache: host → last block. Read at start, written at the end of a run. */
export async function leerBloqueados(ruta: string): Promise<Record<string, Bloqueo>> {
  try {
    return JSON.parse(await readFile(ruta, 'utf8')) as Record<string, Bloqueo>;
  } catch {
    return {};
  }
}

export async function escribirBloqueados(ruta: string, bloqueados: Record<string, Bloqueo>): Promise<void> {
  const ordenado = Object.fromEntries(Object.keys(bloqueados).sort().map((host) => [host, bloqueados[host]]));
  await mkdir(dirname(ruta), { recursive: true });
  await writeFile(ruta, `${JSON.stringify(ordenado, null, 2)}\n`);
}

/**
 * Adds a stage's vetos to the run's bloqueos-guia.json (host → VetoGuia; a
 * host already there keeps its first record). An anti-bot veto is `primera`
 * when bloqueados.json had no block of that host before the stage.
 */
export async function guardarVetos(ruta: string, vetos: Record<string, VetoGuia>, anteriores: Record<string, Bloqueo>): Promise<void> {
  const nuevos = Object.entries(vetos);
  if (!nuevos.length) return;
  let todos: Record<string, VetoGuia> = {};
  try {
    todos = JSON.parse(await readFile(ruta, 'utf8')) as Record<string, VetoGuia>;
  } catch {
    todos = {};
  }
  for (const [host, veto] of nuevos) {
    if (todos[host]) continue;
    todos[host] = veto.tipo === 'antibots' ? { ...veto, primera: !anteriores[host] } : veto;
  }
  const ordenado = Object.fromEntries(Object.keys(todos).sort().map((host) => [host, todos[host]]));
  await mkdir(dirname(ruta), { recursive: true });
  await writeFile(ruta, `${JSON.stringify(ordenado, null, 2)}\n`);
}

/** The run's bloqueos-guia.json (host → VetoGuia), or {} when there is none yet. */
export async function leerVetos(ruta: string): Promise<Record<string, VetoGuia>> {
  try {
    return JSON.parse(await readFile(ruta, 'utf8')) as Record<string, VetoGuia>;
  } catch {
    return {};
  }
}

/** Hosts of the day's robots.txt vetos: later stages never fetch them (noTraer), without reading their robots.txt again. */
export const hostsVetadosRobots = (vetos: Record<string, VetoGuia>) =>
  Object.values(vetos)
    .filter((v) => v.tipo === 'robots')
    .map((v) => v.host)
    .sort();

/** Blocks recorded on the run date only: an older block is retried once on a new day, with the same User-Agent. */
export const bloqueosDelDia = (bloqueados: Record<string, Bloqueo>, fecha: string) =>
  Object.fromEntries(Object.entries(bloqueados).filter(([, bloqueo]) => bloqueo.fecha === fecha));

/**
 * Stores a feed item's own text (content:encoded or description) for a host
 * whose pages block: the page itself is never requested. via 'rss'.
 */
export async function guardarDesdeFeed(raizCache: string, fecha: string, item: { url: string; contenido: string; listado: string; extra?: Record<string, unknown> }): Promise<Guardado> {
  return guardar(raizCache, {
    url: item.url,
    url_canonica: urlCanonica(item.url),
    consultado: fecha,
    via: 'rss',
    estado_http: null,
    raw: item.contenido,
    ext: 'html',
    texto: textoDeHtml(item.contenido),
    extra: { listado: item.listado, ...item.extra },
  });
}

export interface ResultadoEnlace {
  linea: number;
  url: string;
  partido?: PartyId;
  /** The fetch result: ok, bloqueado, robots, solo-buzon or error. */
  estado: string;
  id?: string;
  url_canonica?: string;
  /** nuevo, version or sin-cambios (already cached with the same content: not new today, so not classified again). */
  cache?: Guardado['estado'];
  motivo?: string;
}

/**
 * Fetches each link through the same Traedor and cache as every discovered
 * article (https, public address at connect, robots.txt, blocked and
 * inbox-only hosts, redirects, size limits), with no date window. Stored with
 * via 'web' and `origen: buzon-enlaces`; the owner's party note stays in
 * enlaces.json only, never in the cached meta.json that classifiers and
 * adjudicators read. A link not fetched becomes an aviso.
 */
export async function traerEnlaces(traedor: Traedor, raizCache: string, lista: { enlaces: Enlace[]; avisos: AvisoEnlace[] }): Promise<{ enlaces: ResultadoEnlace[]; avisos: AvisoEnlace[] }> {
  const avisos = [...lista.avisos];
  const enlaces: ResultadoEnlace[] = [];
  for (const enlace of lista.enlaces) {
    const { respuesta, guardado } = await traerYGuardar(traedor, raizCache, enlace.url, 'web', { origen: ORIGEN_ENLACES });
    const motivo = respuesta.estado === 'bloqueado' ? respuesta.bloqueo.motivo : 'motivo' in respuesta ? respuesta.motivo : undefined;
    enlaces.push({
      ...enlace,
      estado: respuesta.estado,
      ...(guardado ? { id: guardado.id, url_canonica: guardado.meta.url_canonica, cache: guardado.estado } : {}),
      ...(motivo ? { motivo } : {}),
    });
    if (respuesta.estado !== 'ok') avisos.push({ linea: enlace.linea, texto: enlace.url, motivo: `no se trajo (${respuesta.estado}${motivo ? `: ${motivo}` : ''})` });
    else if (guardado?.estado === 'sin-cambios' && guardado.meta.consultado !== traedor.fecha) {
      avisos.push({ linea: enlace.linea, texto: enlace.url, motivo: `ya estaba en la caché sin cambios desde el ${guardado.meta.consultado}: no es nuevo hoy` });
    }
  }
  avisos.sort((a, b) => a.linea - b.linea);
  return { enlaces, avisos };
}
