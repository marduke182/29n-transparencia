import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { idDocumento, urlCanonica, type PartyId } from './cache.ts';
import { Traedor } from './traer.ts';
import type { Alias, Descubrimiento } from './descubrir.ts';
import {
  ajustesClaude,
  bloque,
  ESCRITURA_POR_PASADA,
  dominiosDistintos,
  estadoSalida,
  marcarBloqueadas,
  sondear,
  urlsPermitidas,
  urlsSondeo,
  type EquidadDia,
  candidatosDeBusqueda,
  consultaPara,
  entradasDelDia,
  idDiario,
  igualarCorte,
  informe,
  partidosEn,
  plantillaDe,
  preparar,
  problemasAdjudicacion,
  prompts,
  promover,
  reglaEncuestas,
  salidaCompleta,
  sustituir,
  tareasClasificar,
  tareasEquidad,
  videosDelDia,
  type Busqueda,
} from './diario.ts';

const PARTIDOS: PartyId[] = ['frente-amplio', 'podemos', 'pp', 'psoe', 'vox'];
const FECHA = '2026-11-10';

const run = (id: string, tipo: string, fecha: string, plantilla = '{partido} critica a {termino}'): Busqueda => ({
  id,
  tipo,
  fecha,
  periodo: { desde: '2026-10-05', hasta: fecha },
  consultas: [{ plantilla, motor: 'WebSearch', dominios: ['medio.es'], terminos: { 'frente-amplio': 'Colau', podemos: 'Belarra', pp: 'Feijóo', psoe: 'Sánchez', vox: 'Abascal' } }],
  resultados: { 'frente-amplio': 1, podemos: 1, pp: 1, psoe: 1, vox: 1 },
});

describe('equal searches', () => {
  const registro = [run('equidad-2026-11-08-criticos', 'criticos', '2026-11-08', 'viejo {partido}'), run('equidad-2026-11-09-criticos', 'criticos', '2026-11-09')];

  it('takes the latest run of each kind as the template, never the day being built', () => {
    expect(plantillaDe(registro, 'criticos', FECHA)?.id).toBe('equidad-2026-11-09-criticos');
    expect(plantillaDe([...registro, run(idDiario(FECHA, 'criticos'), 'criticos', FECHA, 'otra {partido}')], 'criticos', FECHA)?.id).toBe('equidad-2026-11-09-criticos');
    expect(plantillaDe(registro, 'bulos', FECHA)).toBeUndefined();
  });

  it('builds one task per kind and party, identical except for the party', () => {
    const tareas = tareasEquidad(registro, FECHA, '2026-11-08');
    expect(tareas.map((t) => t.partido)).toEqual(PARTIDOS);
    expect(tareas.map((t) => t.consultas[0]!.texto)).toEqual(['Frente Amplio critica a Colau', 'Podemos critica a Belarra', 'PP critica a Feijóo', 'PSOE critica a Sánchez', 'Vox critica a Abascal']);
    expect(new Set(tareas.map((t) => JSON.stringify({ ...t, partido: '', nombre: '', salida: '', consultas: t.consultas.map((c) => ({ ...c, texto: '' })) }))).size).toBe(1);
    expect(tareas[0]).toMatchObject({ busqueda: 'diario-2026-11-10-criticos', periodo: { desde: '2026-11-08', hasta: FECHA }, salida: 'equidad/criticos.frente-amplio.json' });
  });

  it('fills the placeholders like the site', () => {
    expect(consultaPara({ plantilla: '{partido}  bulo {termino}', motor: 'WebSearch', dominios: [] }, 'pp')).toBe('PP bulo');
  });

  it('writes the day entry with the template queries, counts per party and why a search did not complete', () => {
    const equidad = {
      urls: { criticos: { 'frente-amplio': ['https://a.es/1'], podemos: [], pp: ['https://a.es/2', 'https://a.es/3'], psoe: [] } },
      estados: { criticos: { 'frente-amplio': 'completa', podemos: 'completa', pp: 'completa', psoe: 'incompleta' } },
      notas: { criticos: { pp: 'Un dominio tardó.' } },
      bloqueadas: {},
    } as EquidadDia;
    const [entrada] = entradasDelDia({ fecha: FECHA, desde: '2026-11-08', registro, equidad });
    expect(entrada).toMatchObject({
      id: 'diario-2026-11-10-criticos',
      periodo: { desde: '2026-11-08', hasta: FECHA },
      resultados: { 'frente-amplio': 1, podemos: 0, pp: 2, psoe: 0, vox: 0 },
      notas: { pp: 'Un dominio tardó.', psoe: expect.stringMatching(/quedó incompleta/), vox: 'La búsqueda no devolvió salida para este partido.' },
    });
    expect(entrada!.consultas).toEqual(registro[1]!.consultas);
    expect(entrada!.nota).toMatch(/Sin salida completa para: psoe, vox/);
    expect(entradasDelDia({ fecha: FECHA, desde: FECHA, registro: [...registro, entrada!], equidad: { urls: {}, estados: {}, notas: {}, bloqueadas: {} } })).toEqual([]);
  });
});

describe('videosDelDia', () => {
  it('keeps video debate pages and inbox lines, deduplicated and sorted', () => {
    const descubierto = {
      candidatos: [
        { url: 'https://www.rtve.es/play/videos/debate/x/123/', url_canonica: 'https://rtve.es/play/videos/debate/x/123', genero: 'debate' },
        { url: 'https://www.rtve.es/noticias/20261109/debate/1.shtml', url_canonica: 'https://rtve.es/noticias/20261109/debate/1.shtml', genero: 'debate' },
        { url: 'https://www.youtube.com/watch?v=aaaaaa', url_canonica: 'https://youtube.com/watch?v=aaaaaa', genero: 'articulo' },
      ],
    } as unknown as Descubrimiento;
    const buzon = [
      '# comentario',
      'https://www.youtube.com/watch?v=bbbbbb https://partido.es/transcripcion.pdf',
      'no-es-url',
      'http://www.youtube.com/watch?v=c',
      'https://youtube.com.otro.es/watch?v=d',
      'https://otro.es/play/videos/x/1/',
      'https://www.youtube.com/watch?v=eeeeee http://partido.es/inseguro.pdf',
      'https://youtu.be/-- --exec',
    ].join('\n');
    expect(videosDelDia(descubierto, buzon)).toEqual([
      { video: 'https://www.rtve.es/play/videos/debate/x/123/' },
      { video: 'https://www.youtube.com/watch?v=bbbbbb', oficial: 'https://partido.es/transcripcion.pdf' },
      { video: 'https://www.youtube.com/watch?v=eeeeee' },
    ]);
  });
});

describe('candidatosDeBusqueda', () => {
  it('keeps per-source results on that source only, equal-search results anywhere, and skips listed URLs', () => {
    const descubierto = {
      fecha: FECHA,
      desde: '2026-11-08',
      candidatos: [{ url: 'https://medio.es/ya', url_canonica: 'https://medio.es/ya' }],
      tareas_busqueda: [{ emisor: 'medio', nombre: 'Medio', hosts: ['medio.es'], consultas: [], desde: '2026-11-08', hasta: FECHA }],
      omitidos: [],
      solo_buzon: [],
      fallos: [],
      bloqueados: {},
    } as unknown as Descubrimiento;
    const resultado = candidatosDeBusqueda({
      fecha: FECHA,
      descubierto,
      porFuente: [
        { archivo: 'medio.json', salida: { emisor: 'medio', candidatos: [{ url: 'https://www.medio.es/b?utm_source=x', titulo: 'B', fecha: '2026-11-09' }, { url: 'https://otro.es/c' }, { url: 'https://medio.es/ya' }] } },
        { archivo: 'fantasma.json', salida: { emisor: 'fantasma', candidatos: [{ url: 'https://fantasma.es/x' }] } },
      ],
      porEquidad: [{ archivo: 'criticos.pp.json', salida: { busqueda: 'diario-2026-11-10-criticos', resultados: [{ url: 'https://otro.es/c' }, { url: 'http://inseguro.es/x' }] } }],
      emisores: [{ id: 'otro', nombre: 'Otro', hosts: ['otro.es'], tipo: 'medio' }],
    });
    expect(resultado.candidatos.map((c) => [c.emisor, c.url_canonica, c.listado])).toEqual([
      ['medio', 'https://medio.es/b', 'busqueda:medio'],
      ['otro', 'https://otro.es/c', 'busqueda:diario-2026-11-10-criticos'],
    ]);
    expect(resultado.fallos).toEqual([{ emisor: 'fantasma', listado: 'busqueda:fantasma.json', motivo: 'emisor sin tarea de búsqueda hoy' }]);
  });
});

describe('classification tasks', () => {
  const alias = (nombres: string[], personas: string[] = [], excluir: string[] = []): Alias => ({ nombres, marcas_regionales: [], miembros: [], personas, excluir });
  const todos: Partial<Record<PartyId, Alias>> = { pp: alias(['PP', 'Partido Popular'], ['Alberto Núñez Feijóo']), vox: alias(['Vox'], [], ['vox populi']), psoe: alias(['PSOE']) };

  it('matches aliases as whole words, without accents, after removing excluded phrases', () => {
    expect(partidosEn('Alberto Nuñez FEIJOO habló', todos)).toEqual(['pp']);
    expect(partidosEn('Es vox populi que el PSOE…', todos)).toEqual(['psoe']);
    expect(partidosEn('Un apps nuevo', todos)).toEqual([]);
  });

  it('creates one task per new document and party, plus the equal-search results', () => {
    const url = 'https://medio.es/viejo';
    const documentos = [
      { id: 'b', meta: { url: 'https://medio.es/b', url_canonica: 'https://medio.es/b', consultado: FECHA, via: 'web' as const, sha256_contenido: '', estado_http: 200 }, texto: 'El PP y Vox.' },
      { id: 'a', meta: { url: 'https://medio.es/a', url_canonica: 'https://medio.es/a', consultado: '2026-11-01', via: 'web' as const, sha256_contenido: '', estado_http: 200 }, texto: 'El PSOE.' },
      { id: idDocumento(urlCanonica(url)), meta: { url, url_canonica: url, consultado: '2026-11-01', via: 'web' as const, sha256_contenido: '', estado_http: 200 }, texto: 'Nada.' },
    ];
    const tareas = tareasClasificar({ fecha: FECHA, raizCache: '/cache', documentos, alias: todos, porEquidad: [{ salida: { busqueda: 'diario-2026-11-10-criticos', partido: 'podemos', resultados: [{ url }] } }] });
    expect(tareas.map((t) => [t.doc_id, t.partido, t.origen])).toEqual([
      [idDocumento(urlCanonica(url)), 'podemos', ['diario-2026-11-10-criticos']],
      ['b', 'pp', ['alias']],
      ['b', 'vox', ['alias']],
    ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
    expect(tareas.find((t) => t.doc_id === 'b')).toMatchObject({ texto: '/cache/docs/b/texto.txt', salida: 'clasificacion/b.pp.json' });
  });
});

describe('preparar', () => {
  const item = (texto: string, url: string, extra: Record<string, unknown> = {}) => ({ texto, estado: 'PARCIAL', matiz: 'Según el relato de Medio.', fuentes: [{ url, medio: 'Medio' }], ...extra });
  const equidadCompleta = { criticos: Object.fromEntries(PARTIDOS.map((p) => [p, p === 'pp' ? ['https://medio.es/critica'] : []])) };

  it('keeps own-party proposals and drops other parties, adjudicator hechos and unsearched critics', () => {
    const { porPartido, descartes } = preparar({
      fecha: FECHA,
      equidad: equidadCompleta,
      hechos: undefined,
      adjudicados: [
        {
          archivo: 'pp.json',
          contenido: {
            partido: 'pp',
            propuestas: [
              { partido: 'pp', seccion: 'temas', item: item('Propone algo.', 'https://medio.es/t') },
              { partido: 'vox', seccion: 'temas', item: item('Otro.', 'https://medio.es/o') },
              { partido: 'pp', seccion: 'temas', item: item('Debate.', 'https://medio.es/d', { hecho: 'debate' }) },
              { partido: 'pp', seccion: 'criticos-defensores', item: item('X critica.', 'https://www.medio.es/critica', { postura: 'critico', busqueda: 'diario-2026-11-10-criticos' }) },
              { partido: 'pp', seccion: 'criticos-defensores', item: item('Y critica.', 'https://medio.es/no-buscada', { postura: 'critico', busqueda: 'diario-2026-11-10-criticos' }) },
              { partido: 'pp', seccion: 'criticos-defensores', item: item('Z critica.', 'https://medio.es/critica', { postura: 'critico', busqueda: 'equidad-2026-11-10-criticos' }) },
              { partido: 'pp', seccion: 'temas', item: item('Con búsqueda.', 'https://medio.es/b', { busqueda: 'diario-2026-11-10-criticos' }) },
            ],
          },
        },
        { archivo: 'nadie.json', contenido: [{ partido: 'nadie', seccion: 'temas', item: {} }] },
      ],
    });
    expect(porPartido.pp.map((p) => [(p.item as { texto: string }).texto, p.en_espera])).toEqual([
      ['Propone algo.', undefined],
      ['X critica.', true],
    ]);
    expect(PARTIDOS.filter((p) => p !== 'pp').every((p) => porPartido[p].length === 0)).toBe(true);
    expect(descartes.map((d) => `${d.archivo}#${d.indice}`)).toEqual(['nadie.json#0', 'pp.json#1', 'pp.json#2', 'pp.json#4', 'pp.json#5', 'pp.json#6']);
  });

  it('drops a kind whose equal search lacks a party, and polls during the ban', () => {
    const { porPartido, descartes } = preparar({
      fecha: '2026-11-24',
      equidad: { criticos: { pp: ['https://medio.es/critica'] } },
      hechos: undefined,
      adjudicados: [
        {
          archivo: 'pp.json',
          contenido: [
            { partido: 'pp', seccion: 'criticos-defensores', item: item('X critica.', 'https://medio.es/critica', { postura: 'critico', busqueda: 'diario-2026-11-24-criticos' }) },
            { partido: 'pp', seccion: 'encuestas', item: item('Encuesta.', 'https://medio.es/e') },
          ],
        },
      ],
    });
    expect(porPartido.pp).toEqual([]);
    expect(descartes.map((d) => d.motivo)).toEqual([expect.stringMatching(/no tiene salida para los cinco/), expect.stringMatching(/veda/)]);
  });

  it('copies each shared fact identically to every party it names', () => {
    const hecho = { hecho: 'debate-rtve-2026-11-09', seccion: 'candidatura', partidos: ['psoe', 'pp', 'pp'], item: item('Debate a dos.', 'https://rtve.es/d') };
    const { porPartido, deHechos, descartes } = preparar({ fecha: FECHA, equidad: {}, adjudicados: [], hechos: { hechos: [hecho, { ...hecho }, { hecho: 'solo', seccion: 'temas', partidos: ['pp'], item: item('Uno.', 'https://a.es/x') }] } });
    expect(deHechos).toBe(2);
    expect(porPartido.pp[0]).toEqual({ partido: 'pp', seccion: 'candidatura', item: { ...hecho.item, hecho: 'debate-rtve-2026-11-09' } });
    expect(porPartido.psoe[0]!.item).toEqual(porPartido.pp[0]!.item);
    expect(descartes.map((d) => d.motivo)).toEqual([expect.stringMatching(/repetido/), expect.stringMatching(/al menos dos/)]);
  });
});

describe('ajustar', () => {
  const ficha = (publicados: string[], retenidos: [string, string][] = [], corte = '2026-11-09') => ({
    corte,
    secciones: [{ id: 'criticos-defensores', items: publicados.map((postura, i) => ({ ref: `N${i + 1}`, postura })) }],
    ...(retenidos.length ? { en_espera: retenidos.map(([ref, postura]) => ({ ref, postura, seccion: 'criticos-defensores' })) } : {}),
  });

  it('promotes held critics and defenders up to the smallest total, oldest ref first', () => {
    const fichas = {
      'frente-amplio': ficha(['critico'], [['12', 'critico']]),
      podemos: ficha(['critico'], [['9', 'critico'], ['10', 'defensor']]),
      pp: ficha(['critico'], [['103', 'critico'], ['12', 'critico']]),
      psoe: ficha(['critico'], [['5', 'critico']]),
      vox: ficha(['critico'], [['7', 'critico']]),
    } as never;
    const { promovidos, n } = promover(fichas);
    expect(n).toEqual({ critico: 2, defensor: 0 });
    expect(promovidos.map((p) => `${p.partido}:${p.ref}`)).toEqual(['frente-amplio:12', 'podemos:9', 'pp:12', 'psoe:5', 'vox:7']);
    const pp = (fichas as Record<string, ReturnType<typeof ficha>>).pp!;
    expect(pp.secciones[0]!.items.at(-1)).toEqual({ ref: '12', postura: 'critico' });
    expect(pp.en_espera).toEqual([{ ref: '103', postura: 'critico', seccion: 'criticos-defensores' }]);
    expect('en_espera' in (fichas as Record<string, object>).vox!).toBe(false);
  });

  it('moves corte in all five only when a party file changed', () => {
    const fichas = Object.fromEntries(PARTIDOS.map((p) => [p, ficha([])])) as never;
    const antes = Object.fromEntries(PARTIDOS.map((p) => [p, JSON.stringify(ficha([]))])) as never;
    expect(igualarCorte(fichas, antes, FECHA)).toBe(false);
    (fichas as Record<string, ReturnType<typeof ficha>>).vox!.secciones[0]!.items.push({ ref: 'N9', postura: 'critico' });
    expect(igualarCorte(fichas, antes, FECHA)).toBe(true);
    expect(PARTIDOS.map((p) => (fichas as Record<string, { corte: string }>)[p]!.corte)).toEqual(PARTIDOS.map(() => FECHA));
  });
});

describe('informe', () => {
  it('renders the same headings when everything is empty', () => {
    const texto = informe({ fecha: FECHA, etapas: 'descubrir\tok\t3 candidatos\n' });
    expect(texto).toContain('| descubrir | ok | 3 candidatos |');
    expect(texto).toContain('### Problemas de citas nuevos (0)');
    expect(texto.endsWith('\n')).toBe(true);
  });
});

describe('prompts of agentes/08-diario.md', () => {
  const md = readFileSync(join(import.meta.dirname, '..', '..', 'agentes', '08-diario.md'), 'utf8');
  const valores = { FECHA, EJECUCION: '/c/ejecuciones/2026-11-10', CACHE: '/c', DATOS: '/w/apps/29n/src/data', CRITERIOS: '/t/criterios', ENCUESTAS: reglaEncuestas(FECHA) };

  it('extracts both session prompts and the five subagents with every placeholder filled', () => {
    const salida = prompts(md, valores);
    const textos = [salida.busqueda, salida.adjudicacion, ...Object.values(salida.agentes).map((a) => a.prompt)];
    expect(Object.keys(salida.agentes)).toEqual(['buscador-fuente', 'buscador-equidad', 'clasificador', 'redactor-hechos', 'adjudicador']);
    expect(textos.every((t) => t.length > 200 && !t.includes('{{'))).toBe(true);
    expect(salida.adjudicacion).toContain('/c/ejecuciones/2026-11-10/adjudicado/<partido>.json');
    expect(salida.agentes.adjudicador!.prompt).toContain('diario-2026-11-10-<tipo>');
  });

  it('pins every subagent to haiku or opus, and none that reads the web has Bash or Write', () => {
    const { agentes } = prompts(md, valores);
    for (const def of Object.values(agentes)) {
      expect(['haiku', 'opus']).toContain(def.model);
      expect(def.tools.some((t) => ['Bash', 'Write', 'Edit'].includes(t))).toBe(false);
    }
  });

  it('switches the polls rule on the ban date and refuses unknown placeholders', () => {
    expect(reglaEncuestas('2026-11-23')).toMatch(/may be proposed/);
    expect(reglaEncuestas('2026-11-24')).toMatch(/propose no encuestas/);
    expect(() => sustituir('{{OTRO}}', {})).toThrow(/OTRO/);
    expect(() => bloque('nada', 'prompt:busqueda')).toThrow(/falta/);
  });
});

describe('estadoSalida', () => {
  const tarea = { consultas: [{ texto: 'PP critica', motor: 'WebSearch', dominios: [] }, { texto: 'maldita.es/tag/pp', motor: 'WebFetch', dominios: ['maldita.es'] }] };
  const ok = (texto: string) => ({ texto, estado: 'ok' });

  it('matches queries by position, text compared after collapsing whitespace, all with estado ok', () => {
    expect(estadoSalida(tarea, { resultados: [], consultas: [ok('  PP   critica '), ok('maldita.es/tag/pp')] })).toBe('completa');
    expect(salidaCompleta(tarea, { resultados: [], consultas: [ok('PP critica'), ok('maldita.es/tag/pp')] })).toBe(true);
    expect(estadoSalida(tarea, { resultados: [], consultas: [ok('maldita.es/tag/pp'), ok('PP critica')] })).toBe('incompleta');
    expect(estadoSalida(tarea, { resultados: [], consultas: [ok('PP critica'), { texto: 'maldita.es/tag/pp', estado: 'error' }] })).toBe('incompleta');
    expect(estadoSalida(tarea, { resultados: [], consultas: [ok('PP critica')] })).toBe('incompleta');
    expect(estadoSalida(tarea, { resultados: [], consultas: [ok('PP critica otra'), ok('maldita.es/tag/pp')] })).toBe('incompleta');
    expect(estadoSalida(tarea, { resultados: 'ninguno', consultas: [ok('PP critica'), ok('maldita.es/tag/pp')] })).toBe('incompleta');
    expect(estadoSalida(tarea, undefined)).toBe('sin-salida');
  });
});

describe('búsqueda igual: bloqueada para todos', () => {
  const tareas = () => tareasEquidad([run('equidad-2026-11-09-bulos', 'bulos', '2026-11-09', 'maldita.es/tag/{termino}'), { ...run('equidad-2026-11-09-criticos', 'criticos', '2026-11-09'), consultas: [{ plantilla: '{partido} critica', motor: 'WebSearch', dominios: [] }, { plantilla: '{partido} critica', motor: 'WebSearch', dominios: ['newtral.es', 'www.medio.es'] }] }], FECHA, '2026-11-08')
    .map((t) => (t.tipo === 'bulos' ? { ...t, consultas: t.consultas.map((c) => ({ ...c, motor: 'WebFetch' })) } : t));
  const bloqueo = { fecha: FECHA, estado_http: 403, motivo: 'HTTP 403', url: 'https://newtral.es/' };

  it('probes each WebFetch URL and each filtered domain once, and the five tasks reach the same domains', () => {
    expect(urlsSondeo(tareas())).toEqual([
      'https://maldita.es/tag/Abascal',
      'https://maldita.es/tag/Belarra',
      'https://maldita.es/tag/Colau',
      'https://maldita.es/tag/Feijóo',
      'https://maldita.es/tag/Sánchez',
      'https://medio.es/',
      'https://newtral.es/',
    ]);
    expect(dominiosDistintos(tareas())).toEqual([]);
    const distinta = tareas().map((t) => (t.partido === 'vox' && t.tipo === 'criticos' ? { ...t, consultas: [t.consultas[0]!, { ...t.consultas[1]!, dominios: ['otro.es'] }] } : t));
    expect(dominiosDistintos(distinta)).toEqual(['criticos: las consultas no llegan a los mismos dominios en los cinco partidos']);
  });

  it('marks a blocked query in all five tasks', () => {
    const marcadas = marcarBloqueadas(tareas(), { 'newtral.es': bloqueo });
    const criticos = marcadas.filter((t) => t.tipo === 'criticos');
    expect(criticos.map((t) => t.consultas[1]!.bloqueada)).toEqual(PARTIDOS.map(() => ({ host: 'newtral.es', estado_http: 403, fecha: FECHA, motivo: 'HTTP 403' })));
    expect(criticos.every((t) => t.consultas[0]!.bloqueada === undefined)).toBe(true);
    expect(marcadas.filter((t) => t.tipo === 'bulos').every((t) => !t.consultas[0]!.bloqueada)).toBe(true);
  });

  it('blocked for all: passes with the other queries done, ignores the blocked host, and discloses it the same for all five', () => {
    const [tarea] = marcarBloqueadas(tareas(), { 'newtral.es': bloqueo }).filter((t) => t.tipo === 'criticos' && t.partido === 'pp');
    const salida = { resultados: [{ url: 'https://newtral.es/x' }, { url: 'https://medio.es/y' }], consultas: [{ texto: 'PP critica', estado: 'ok' }, { texto: 'PP critica', estado: 'bloqueada' }] };
    expect(estadoSalida(tarea!, salida)).toBe('completa');
    expect(urlsPermitidas(salida.resultados, ['newtral.es'])).toEqual(['https://medio.es/y']);
    const equidad: EquidadDia = {
      urls: { criticos: Object.fromEntries(PARTIDOS.map((p) => [p, []])) },
      estados: { criticos: Object.fromEntries(PARTIDOS.map((p) => [p, 'completa'])) },
      notas: {},
      bloqueadas: { criticos: [{ host: 'newtral.es', estado_http: 403, fecha: FECHA, motivo: 'HTTP 403', indice: 1 }] },
    };
    const registro = [run('equidad-2026-11-09-criticos', 'criticos', '2026-11-09')];
    const [entrada] = entradasDelDia({ fecha: FECHA, desde: '2026-11-08', registro, equidad });
    expect(entrada!.nota).toBe('Ejecución diaria con las consultas de equidad-2026-11-09-criticos. Consultas bloqueadas para los cinco partidos (no se sortean ni se fuerzan): n.º 2, newtral.es, HTTP 403, 2026-11-10.');
    expect(entrada!.notas).toBeUndefined();
  });

  it('failed for one party only: the kind is dropped for all five', () => {
    const [tarea] = tareas().filter((t) => t.tipo === 'criticos' && t.partido === 'pp');
    expect(estadoSalida(tarea!, { resultados: [], consultas: [{ texto: 'PP critica', estado: 'ok' }, { texto: 'PP critica', estado: 'error', nota: 'HTTP 500' }] })).toBe('incompleta');
    const { porPartido, descartes } = preparar({
      fecha: FECHA,
      equidad: { criticos: Object.fromEntries(PARTIDOS.filter((p) => p !== 'pp').map((p) => [p, ['https://medio.es/c']])) },
      hechos: undefined,
      adjudicados: [{ archivo: 'vox.json', contenido: [{ partido: 'vox', seccion: 'criticos-defensores', item: { texto: 'X.', estado: 'PARCIAL', matiz: 'm', fuentes: [{ url: 'https://medio.es/c', medio: 'M' }], postura: 'critico', busqueda: 'diario-2026-11-10-criticos' } }] }],
    });
    expect(porPartido.vox).toEqual([]);
    expect(descartes[0]!.motivo).toMatch(/no tiene salida para los cinco/);
  });

  it('the agent claims a 403 the script never saw: incomplete', () => {
    const [tarea] = tareas().filter((t) => t.tipo === 'criticos' && t.partido === 'pp');
    expect(estadoSalida(tarea!, { resultados: [], consultas: [{ texto: 'PP critica', estado: 'ok' }, { texto: 'PP critica', estado: 'bloqueada', nota: 'HTTP 403' }] })).toBe('incompleta');
  });

  it('every query blocked: not run today, for all five, with the reason', () => {
    const marcadas = marcarBloqueadas(tareas(), { 'maldita.es': bloqueo }).filter((t) => t.tipo === 'bulos');
    expect(marcadas.map((t) => estadoSalida(t, undefined))).toEqual(PARTIDOS.map(() => 'no-ejecutada'));
    const equidad: EquidadDia = { urls: {}, estados: { bulos: Object.fromEntries(PARTIDOS.map((p) => [p, 'no-ejecutada'])) }, notas: {}, bloqueadas: { bulos: [{ host: 'maldita.es', estado_http: 403, fecha: FECHA, motivo: 'HTTP 403', indice: 0 }] } };
    const [entrada] = entradasDelDia({ fecha: FECHA, desde: '2026-11-08', registro: [run('equidad-2026-11-09-bulos', 'bulos', '2026-11-09', 'maldita.es/tag/{termino}')], equidad });
    expect(entrada!.nota).toMatch(/No se ejecutó hoy: todas las consultas estaban bloqueadas\.$/);
    expect(entrada!.resultados).toEqual(Object.fromEntries(PARTIDOS.map((p) => [p, 0])));
  });

  it('sondear: a 403 on a probed domain is recorded with the date and marks the query for all five', async () => {
    const respuestas: Record<string, number> = { 'https://newtral.es/robots.txt': 200, 'https://newtral.es/': 403, 'https://medio.es/robots.txt': 200, 'https://medio.es/': 200, 'https://maldita.es/robots.txt': 200 };
    const fetch = (async (url: string) => new Response('', { status: respuestas[String(url)] ?? 404, headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const traedor = new Traedor({ fecha: FECHA, fetch, reloj: () => 0, esperar: async () => {}, resolver: async () => ['93.184.215.14'], soloBuzon: [] });
    const { tareas: marcadas, sondeo } = await sondear(tareas(), traedor);
    expect(traedor.bloqueados['newtral.es']).toMatchObject({ fecha: FECHA, estado_http: 403 });
    expect(sondeo.find((s) => s.url === 'https://newtral.es/')).toMatchObject({ estado: 'bloqueado', estado_http: 403 });
    expect(marcadas.filter((t) => t.tipo === 'criticos').every((t) => t.consultas[1]!.bloqueada?.host === 'newtral.es')).toBe(true);
  });
});

describe('problemasAdjudicacion', () => {
  const completo = (partido: string, extra: Record<string, unknown> = {}) => ({ partido, propuestas: [], decisiones: [], ...extra });
  const todos = () => Object.fromEntries(PARTIDOS.map((p) => [p, completo(p)])) as Record<string, unknown>;

  it('accepts five complete files', () => {
    expect(problemasAdjudicacion(todos(), [])).toEqual([]);
  });

  it('fails on a missing file, a wrong partido or missing arrays', () => {
    const archivos = todos();
    delete archivos.vox;
    archivos.pp = completo('psoe');
    archivos.podemos = { partido: 'podemos', propuestas: [] };
    archivos['frente-amplio'] = completo('frente-amplio', { propuestas: 'ninguna' });
    expect(problemasAdjudicacion(archivos, [])).toEqual([
      'adjudicado/frente-amplio.json: propuestas no es una lista',
      'adjudicado/podemos.json: decisiones no es una lista',
      'adjudicado/pp.json: partido es "psoe"',
      'adjudicado/vox.json: falta o no es un objeto JSON',
    ]);
  });

  it('needs a decision for every classified document of the party, by doc_id or URL', () => {
    const archivos = todos();
    archivos.pp = completo('pp', { decisiones: [{ doc_id: 'a', decision: 'propuesto' }, { url: 'https://www.medio.es/b?utm_source=x', decision: 'descartado' }] });
    const tareas = [
      { doc_id: 'a', partido: 'pp' as const, url_canonica: 'https://medio.es/a' },
      { doc_id: 'b', partido: 'pp' as const, url_canonica: 'https://medio.es/b' },
      { doc_id: 'c', partido: 'pp' as const, url_canonica: 'https://medio.es/c' },
    ];
    expect(problemasAdjudicacion(archivos, tareas)).toEqual(['adjudicado/pp.json: sin decisión para c']);
  });
});

describe('ajustesClaude', () => {
  const plantilla = readFileSync(join(import.meta.dirname, '..', 'claude-settings.diario.template.json'), 'utf8');
  const valores = { EJ: '/c/ejecuciones/2026-11-10', N29_CACHE: '/c', T: '/t', HOME: '/h', CONF: '/tmp/conf' };

  const escrituras = (ajustes: { permissions: { allow: string[]; deny: string[] } }, lista: 'allow' | 'deny') =>
    ajustes.permissions[lista].filter((r) => /^(Write|Edit)\(\/\/c\/ejecuciones/.test(r)).sort();
  const reglas = (rutas: readonly string[]) => rutas.flatMap((ruta) => [`Edit(//c/ejecuciones/2026-11-10/${ruta})`, `Write(//c/ejecuciones/2026-11-10/${ruta})`]).sort();

  it('pass busqueda writes only busqueda/ and equidad/; pass adjudicacion only clasificacion/, adjudicado/ and hechos.json', () => {
    const uno = JSON.parse(ajustesClaude(plantilla, valores, 'busqueda'));
    const dos = JSON.parse(ajustesClaude(plantilla, valores, 'adjudicacion'));
    expect(escrituras(uno, 'allow')).toEqual(reglas(['busqueda/**', 'equidad/**']));
    expect(escrituras(dos, 'allow')).toEqual(reglas(['clasificacion/**', 'adjudicado/**', 'hechos.json*']));
    expect(uno.permissions.deny).toEqual(expect.arrayContaining(reglas(['clasificacion/**', 'adjudicado/**', 'hechos.json*'])));
    expect(dos.permissions.deny).toEqual(expect.arrayContaining(reglas(['busqueda/**', 'equidad/**'])));
    expect(ESCRITURA_POR_PASADA).toEqual({ busqueda: ['busqueda/**', 'equidad/**'], adjudicacion: ['clasificacion/**', 'adjudicado/**', 'hechos.json*'] });
  });

  it('fills every placeholder, allows no Bash, and denies the sensitive paths', () => {
    const ajustes = JSON.parse(ajustesClaude(plantilla, valores, 'busqueda'));
    expect(JSON.stringify(ajustes)).not.toMatch(/__[A-Z0-9_]+__/);
    expect(ajustes.permissions.allow.some((r: string) => r.startsWith('Bash'))).toBe(false);
    expect(ajustes.permissions.deny).toEqual(expect.arrayContaining(['Bash', 'Write(//**/.claude/**)', 'Write(//**/*.mjs)', 'Read(//tmp/conf/**)', 'Read(//c/ejecuciones/2026-11-10/diario.log)']));
    expect(ajustes.permissions.defaultMode).toBe('dontAsk');
  });

  it('refuses paths that could widen a rule, a template that allows writes or Bash, and an unknown pass', () => {
    expect(() => ajustesClaude(plantilla, { ...valores, EJ: '/c/**' }, 'busqueda')).toThrow(/ruta no admitida/);
    expect(() => ajustesClaude(plantilla, { ...valores, CONF: 'relativa' }, 'busqueda')).toThrow(/ruta no admitida/);
    expect(() => ajustesClaude(plantilla.replace('"Agent",', '"Agent", "Bash(node *)",'), valores, 'busqueda')).toThrow(/no puede permitir/);
    expect(() => ajustesClaude(plantilla.replace('"Agent",', '"Agent", "Write(/__EJ__/busqueda/**)",'), valores, 'busqueda')).toThrow(/no puede permitir/);
    expect(() => ajustesClaude(plantilla, valores, 'otra' as never)).toThrow(/pasada desconocida/);
    expect(() => ajustesClaude(plantilla, { EJ: '/c' }, 'busqueda')).toThrow(/marcador desconocido/);
  });
});

describe('informe: clasificaciones que faltan', () => {
  it('lists them per party', () => {
    expect(informe({ fecha: FECHA, etapas: '', sinClasificar: { pp: ['a', 'b'] } })).toContain('- pp: a, b');
  });
});
