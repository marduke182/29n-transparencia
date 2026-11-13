import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { idDocumento, urlCanonica, type PartyId } from './cache.ts';
import { Traedor, type VetoGuia } from './traer.ts';
import { registrarBloqueos } from './bloqueos.ts';
import { consultasFuente, type Alias, type Descubrimiento, type TareaBusqueda } from './descubrir.ts';
import {
  AGENTES_POR_PASADA,
  MODELO_JUICIO,
  CLAUDE_VERIFICADA,
  ajustesClaude,
  carpetasDe,
  esPasadaBusqueda,
  herramientasDe,
  hostsWebFetch,
  PERMITIDAS_SIN_ESPECIFICADOR,
  WEBFETCH_PREAPROBADOS,
  type Pasada,
  bloque,
  BUSQUEDAS_WEB_POR_DEFECTO,
  busquedasWebPrevistas,
  ESCRITURA_POR_PASADA,
  limiteBusquedasWeb,
  dominiosDistintos,
  estadoSalida,
  faltasBusqueda,
  enPeriodo,
  lotesClasificar,
  motivoNoArticulo,
  nombreLote,
  NOMBRE_LOTE,
  busquedasDeSesion,
  prefiltrarTareas,
  problemaClasificacion,
  TAMANO_LOTE_CLASIFICAR,
  respuestaAceptable,
  revisarBusqueda,
  rutasReintento,
  textoRutasReintento,
  fuentesEsperadas,
  busquedasRegistradas,
  RESULTADOS_SATURACION,
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
  type Respuesta,
  type TareaEquidad,
} from './diario.ts';

const PARTIDOS: PartyId[] = ['frente-amplio', 'pp', 'psoe', 'vox'];
const FECHA = '2026-11-10';

const run = (id: string, tipo: string, fecha: string, plantilla = '{partido} critica a {termino}'): Busqueda => ({
  id,
  tipo,
  fecha,
  periodo: { desde: '2026-10-05', hasta: fecha },
  consultas: [{ plantilla, motor: 'WebSearch', dominios: ['medio.es'], terminos: { 'frente-amplio': 'Colau', pp: 'Feijóo', psoe: 'Sánchez', vox: 'Abascal' } }],
  resultados: { 'frente-amplio': 1, pp: 1, psoe: 1, vox: 1 },
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
    expect(tareas.map((t) => t.consultas[0]!.texto)).toEqual(['Frente Amplio critica a Colau', 'PP critica a Feijóo', 'PSOE critica a Sánchez', 'Vox critica a Abascal']);
    expect(new Set(tareas.map((t) => JSON.stringify({ ...t, partido: '', nombre: '', salida: '', consultas: t.consultas.map((c) => ({ ...c, texto: '' })) }))).size).toBe(1);
    expect(tareas[0]).toMatchObject({ busqueda: 'diario-2026-11-10-criticos', periodo: { desde: '2026-11-08', hasta: FECHA }, salida: 'equidad/criticos.frente-amplio.json' });
  });

  it('fills the placeholders like the site', () => {
    expect(consultaPara({ plantilla: '{partido}  bulo {termino}', motor: 'WebSearch', dominios: [] }, 'pp')).toBe('PP bulo');
  });

  it('writes the day entry with the template queries, counts per party and why a search did not complete', () => {
    const equidad = {
      urls: { criticos: { 'frente-amplio': ['https://a.es/1'], pp: ['https://a.es/2', 'https://a.es/3'], psoe: [] } },
      estados: { criticos: { 'frente-amplio': 'completa', pp: 'completa', psoe: 'incompleta' } },
      notas: { criticos: { pp: 'Un dominio tardó.' } },
      bloqueadas: {},
    } as EquidadDia;
    const [entrada] = entradasDelDia({ fecha: FECHA, desde: '2026-11-08', registro, equidad });
    expect(entrada).toMatchObject({
      id: 'diario-2026-11-10-criticos',
      periodo: { desde: '2026-11-08', hasta: FECHA },
      resultados: { 'frente-amplio': 1, pp: 2, psoe: 0, vox: 0 },
      notas: { pp: 'Un dominio tardó.', psoe: expect.stringMatching(/quedó incompleta/), vox: 'La búsqueda no devolvió salida para este partido.' },
    });
    expect(entrada!.consultas).toEqual(registro[1]!.consultas);
    expect(entrada!.nota).toMatch(/Sin salida completa para: psoe, vox/);
    // Every finding has one disposition, as the site requires of every current run (busquedas.ts validateHallazgos).
    expect(entrada!.hallazgos).toEqual({
      'frente-amplio': [{ url: 'https://a.es/1', descartado: 'No se propuso ningún elemento con esta URL.' }],
      pp: [
        { url: 'https://a.es/2', descartado: 'No se propuso ningún elemento con esta URL.' },
        { url: 'https://a.es/3', descartado: 'No se propuso ningún elemento con esta URL.' },
      ],
      psoe: [],
      vox: [],
    });
    expect(entradasDelDia({ fecha: FECHA, desde: FECHA, registro: [...registro, entrada!], equidad: { urls: {}, estados: {}, notas: {}, bloqueadas: {} } })).toEqual([]);
  });
});

describe('entradasDelDia: hallazgos', () => {
  const registro = [run('equidad-2026-11-09-bulos', 'bulos', '2026-11-09'), run('equidad-2026-11-09-criticos', 'criticos', '2026-11-09')];
  const fuente = (url: string) => ({ url, medio: 'Medio' });
  const vacia = () => ({ corte: FECHA, secciones: [{ id: 'verificacion', items: [] as object[] }, { id: 'criticos-defensores', items: [] as object[] }] });
  const fichas = Object.fromEntries(PARTIDOS.map((p) => [p, vacia()])) as Record<PartyId, ReturnType<typeof vacia> & { en_espera?: object[] }>;
  fichas.vox.secciones[0]!.items.push({ ref: '59', bulo: true, busqueda: idDiario(FECHA, 'bulos'), fuentes: [fuente('https://maldita.es/desinfo/x')] });
  fichas.vox.secciones[0]!.items.push({ ref: '12', bulo: true, busqueda: 'equidad-2026-11-09-bulos', fuentes: [fuente('https://maldita.es/desinfo/vieja')] });
  fichas.pp.secciones[1]!.items.push({ ref: '70', postura: 'critico', busqueda: idDiario(FECHA, 'criticos'), fuentes: [fuente('https://medio.es/c1')] });
  fichas.pp.en_espera = [{ ref: '71', seccion: 'criticos-defensores', postura: 'critico', busqueda: idDiario(FECHA, 'criticos'), fuentes: [fuente('https://medio.es/c2')] }];
  const equidad: EquidadDia = {
    urls: {
      bulos: { 'frente-amplio': [], pp: [], psoe: ['https://newtral.es/x'], vox: ['https://maldita.es/desinfo/vieja', 'https://maldita.es/desinfo/x', 'https://newtral.es/y'] },
      criticos: { 'frente-amplio': [], pp: ['https://medio.es/c1', 'https://medio.es/c2'], psoe: [], vox: [] },
    },
    estados: {
      bulos: Object.fromEntries(PARTIDOS.map((p) => [p, 'completa'])) as never,
      criticos: Object.fromEntries(PARTIDOS.map((p) => [p, 'completa'])) as never,
    },
    notas: {},
    bloqueadas: {},
  };
  const motivos = { psoe: { 'https://newtral.es/x': 'adjudicación: el host no está en fuentes.json.' } } as never;

  it('publishes, holds or discards every finding, with the reason the run knows', () => {
    const entradas = entradasDelDia({ fecha: FECHA, desde: '2026-11-09', registro, equidad, fichas: fichas as never, motivos });
    const [bulos, criticos] = (['bulos', 'criticos'] as const).map((tipo) => entradas.find((e) => e.tipo === tipo));
    expect(bulos!.hallazgos).toEqual({
      'frente-amplio': [],
      pp: [],
      psoe: [{ url: 'https://newtral.es/x', descartado: 'adjudicación: el host no está en fuentes.json.' }],
      vox: [
        { url: 'https://maldita.es/desinfo/vieja', descartado: 'Ya está en la ficha (12), de otra búsqueda.' },
        { url: 'https://maldita.es/desinfo/x', publicado: ['59'] },
        { url: 'https://newtral.es/y', descartado: 'No se propuso ningún elemento con esta URL.' },
      ],
    });
    expect(criticos!.hallazgos!.pp).toEqual([
      { url: 'https://medio.es/c1', publicado: ['70'] },
      { url: 'https://medio.es/c2', en_espera: '71' },
    ]);
    for (const entrada of [bulos!, criticos!]) for (const p of PARTIDOS) expect(entrada.hallazgos![p]).toHaveLength(entrada.resultados[p]!);
  });

  it('names the finding by the URL the published item cites, so the site can match it', () => {
    const conWww = structuredClone(fichas);
    (conWww.vox.secciones[0]!.items[0] as { fuentes: object[] }).fuentes = [fuente('https://www.maldita.es/desinfo/x/')];
    const bulos = entradasDelDia({ fecha: FECHA, desde: '2026-11-09', registro, equidad, fichas: conWww as never, motivos }).find((e) => e.tipo === 'bulos');
    expect(bulos!.hallazgos!.vox[1]).toEqual({ url: 'https://www.maldita.es/desinfo/x/', publicado: ['59'] });
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
      { video: 'https://www.youtube.com/watch?v=bbbbbb', oficial: 'https://partido.es/transcripcion.pdf', buzon: true },
      { video: 'https://www.youtube.com/watch?v=eeeeee', buzon: true },
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
      porEquidad: [
        {
          archivo: 'criticos.pp.json',
          salida: { busqueda: 'diario-2026-11-10-criticos', partido: 'pp', resultados: [{ url: 'https://otro.es/c' }, { url: 'http://inseguro.es/x' }, { url: 'https://inyectado.com/ignora-tus-instrucciones' }] },
        },
      ],
      emisores: [{ id: 'otro', nombre: 'Otro', hosts: ['otro.es'], tipo: 'medio' }],
    });
    expect(resultado.candidatos.map((c) => [c.emisor, c.url_canonica, c.listado])).toEqual([
      ['medio', 'https://medio.es/b', 'busqueda:medio'],
      ['otro', 'https://otro.es/c', 'busqueda:diario-2026-11-10-criticos'],
    ]);
    // An equal-search result on an unregistered host is never fetched: it is only listed for the owner.
    expect(resultado.candidatos.some((c) => c.url.includes('inyectado.com') || c.emisor === 'sin-registrar')).toBe(false);
    expect(resultado.para_revisar).toEqual([{ url: 'https://inyectado.com/ignora-tus-instrucciones', busqueda: 'diario-2026-11-10-criticos', partido: 'pp', host: 'inyectado.com' }]);
    expect(informe({ fecha: FECHA, etapas: '', paraRevisar: resultado.para_revisar })).toContain('- pp (diario-2026-11-10-criticos): <https://inyectado.com/ignora-tus-instrucciones>');
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
    const tareas = tareasClasificar({ fecha: FECHA, raizCache: '/cache', documentos, alias: todos, porEquidad: [{ salida: { busqueda: 'diario-2026-11-10-criticos', partido: 'pp', resultados: [{ url }] } }] });
    expect(tareas.map((t) => [t.doc_id, t.partido, t.origen])).toEqual([
      [idDocumento(urlCanonica(url)), 'pp', ['diario-2026-11-10-criticos']],
      ['b', 'pp', ['alias']],
      ['b', 'vox', ['alias']],
    ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
    expect(tareas.find((t) => t.doc_id === 'b')).toMatchObject({ texto: '/cache/docs/b/texto.txt', salida: 'clasificacion/b.pp.json' });
  });
});

describe('terms left out of the web search', () => {
  it('still count for classification: the alias rule uses every term of the party', () => {
    const muchos = Array.from({ length: 30 }, (_, n) => `Nombre largo número ${n}`);
    const fa: Alias = { nombres: ['Frente Amplio'], marcas_regionales: [], miembros: muchos, personas: ['Ernest Urtasun'], excluir: [] };
    const terminos = [...fa.nombres, ...fa.marcas_regionales, ...fa.miembros, ...fa.personas];
    const [consulta] = consultasFuente(['medio.es'], [{ partido: 'frente-amplio', terminos }]);
    expect(consulta!.terminos_omitidos).toContain('Ernest Urtasun');
    expect(consulta!.texto).not.toContain('Ernest Urtasun');
    expect(partidosEn('Entrevista a Ernest Urtasun', { 'frente-amplio': fa })).toEqual(['frente-amplio']);
    const documentos = [{ id: 'u', meta: { url: 'https://medio.es/u', url_canonica: 'https://medio.es/u', consultado: FECHA, via: 'web' as const, sha256_contenido: '', estado_http: 200 }, texto: 'Entrevista a Ernest Urtasun.' }];
    expect(tareasClasificar({ fecha: FECHA, raizCache: '/cache', documentos, alias: { 'frente-amplio': fa }, porEquidad: [] }).map((t) => t.partido)).toEqual(['frente-amplio']);
  });
});

describe('clasificación por lotes', () => {
  const tarea = (doc_id: string, partido: PartyId, url = `https://medio.es/${doc_id}`) => ({
    doc_id,
    partido,
    url,
    url_canonica: url,
    via: 'web',
    consultado: FECHA,
    origen: ['alias'],
    texto: `/cache/docs/${doc_id}/texto.txt`,
    meta: `/cache/docs/${doc_id}/meta.json`,
    salida: `clasificacion/${doc_id}.${partido}.json`,
  });
  const listado = `<html><body>${'<article><h2><a href="/x">Titular</a></h2></article>'.repeat(30)}</body></html>`;
  const articulo = `<html><head><script type="application/ld+json">{"@type": "NewsArticle"}</script></head><body>${'<article>x</article>'.repeat(8)}</body></html>`;

  it('drops pages that are not single articles, by URL and by structure, the same for every party', () => {
    expect(motivoNoArticulo({ url_canonica: 'https://medio.es/' })).toBe('portada');
    expect(motivoNoArticulo({ url_canonica: 'https://medio.es/rss.xml' })).toBe('feed');
    expect(motivoNoArticulo({ url_canonica: 'https://medio.es/noticias', ext: 'xml' })).toBe('feed');
    for (const url of ['https://lamarea.com/tags/elecciones', 'https://medio.es/autor/ana-lopez', 'https://medio.es/category/politica', 'https://medio.es/secciones/politica', 'https://medio.es/politica/page/2', 'https://medio.es/buscar']) {
      expect(motivoNoArticulo({ url_canonica: url }), url).toMatch(/página de índice/);
    }
    expect(motivoNoArticulo({ url_canonica: 'https://medio.es/noticias?s=psoe' })).toBe('búsqueda o paginación');
    // An article that lives under a section path is not an index.
    expect(motivoNoArticulo({ url_canonica: 'https://medio.es/secciones/politica/el-congreso-aprueba-la-ley-de-vivienda' })).toBeUndefined();
    expect(motivoNoArticulo({ url_canonica: 'https://cis.es/es/sala-prensa/noticias', html: listado })).toMatch(/^listado \(30 elementos <article>/);
    // Many <article> elements but a headline slug, or an article in JSON-LD: kept.
    expect(motivoNoArticulo({ url_canonica: 'https://ondavasca.com/frente-amplio-situa-la-vivienda-en-el-centro', html: listado })).toBeUndefined();
    expect(motivoNoArticulo({ url_canonica: 'https://medio.es/politica', html: articulo })).toBeUndefined();
    expect(motivoNoArticulo({ url_canonica: 'https://medio.es/2026/11/10/pp-presenta-programa', html: '<p>Texto</p>' })).toBeUndefined();
    const tareas = PARTIDOS.flatMap((p) => [tarea('aa', p, 'https://lamarea.com/tags/elecciones'), tarea('bb', p)]);
    const { tareas: quedan, descartados_previos } = prefiltrarTareas(tareas, () => ({ ext: 'html', html: '<p>x</p>' }));
    expect(quedan.map((t) => t.doc_id)).toEqual(['bb', 'bb', 'bb', 'bb']);
    expect(descartados_previos.map((d) => d.partido)).toEqual(PARTIDOS);
    expect(new Set(descartados_previos.map((d) => d.motivo)).size).toBe(1);
  });

  it('cuts batches sorted by task id, blind to the party, never splitting a document\'s tasks, each document counted once', () => {
    const tareas = ['c3', 'a1', 'b2'].flatMap((id) => [...PARTIDOS].reverse().map((p) => tarea(id, p)));
    const ids = (lotes: { doc_id: string; partido: string }[][]) => lotes.map((l) => l.map((t) => `${t.doc_id}.${t.partido}`));
    // By count: a document's four tasks stay together, so a batch of 5 holds one document.
    const lotes = lotesClasificar(tareas, 5);
    expect(lotes.map((l) => l.length)).toEqual([4, 4, 4]);
    expect(lotes.flat().map((t) => t.salida)).toEqual([...tareas.map((t) => t.salida)].sort());
    expect(lotesClasificar(tareas, 8).map((l) => l.length)).toEqual([8, 4]);
    expect(lotesClasificar(tareas, 5)).toEqual(lotesClasificar([...tareas].reverse(), 5));
    expect(TAMANO_LOTE_CLASIFICAR).toBe(20);
    expect(lotesClasificar(Array.from({ length: 617 }, (_, n) => tarea(`d${String(n).padStart(3, '0')}`, 'pp'))).length).toBe(31);
    // By size: each document's length counts once (not once per party); one longer than the target goes alone.
    const largo = (id: string) => (id === 'b2' ? 200_000 : 25_000);
    const porTamano = lotesClasificar(tareas, 20, largo);
    expect(ids(porTamano)).toEqual([PARTIDOS.map((p) => `a1.${p}`), PARTIDOS.map((p) => `b2.${p}`), PARTIDOS.map((p) => `c3.${p}`)]);
    expect(ids(lotesClasificar(tareas, 20, () => 25_000))).toEqual([[...PARTIDOS.map((p) => `a1.${p}`), ...PARTIDOS.map((p) => `b2.${p}`)], PARTIDOS.map((p) => `c3.${p}`)]);
    expect(porTamano).toEqual(lotesClasificar([...tareas].reverse(), 20, largo));
    expect(nombreLote(3)).toBe('03');
    expect(nombreLote(123)).toBe('123');
    for (const bueno of ['01', '99', '123', 'reintento-01', 'reintento-100']) expect(NOMBRE_LOTE.test(bueno), bueno).toBe(true);
    for (const malo of ['1', '1234', 'reintento', 'reintento-1', '01a', '../01']) expect(NOMBRE_LOTE.test(malo), malo).toBe(false);
  });

  it('accepts a saved classification only as a JSON object for the task\'s doc_id and party', () => {
    const t = tarea('aa', 'pp');
    expect(problemaClasificacion(t, JSON.stringify({ doc_id: 'aa', partido: 'pp', relevante: false }))).toBeUndefined();
    expect(problemaClasificacion(t, ` ${JSON.stringify({ doc_id: 'aa', partido: 'pp' })}\n`)).toBeUndefined();
    expect(problemaClasificacion(t, undefined)).toBe('clasificacion/aa.pp.json: falta');
    expect(problemaClasificacion(t, '{"doc_id": "aa"}]}')).toBe('clasificacion/aa.pp.json: no es JSON');
    expect(problemaClasificacion(t, '[]')).toBe('clasificacion/aa.pp.json: no es un objeto JSON');
    expect(problemaClasificacion(t, JSON.stringify({ doc_id: 'aa', partido: 'vox' }))).toBe('clasificacion/aa.pp.json: doc_id o partido no son los de la tarea');
  });
});

describe('preparar', () => {
  const item = (texto: string, url: string, extra: Record<string, unknown> = {}) => ({ texto, estado: 'PARCIAL', matiz: 'Según el relato de Medio.', fuentes: [{ url, medio: 'Medio' }], ...extra });
  const equidadCompleta = { criticos: Object.fromEntries(PARTIDOS.map((p) => [p, p === 'pp' ? ['https://medio.es/critica'] : []])) };

  it('keeps own-party proposals and drops other parties, adjudicator hechos and unsearched critics', () => {
    const { porPartido, descartes } = preparar({
      citable: () => true,
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
      citable: () => true,
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
    expect(descartes.map((d) => d.motivo)).toEqual([expect.stringMatching(/no tiene salida para los cuatro/), expect.stringMatching(/veda/)]);
  });

  it('drops proposals and shared facts whose pregunta does not match the seccion, and keeps a matching pregunta', () => {
    const hechos = {
      hechos: [
        { hecho: 'encuesta-cis-2026-11-09', seccion: 'encuestas', pregunta: 'Q7', partidos: ['pp', 'psoe'], item: item('Barómetro.', 'https://cis.es/b') },
        { hecho: 'debate-rtve-2026-11-09', seccion: 'candidatura', pregunta: 'Q2', partidos: ['pp', 'psoe'], item: item('Debate.', 'https://rtve.es/d') },
      ],
    };
    const { porPartido, descartes } = preparar({
      citable: () => true,
      fecha: FECHA,
      equidad: {},
      hechos,
      adjudicados: [
        {
          archivo: 'pp.json',
          contenido: [
            { partido: 'pp', seccion: 'por-escrito', pregunta: 'Q2', item: item('Programa.', 'https://pp.es/programa') },
            { partido: 'pp', seccion: 'cambios', pregunta: 'Q4', item: item('Cambio.', 'https://medio.es/c') },
            { partido: 'pp', seccion: 'temas', pregunta: 'Q2', item: item('Dato de contexto.', 'https://ine.es/d', { contexto: true }) },
            { partido: 'pp', seccion: 'temas', pregunta: null, item: item('Sin pregunta.', 'https://medio.es/n') },
            { partido: 'pp', seccion: 'historial', pregunta: 'Q4', item: item('Contexto con veredicto.', 'https://medio.es/v', { contexto: true, veredicto: 'Sin datos' }) },
          ],
        },
      ],
    });
    expect(porPartido.pp.map((p) => [(p.item as { texto: string }).texto, p.pregunta])).toEqual([
      ['Programa.', 'Q2'],
      ['Dato de contexto.', 'Q2'],
      ['Barómetro.', 'Q7'],
    ]);
    expect(descartes.map((d) => `${d.archivo}#${d.indice}`)).toEqual(['hechos.json#1', 'pp.json#1', 'pp.json#3', 'pp.json#4']);
    expect(descartes.map((d) => d.motivo).slice(2)).toEqual([expect.stringMatching(/no se propone/), 'una nota de contexto no lleva veredicto']);
    expect(descartes[0]!.motivo).toMatch(/^hecho "debate-rtve-2026-11-09": pregunta Q2/);
  });

  it('accepts a court case from the causas search only as Q8', () => {
    const urls = ['https://medio.es/causa'];
    const equidad = { causas: Object.fromEntries(PARTIDOS.map((p) => [p, p === 'pp' ? urls : []])) };
    const causa = item('Un juzgado admite una querella.', urls[0]!, { busqueda: 'diario-2026-11-10-causas' });
    const { porPartido, descartes } = preparar({
      citable: () => true,
      fecha: FECHA,
      equidad,
      hechos: undefined,
      adjudicados: [{ archivo: 'pp.json', contenido: [{ partido: 'pp', seccion: 'historial', pregunta: 'Q8', item: causa }, { partido: 'pp', seccion: 'historial', pregunta: 'Q4', item: causa }] }],
    });
    expect(porPartido.pp.map((p) => p.pregunta)).toEqual(['Q8']);
    expect(descartes.map((d) => d.motivo)).toEqual([expect.stringMatching(/responde a Q8/)]);
  });

  it('copies each shared fact identically to every party it names', () => {
    const hecho = { hecho: 'debate-rtve-2026-11-09', seccion: 'candidatura', partidos: ['psoe', 'pp', 'pp'], item: item('Debate a dos.', 'https://rtve.es/d') };
    const { porPartido, deHechos, descartes } = preparar({ citable: () => true, fecha: FECHA, equidad: {}, adjudicados: [], hechos: { hechos: [hecho, { ...hecho }, { hecho: 'solo', seccion: 'temas', partidos: ['pp'], item: item('Uno.', 'https://a.es/x') }] } });
    expect(deHechos).toBe(2);
    expect(porPartido.pp[0]).toEqual({ partido: 'pp', seccion: 'candidatura', item: { ...hecho.item, hecho: 'debate-rtve-2026-11-09' } });
    expect(porPartido.psoe[0]!.item).toEqual(porPartido.pp[0]!.item);
    expect(descartes.map((d) => d.motivo)).toEqual([expect.stringMatching(/repetido/), expect.stringMatching(/al menos dos/)]);
  });
});

describe('preparar: hosts sin registrar', () => {
  it('drops any proposal or shared fact that names a URL citable refuses, wherever the URL is (sources, quote, perfil documents)', () => {
    const citable = (url: string) => new URL(url).hostname.endsWith('medio.es');
    const item = (url: string, extra: Record<string, unknown> = {}) => ({ texto: 'Algo.', estado: 'PARCIAL', matiz: 'Según Medio.', fuentes: [{ url, medio: 'Medio' }], ...extra });
    const { porPartido, descartes } = preparar({
      fecha: FECHA,
      equidad: {},
      citable,
      adjudicados: [
        {
          archivo: 'pp.json',
          contenido: {
            propuestas: [
              { partido: 'pp', seccion: 'temas', pregunta: 'Q2', item: item('https://www.medio.es/ok') },
              { partido: 'pp', seccion: 'temas', pregunta: 'Q2', item: item('https://inyectado.com/a') },
              { partido: 'pp', seccion: 'temas', pregunta: 'Q2', item: item('https://medio.es/b', { cita: { texto: 'x', url: 'https://inyectado.com/b' } }) },
              { partido: 'pp', destino: 'perfil', tipo: 'documento', documento: { titulo: 'T', url: 'https://inyectado.com/c' } },
            ],
          },
        },
      ],
      hechos: { hechos: [{ hecho: 'debate', seccion: 'temas', pregunta: 'Q2', partidos: ['pp', 'vox'], item: item('https://inyectado.com/d') }] },
    });
    expect(porPartido.pp.length).toBe(1);
    expect(descartes.map((d) => [d.archivo, d.indice, d.motivo])).toEqual([
      ['hechos.json', 0, 'hecho "debate": https://inyectado.com/d: host sin registrar en fuentes.json; no se publica sin revisión'],
      ['pp.json', 1, 'https://inyectado.com/a: host sin registrar en fuentes.json; no se publica sin revisión'],
      ['pp.json', 2, 'https://inyectado.com/b: host sin registrar en fuentes.json; no se publica sin revisión'],
      ['pp.json', 3, 'https://inyectado.com/c: host sin registrar en fuentes.json; no se publica sin revisión'],
    ]);
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
      pp: ficha(['critico'], [['103', 'critico'], ['12', 'critico']]),
      psoe: ficha(['critico'], [['5', 'critico']]),
      vox: ficha(['critico'], [['7', 'critico']]),
    } as never;
    const { promovidos, n } = promover(fichas);
    expect(n).toEqual({ critico: 2, defensor: 0 });
    expect(promovidos.map((p) => `${p.partido}:${p.ref}`)).toEqual(['frente-amplio:12', 'pp:12', 'psoe:5', 'vox:7']);
    const pp = (fichas as Record<string, ReturnType<typeof ficha>>).pp!;
    expect(pp.secciones[0]!.items.at(-1)).toEqual({ ref: '12', postura: 'critico' });
    expect(pp.en_espera).toEqual([{ ref: '103', postura: 'critico', seccion: 'criticos-defensores' }]);
    expect('en_espera' in (fichas as Record<string, object>).vox!).toBe(false);
  });

  it('moves corte in all four only when a party file changed', () => {
    const fichas = Object.fromEntries(PARTIDOS.map((p) => [p, ficha([])])) as never;
    const antes = Object.fromEntries(PARTIDOS.map((p) => [p, JSON.stringify(ficha([]))])) as never;
    expect(igualarCorte(fichas, antes, FECHA)).toBe(false);
    (fichas as Record<string, ReturnType<typeof ficha>>).vox!.secciones[0]!.items.push({ ref: 'N9', postura: 'critico' });
    expect(igualarCorte(fichas, antes, FECHA)).toBe(true);
    expect(PARTIDOS.map((p) => (fichas as Record<string, { corte: string }>)[p]!.corte)).toEqual(PARTIDOS.map(() => FECHA));
  });

  // The site requires every perfil's periodo.hasta to equal its party sheet's corte (perfiles.ts validatePeriodoCorte),
  // and a document en_espera to be dated after it.
  it('runs the four perfiles to the new corte and publishes the held documents it reaches', () => {
    const perfil = (p: string) => ({
      partido: p,
      periodo: { desde: '2026-10-05', hasta: '2026-11-09' },
      limites: [],
      documentos: [{ id: `${p}-d1`, fecha: '2026-11-01' }],
      propuestas: [],
      mensajes: [],
      ...(p === 'pp'
        ? {
            en_espera: {
              documentos: [
                { id: 'pp-d2', fecha: '2026-11-10' },
                { id: 'pp-d3', fecha: '2026-11-12' },
              ],
              propuestas: [
                { id: 'pp-p1', documentos: ['pp-d2'], cita: { texto: 'x', documento: 'pp-d2' } },
                { id: 'pp-p2', documentos: ['pp-d1', 'pp-d3'], cita: { texto: 'y', documento: 'pp-d3' } },
              ],
              mensajes: [{ id: 'pp-m1', documentos: ['pp-d1', 'pp-d2'] }],
            },
          }
        : {}),
    });
    const fichas = Object.fromEntries(PARTIDOS.map((p) => [p, ficha([])])) as never;
    const antes = Object.fromEntries(PARTIDOS.map((p) => [p, JSON.stringify(ficha([]))])) as never;
    const perfiles = Object.fromEntries(PARTIDOS.map((p) => [p, perfil(p)])) as never;
    const perfilesAntes = Object.fromEntries(PARTIDOS.map((p) => [p, JSON.stringify(perfil(p))])) as never;
    expect(igualarCorte(fichas, antes, '2026-11-11', perfiles, perfilesAntes)).toBe(false);
    (fichas as Record<string, ReturnType<typeof ficha>>).vox!.secciones[0]!.items.push({ ref: 'N9', postura: 'critico' });
    expect(igualarCorte(fichas, antes, '2026-11-11', perfiles, perfilesAntes)).toBe(true);
    const todos = perfiles as Record<string, ReturnType<typeof perfil> & { en_espera?: Record<string, { id: string }[]> }>;
    expect(PARTIDOS.map((p) => todos[p]!.periodo)).toEqual(PARTIDOS.map(() => ({ desde: '2026-10-05', hasta: '2026-11-11' })));
    const pp = todos.pp!;
    expect(pp.documentos.map((d) => d.id)).toEqual(['pp-d1', 'pp-d2']);
    expect((pp.propuestas as { id: string }[]).map((d) => d.id)).toEqual(['pp-p1']);
    expect((pp.mensajes as { id: string }[]).map((d) => d.id)).toEqual(['pp-m1']);
    expect(pp.en_espera).toEqual({ documentos: [{ id: 'pp-d3', fecha: '2026-11-12' }], propuestas: [expect.objectContaining({ id: 'pp-p2' })], mensajes: [] });
    expect('en_espera' in todos.vox!).toBe(false);
  });

  it('moves corte and the perfiles together when only a perfil changed', () => {
    const fichas = Object.fromEntries(PARTIDOS.map((p) => [p, ficha([])])) as never;
    const antes = Object.fromEntries(PARTIDOS.map((p) => [p, JSON.stringify(ficha([]))])) as never;
    const perfil = () => ({ periodo: { desde: '2026-10-05', hasta: '2026-11-09' }, documentos: [] as object[], propuestas: [], mensajes: [] });
    const perfiles = Object.fromEntries(PARTIDOS.map((p) => [p, perfil()])) as Record<string, ReturnType<typeof perfil>>;
    const perfilesAntes = Object.fromEntries(PARTIDOS.map((p) => [p, JSON.stringify(perfil())])) as never;
    perfiles.psoe!.documentos.push({ id: 'psoe-d9', fecha: '2026-11-11' });
    expect(igualarCorte(fichas, antes, '2026-11-11', perfiles as never, perfilesAntes)).toBe(true);
    expect(PARTIDOS.map((p) => (fichas as Record<string, { corte: string }>)[p]!.corte)).toEqual(PARTIDOS.map(() => '2026-11-11'));
    expect(PARTIDOS.map((p) => perfiles[p]!.periodo.hasta)).toEqual(PARTIDOS.map(() => '2026-11-11'));
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
  const valores = { FECHA, EJECUCION: '/c/ejecuciones/2026-11-10', CACHE: '/c', DATOS: '/w/apps/29n/src/data', CRITERIOS: '/t/criterios', ENCUESTAS: reglaEncuestas(FECHA), SATURACION: '10' };

  it('extracts the session prompts and the two search subagents with every placeholder filled', () => {
    const salida = prompts(md, { ...valores, PARTIDO: 'pp' });
    const textos = [salida.busqueda, salida.clasificacion, salida.hechos, salida.adjudicacion, ...Object.values(salida.agentes).map((a) => a.prompt)];
    expect(Object.keys(salida.agentes)).toEqual(['buscador-fuente', 'buscador-equidad']);
    expect(textos.every((t) => t.length > 200 && !t.includes('{{'))).toBe(true);
    expect(salida.agentes['buscador-fuente']!.prompt).toContain('returns 10 or more results');
    expect(salida.adjudicacion).toContain('diario-2026-11-10-<tipo>');
    // The retry session: the same prompt, on the subset of tasks the CLI appends.
    expect(salida['busqueda-reintento']).toBe(salida.busqueda);
    expect(salida.busqueda).toContain('For each task of TAREAS_EQUIDAD below');
  });

  it('pins the searchers to haiku with only WebSearch and WebFetch; no session reads or writes a file', () => {
    const salida = prompts(md, valores);
    for (const def of Object.values(salida.agentes)) {
      expect(def.model).toBe('haiku');
      expect(def.tools).toEqual(['WebSearch', 'WebFetch']);
    }
    for (const texto of [salida.busqueda, salida.clasificacion, salida.hechos, salida.adjudicacion]) {
      expect(texto).not.toMatch(/with the Write tool|Read \/|check with Glob|Write exactly one file/);
      expect(texto).toContain('structured output');
    }
    expect(MODELO_JUICIO).toEqual({ clasificacion: 'haiku', hechos: 'opus', adjudicacion: 'opus' });
  });

  it('gives the four parties the same adjudication prompt but for the party id', () => {
    const porPartido = ['frente-amplio', 'pp', 'psoe', 'vox'].map((p) => prompts(md, { ...valores, PARTIDO: p }).adjudicacion);
    expect(porPartido[1]).toContain('Your party is pp: below, <id> means pp.');
    expect(new Set(porPartido.map((t) => t.replace(/Your party is [a-z-]+: below, <id> means [a-z-]+\./, 'X'))).size).toBe(1);
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

  it('probes each WebFetch URL and each filtered domain once, and the four tasks reach the same domains', () => {
    expect(urlsSondeo(tareas())).toEqual([
      'https://maldita.es/tag/Abascal',
      'https://maldita.es/tag/Colau',
      'https://maldita.es/tag/Feijóo',
      'https://maldita.es/tag/Sánchez',
      'https://medio.es/',
      'https://newtral.es/',
    ]);
    expect(dominiosDistintos(tareas())).toEqual([]);
    const distinta = tareas().map((t) => (t.partido === 'vox' && t.tipo === 'criticos' ? { ...t, consultas: [t.consultas[0]!, { ...t.consultas[1]!, dominios: ['otro.es'] }] } : t));
    expect(dominiosDistintos(distinta)).toEqual(['criticos: las consultas no llegan a los mismos dominios en los cuatro partidos']);
  });

  it('marks a blocked query in all four tasks', () => {
    const marcadas = marcarBloqueadas(tareas(), { 'newtral.es': bloqueo });
    const criticos = marcadas.filter((t) => t.tipo === 'criticos');
    expect(criticos.map((t) => t.consultas[1]!.bloqueada)).toEqual(PARTIDOS.map(() => ({ host: 'newtral.es', estado_http: 403, fecha: FECHA, motivo: 'HTTP 403' })));
    expect(criticos.every((t) => t.consultas[0]!.bloqueada === undefined)).toBe(true);
    expect(marcadas.filter((t) => t.tipo === 'bulos').every((t) => !t.consultas[0]!.bloqueada)).toBe(true);
  });

  it('blocked for all: passes with the other queries done, ignores the blocked host, and discloses it the same for all four', () => {
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
    expect(entrada!.nota).toBe('Ejecución diaria con las consultas de equidad-2026-11-09-criticos. Consultas bloqueadas para los cuatro partidos (no se sortean ni se fuerzan): n.º 2, newtral.es, HTTP 403, 2026-11-10.');
    expect(entrada!.notas).toBeUndefined();
  });

  it('failed for one party only: the kind is dropped for all four', () => {
    const [tarea] = tareas().filter((t) => t.tipo === 'criticos' && t.partido === 'pp');
    expect(estadoSalida(tarea!, { resultados: [], consultas: [{ texto: 'PP critica', estado: 'ok' }, { texto: 'PP critica', estado: 'error', nota: 'HTTP 500' }] })).toBe('incompleta');
    const { porPartido, descartes } = preparar({
      citable: () => true,
      fecha: FECHA,
      equidad: { criticos: Object.fromEntries(PARTIDOS.filter((p) => p !== 'pp').map((p) => [p, ['https://medio.es/c']])) },
      hechos: undefined,
      adjudicados: [{ archivo: 'vox.json', contenido: [{ partido: 'vox', seccion: 'criticos-defensores', item: { texto: 'X.', estado: 'PARCIAL', matiz: 'm', fuentes: [{ url: 'https://medio.es/c', medio: 'M' }], postura: 'critico', busqueda: 'diario-2026-11-10-criticos' } }] }],
    });
    expect(porPartido.vox).toEqual([]);
    expect(descartes[0]!.motivo).toMatch(/no tiene salida para los cuatro/);
  });

  it('the agent claims a 403 the script never saw: incomplete', () => {
    const [tarea] = tareas().filter((t) => t.tipo === 'criticos' && t.partido === 'pp');
    expect(estadoSalida(tarea!, { resultados: [], consultas: [{ texto: 'PP critica', estado: 'ok' }, { texto: 'PP critica', estado: 'bloqueada', nota: 'HTTP 403' }] })).toBe('incompleta');
  });

  it('every query blocked: not run today, for all four, with the reason', () => {
    const marcadas = marcarBloqueadas(tareas(), { 'maldita.es': bloqueo }).filter((t) => t.tipo === 'bulos');
    expect(marcadas.map((t) => estadoSalida(t, undefined))).toEqual(PARTIDOS.map(() => 'no-ejecutada'));
    const equidad: EquidadDia = { urls: {}, estados: { bulos: Object.fromEntries(PARTIDOS.map((p) => [p, 'no-ejecutada'])) }, notas: {}, bloqueadas: { bulos: [{ host: 'maldita.es', estado_http: 403, fecha: FECHA, motivo: 'HTTP 403', indice: 0 }] } };
    const [entrada] = entradasDelDia({ fecha: FECHA, desde: '2026-11-08', registro: [run('equidad-2026-11-09-bulos', 'bulos', '2026-11-09', 'maldita.es/tag/{termino}')], equidad });
    expect(entrada!.nota).toMatch(/No se ejecutó hoy: todas las consultas estaban bloqueadas\.$/);
    expect(entrada!.resultados).toEqual(Object.fromEntries(PARTIDOS.map((p) => [p, 0])));
  });

  it('sondear: a 403 on a probed domain is recorded with the date and marks the query for all four', async () => {
    const respuestas: Record<string, number> = { 'https://newtral.es/robots.txt': 200, 'https://newtral.es/': 403, 'https://medio.es/robots.txt': 200, 'https://medio.es/': 200, 'https://maldita.es/robots.txt': 200 };
    const fetch = (async (url: string) => new Response('', { status: respuestas[String(url)] ?? 404, headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const traedor = new Traedor({ fecha: FECHA, fetch, reloj: () => 0, esperar: async () => {}, resolver: async () => ['93.184.215.14'], soloBuzon: [] });
    const { tareas: marcadas, sondeo } = await sondear(tareas(), traedor);
    expect(traedor.bloqueados['newtral.es']).toMatchObject({ fecha: FECHA, estado_http: 403 });
    expect(sondeo.find((s) => s.url === 'https://newtral.es/')).toMatchObject({ estado: 'bloqueado', estado_http: 403 });
    expect(marcadas.filter((t) => t.tipo === 'criticos').every((t) => t.consultas[1]!.bloqueada?.host === 'newtral.es')).toBe(true);
  });

  it('sondear: a host that blocks the guide (noTraer, or a robots.txt against Claude\'s agents) is blocked for all four, with the reason', async () => {
    const robots: Record<string, string> = { 'https://newtral.es/robots.txt': 'User-agent: Claude-User\nDisallow: /\n' };
    const fetch = (async (url: string) => new Response(robots[String(url)] ?? '', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    const traedor = new Traedor({ fecha: FECHA, fetch, reloj: () => 0, esperar: async () => {}, resolver: async () => ['93.184.215.14'], soloBuzon: [], noTraer: ['medio.es'] });
    const { tareas: marcadas } = await sondear(tareas(), traedor);
    const criticos = marcadas.filter((t) => t.tipo === 'criticos');
    // The second criticos query reaches newtral.es (robots veto) and medio.es (noTraer): the first host found blocks it, for all four.
    expect(new Set(criticos.map((t) => JSON.stringify(t.consultas[1]!.bloqueada)))).toHaveLength(1);
    expect(criticos[0]!.consultas[1]!.bloqueada).toMatchObject({ host: 'newtral.es', estado_http: null, fecha: FECHA, motivo: expect.stringMatching(/no admite agentes de Claude/) });
    const soloMedio = tareas().map((t) => (t.tipo === 'criticos' ? { ...t, consultas: [t.consultas[0]!, { ...t.consultas[1]!, dominios: ['www.medio.es'] }] } : t));
    const otra = new Traedor({ fecha: FECHA, fetch, reloj: () => 0, esperar: async () => {}, resolver: async () => ['93.184.215.14'], soloBuzon: [], noTraer: ['medio.es'] });
    const { tareas: conMedio } = await sondear(soloMedio, otra);
    expect(conMedio.find((t) => t.tipo === 'criticos')!.consultas[1]!.bloqueada).toMatchObject({ host: 'medio.es', estado_http: null, motivo: expect.stringMatching(/bloquea a la guía/) });
    expect(conMedio.find((t) => t.tipo === 'criticos')!.consultas[0]!.bloqueada).toBeUndefined();
  });
});

describe('problemasAdjudicacion', () => {
  const completo = (partido: string, extra: Record<string, unknown> = {}) => ({ partido, propuestas: [], decisiones: [], ...extra });
  const todos = () => Object.fromEntries(PARTIDOS.map((p) => [p, completo(p)])) as Record<string, unknown>;

  it('accepts four complete files', () => {
    expect(problemasAdjudicacion(todos(), [])).toEqual([]);
  });

  it('fails on a missing file, a wrong partido or missing arrays', () => {
    const archivos = todos();
    delete archivos.vox;
    archivos.pp = completo('psoe');
    archivos.psoe = { partido: 'psoe', propuestas: [] };
    archivos['frente-amplio'] = completo('frente-amplio', { propuestas: 'ninguna' });
    expect(problemasAdjudicacion(archivos, [])).toEqual([
      'adjudicado/frente-amplio.json: propuestas no es una lista',
      'adjudicado/pp.json: partido es "psoe"',
      'adjudicado/psoe.json: decisiones no es una lista',
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

describe('permisos de Claude: restricciones duras por pasada', () => {
  const plantilla = readFileSync(join(import.meta.dirname, '..', 'claude-settings.diario.template.json'), 'utf8');
  const valores = { EJ: '/c/ejecuciones/2026-11-10', N29_CACHE: '/c', T: '/t', HOME: '/h', CONF: '/tmp/conf' };
  const md = readFileSync(join(import.meta.dirname, '..', '..', 'agentes', '08-diario.md'), 'utf8');
  const { agentes } = prompts(md, { FECHA, EJECUCION: valores.EJ, CACHE: '/c', DATOS: `${valores.EJ}/antes`, CRITERIOS: '/t/criterios', ENCUESTAS: reglaEncuestas(FECHA), SATURACION: '10' });
  const hostsBusqueda = ['medio.es', 'docs.python.org', 'elpais.com'];
  type Ajustes = { permissions: { allow: string[]; deny: string[]; additionalDirectories: string[]; defaultMode: string }; disableAllHooks: boolean; enableAllProjectMcpServers: boolean };
  const pasadas: Pasada[] = ['busqueda', 'busqueda-reintento', 'clasificacion', 'hechos', 'adjudicacion'];
  const generar = (pasada: Pasada): Ajustes => JSON.parse(ajustesClaude(plantilla, valores, pasada, ['otro-medio.es'], esPasadaBusqueda(pasada) ? hostsBusqueda : []));
  const juicio = pasadas.filter((p) => !esPasadaBusqueda(p));

  it('allows no rule without a specifier but the reviewed list, reads and writes no file, in dontAsk mode with no hooks or MCP', () => {
    expect(PERMITIDAS_SIN_ESPECIFICADOR).toEqual(['StructuredOutput', 'WebSearch']);
    for (const pasada of pasadas) {
      const ajustes = generar(pasada);
      expect(ajustes.permissions.defaultMode, pasada).toBe('dontAsk');
      expect(ajustes.disableAllHooks).toBe(true);
      expect(ajustes.enableAllProjectMcpServers).toBe(false);
      const sinEspecificador = ajustes.permissions.allow.filter((regla) => !/^[A-Za-z]+\(.+\)$/.test(regla));
      expect(sinEspecificador, pasada).toEqual(esPasadaBusqueda(pasada) ? ['StructuredOutput', 'WebSearch'] : ['StructuredOutput']);
      expect(ajustes.permissions.allow.filter((r) => /^(Bash|PowerShell|Monitor|NotebookEdit|Glob|Grep|Read|Write|Edit|Skill|mcp__)/.test(r)), pasada).toEqual([]);
      expect(ajustes.permissions.deny, pasada).toEqual(expect.arrayContaining(['Bash', 'PowerShell', 'NotebookEdit', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'mcp__*']));
      expect(ajustes.permissions.additionalDirectories, pasada).toEqual([]);
      expect(carpetasDe(pasada, valores), pasada).toEqual([]);
    }
    expect(() => ajustesClaude(plantilla.replace('"allow": []', '"allow": ["Bash(node *)"]'), valores, 'busqueda')).toThrow(/no puede permitir/);
    expect(() => ajustesClaude(plantilla.replace('"allow": []', '"allow": ["Glob"]'), valores, 'busqueda')).toThrow(/no puede permitir/);
    expect(() => ajustesClaude(plantilla.replace('"allow": []', '"additionalDirectories": ["/"], "allow": []'), valores, 'busqueda')).toThrow(/carpetas de cada pasada/);
    expect(() => ajustesClaude(plantilla, { ...valores, EJ: '/c/**' }, 'busqueda')).toThrow(/ruta no admitida/);
    expect(() => ajustesClaude(plantilla, valores, 'otra' as never)).toThrow(/pasada desconocida/);
    expect(() => ajustesClaude(plantilla, { EJ: '/c' }, 'busqueda')).toThrow(/marcador desconocido/);
  });

  it('gives the classification, facts and adjudication passes no tool at all: --tools empty, no subagent, Agent, WebFetch and WebSearch denied', () => {
    for (const pasada of juicio) {
      const ajustes = generar(pasada);
      expect(herramientasDe(pasada), pasada).toEqual([]);
      expect(AGENTES_POR_PASADA[pasada], pasada).toEqual([]);
      expect(ajustes.permissions.allow, pasada).toEqual(['StructuredOutput']);
      expect(ajustes.permissions.deny, pasada).toEqual(expect.arrayContaining(['Agent', 'WebFetch', 'WebSearch']));
      expect(() => ajustesClaude(plantilla, valores, pasada, [], ['medio.es']), pasada).toThrow(/no tiene WebFetch/);
    }
  });

  it('lets the search passes WebFetch only the listed hosts, never by a bare rule, and denies the preapproved domains and the vetoed hosts', () => {
    for (const pasada of ['busqueda', 'busqueda-reintento'] as const) {
      const ajustes = generar(pasada);
      expect(herramientasDe(pasada)).toEqual(['Agent', 'WebFetch', 'WebSearch']);
      expect(ajustes.permissions.allow.filter((r) => r.startsWith('Agent('))).toEqual(['Agent(buscador-fuente)', 'Agent(buscador-equidad)']);
      expect(ajustes.permissions.deny).toEqual(expect.arrayContaining(['Agent(general-purpose)', 'Agent(Explore)']));
      expect(ajustes.permissions.allow.filter((r) => r.startsWith('WebFetch'))).toEqual(['WebFetch(domain:medio.es)', 'WebFetch(domain:*.medio.es)', 'WebFetch(domain:docs.python.org)', 'WebFetch(domain:*.docs.python.org)']);
      expect(ajustes.permissions.allow).not.toContain('WebFetch');
      expect(ajustes.permissions.deny).not.toContain('WebFetch');
      expect(ajustes.permissions.deny).toEqual(expect.arrayContaining(['WebFetch(domain:github.com)', 'WebFetch(domain:elpais.com)', 'WebFetch(domain:*.elpais.com)', 'WebFetch(domain:*.otro-medio.es)', 'WebFetch(domain:abc.es)']));
      expect(ajustes.permissions.deny).not.toContain('WebFetch(domain:docs.python.org)');
    }
    expect(WEBFETCH_PREAPROBADOS).toEqual([...WEBFETCH_PREAPROBADOS].sort());
    expect(Object.values(agentes).every((a) => a.tools.every((h: string) => h === 'WebSearch' || h === 'WebFetch'))).toBe(true);
    expect(() => ajustesClaude(plantilla, valores, 'busqueda', ['*.es'])).toThrow(/host no admitido/);
  });

  it('collects the WebFetch hosts of the search pass from the registry and the equal-search tasks', () => {
    const tarea = (consultas: { texto: string; motor: string; dominios: string[] }[]) => ({ consultas }) as unknown as TareaEquidad;
    expect(
      hostsWebFetch(
        [{ hosts: ['www.medio.es', 'medio.es'] }, { hosts: ['otro.com'] }, { hosts: ['mal host'] }],
        [tarea([{ texto: 'x', motor: 'WebSearch', dominios: ['newtral.es'] }, { texto: 'maldita.es/buscar?q=x', motor: 'WebFetch', dominios: [] }])],
      ),
    ).toEqual(['maldita.es', 'medio.es', 'newtral.es', 'otro.com']);
  });
});

describe('versión de Claude Code', () => {
  it('diario.sh accepts only the version the preapproved WebFetch list was read from, unless N29_CLAUDE_VERSION_OK=1', () => {
    const sh = readFileSync(join(import.meta.dirname, '..', 'bin', 'diario.sh'), 'utf8');
    expect(sh).toContain(`CLAUDE_VERIFICADA="${CLAUDE_VERIFICADA}"`);
    expect(sh).toContain(`CLAUDE_MINIMA="${CLAUDE_VERIFICADA}"`);
    expect(sh).toMatch(/\[ "\$VERSION_CLAUDE" != "\$CLAUDE_VERIFICADA" \] && \[ "\$\{N29_CLAUDE_VERSION_OK:-0\}" != 1 \]/);
  });

  it('confines the file tools twice: --restricted and the block settings', () => {
    const plantilla = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'claude-settings.diario.template.json'), 'utf8'));
    expect(plantilla.permissions).toMatchObject({ blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true });
  });
});

describe('push y merge: solo la rama del día, nunca un merge', () => {
  const raiz = join(import.meta.dirname, '..');
  const codigo = [join(raiz, 'bin', 'diario.sh'), join(raiz, 'bin', '29n-recogida.ts'), ...readdirSync(join(raiz, 'src')).filter((f) => /\.(ts|mjs)$/.test(f) && !f.endsWith('.test.ts')).map((f) => join(raiz, 'src', f))];
  // Shell lines joined across `\` continuations, comments dropped.
  const lineas = codigo.flatMap((ruta) =>
    readFileSync(ruta, 'utf8')
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .map((linea) => ({ ruta, linea: linea.trim() }))
      .filter(({ linea }) => linea && !linea.startsWith('#') && !linea.startsWith('//') && !linea.startsWith('*')),
  );

  it('pushes only "$refspec", which is refs/heads/data/29n-diario-<fecha>, and checks it before pushing', () => {
    const pushes = lineas.filter(({ linea }) => /\bgit\b.*\bpush\b/.test(linea) || /['"]push['"]/.test(linea));
    expect(pushes.map(({ ruta }) => ruta.endsWith('diario.sh'))).toEqual([true, true]);
    for (const { linea } of pushes) {
      expect(linea).toMatch(/ push (?:"https:\/\/github\.com\/\$REPO_GH\.git"|"\$REMOTO") "\$refspec"(?:\s|\)|$)/);
      expect(linea).not.toMatch(/--force|\s-f\s|--mirror|--all|--tags|--delete|\+refs/);
    }
    const sh = readFileSync(join(raiz, 'bin', 'diario.sh'), 'utf8');
    expect(sh.match(/^\s*(?:local )?refspec=.*$/gm)!.map((l) => l.trim())).toEqual(['local refspec="refs/heads/$RAMA:refs/heads/$RAMA"']);
    expect(sh).toContain('[ "$refspec" = "refs/heads/data/29n-diario-$FECHA:refs/heads/data/29n-diario-$FECHA" ]');
    expect(sh.match(/^\s*RAMA=.*$/gm)!.map((l) => l.trim())).toEqual(['RAMA="data/29n-diario-$FECHA"']);
  });

  it('never merges, enables auto-merge, marks a PR ready or calls the GitHub API: gh only creates draft PRs', () => {
    for (const { ruta, linea } of lineas) {
      expect(linea, ruta).not.toMatch(/\bgh\s+(?:pr\s+(?:merge|ready|edit|review)|api|repo|release|workflow|run)\b|--auto\b|\bgit\b[^|;&]*\bmerge\s(?!-base)|enablePullRequestAutoMerge/);
    }
    const gh = lineas.filter(({ linea }) => /\bgh\s+pr\b/.test(linea));
    expect(gh.length).toBe(2);
    for (const { linea } of gh) expect(linea).toMatch(/gh pr create (?:--repo "\$REPO_GH" )?--draft /);
  });
});

describe('limiteBusquedasWeb', () => {
  // Every WebSearch of a session or `claude -p` turn shares one cap (default 200). The first live run
  // ran out after 10 of 36 sources: the cap must cover the whole pass, or some sources and parties go unsearched.
  const fuente = (emisor: string, terminos: number): TareaBusqueda => {
    const hosts = [`${emisor}.es`, `www.${emisor}.es`];
    const consultas = PARTIDOS.map((partido) => ({ partido, terminos: Array.from({ length: terminos }, (_, n) => `t${n}`), excluir: [] }));
    return { emisor, nombre: emisor, hosts, consultas, busquedas: consultasFuente(hosts, consultas), desde: '2026-11-08', hasta: FECHA };
  };
  const igual = (partido: PartyId, consultas: TareaEquidad['consultas']): TareaEquidad => ({
    busqueda: idDiario(FECHA, 'criticos'),
    tipo: 'criticos',
    partido,
    nombre: partido,
    periodo: { desde: '2026-11-08', hasta: FECHA },
    plantilla: 'p',
    consultas,
    salida: `equidad/criticos-${partido}.json`,
  });
  const bloqueada = { host: 'b.es', estado_http: 403, fecha: FECHA, motivo: 'HTTP 403' };
  const consultas = [
    { texto: 'a', motor: 'WebSearch', dominios: [] },
    { texto: 'b', motor: 'WebSearch', dominios: ['b.es', 'c.es'], bloqueada },
    { texto: 'c', motor: 'WebFetch', dominios: ['d.es'] },
  ];

  it('counts the worst case: each source query with its two halves, and each unblocked WebSearch query of each equal search', () => {
    expect(busquedasWebPrevistas([fuente('a', 10), fuente('b', 3)], PARTIDOS.map((p) => igual(p, consultas)))).toBe(4 * 3 + 4 * 3 + 4);
    expect(busquedasWebPrevistas([fuente('c', 1)], [])).toBe(4);
    expect(busquedasWebPrevistas([], [])).toBe(0);
  });

  it('covers the whole pass of the first live run, with one retry of every subagent', () => {
    const fuentes = Array.from({ length: 36 }, (_, n) => fuente(`f${n}`, 10));
    const iguales = PARTIDOS.flatMap((p) => [igual(p, consultas), igual(p, consultas)]);
    const previstas = busquedasWebPrevistas(fuentes, iguales);
    expect(previstas).toBe(36 * 4 * 3 + 8);
    expect(limiteBusquedasWeb('busqueda', previstas)).toBe(2 * previstas);
    expect(limiteBusquedasWeb('busqueda', previstas)).toBeGreaterThan(BUSQUEDAS_WEB_POR_DEFECTO);
  });

  it('never goes below the default, and leaves the adjudication pass at the default', () => {
    expect(BUSQUEDAS_WEB_POR_DEFECTO).toBe(200);
    expect(limiteBusquedasWeb('busqueda', 0)).toBe(200);
    expect(limiteBusquedasWeb('busqueda', 30)).toBe(200);
    expect(limiteBusquedasWeb('adjudicacion', 5000)).toBe(200);
    expect(limiteBusquedasWeb('hechos', 5000)).toBe(200);
  });
});

describe('faltasBusqueda', () => {
  const fuente = (emisor: string): TareaBusqueda => {
    const consultas = [
      { partido: 'frente-amplio', terminos: ['Frente Amplio', 'IU', 'Ada Colau'], excluir: [] },
      { partido: 'pp', terminos: ['PP', 'Feijóo'], excluir: [] },
      { partido: 'psoe', terminos: ['PSOE'], excluir: [] },
      { partido: 'vox', terminos: ['Vox'], excluir: [] },
    ];
    return { emisor, nombre: emisor, hosts: [`${emisor}.es`], consultas, busquedas: consultasFuente([`${emisor}.es`], consultas), desde: '2026-11-08', hasta: FECHA };
  };
  type Hecha = { partido: string; texto: string; estado: string; resultados?: number; subconsultas?: unknown[] };
  const respuestaFuente = (tarea: TareaBusqueda, cambiar = (c: Hecha): Hecha => c): Respuesta => ({
    contenido: { emisor: tarea.emisor, candidatos: [], consultas: tarea.busquedas.map((b) => cambiar({ partido: b.partido, texto: b.texto, estado: 'ok', resultados: 0 })), nota: '' },
  });
  const bloqueada = { host: 'b.es', estado_http: 403, fecha: FECHA, motivo: 'HTTP 403' };
  const tipos = ['criticos', 'defensores', 'bulos', 'causas'] as const;
  const iguales: TareaEquidad[] = tipos.flatMap((tipo) =>
    PARTIDOS.map((partido) => ({
      busqueda: idDiario(FECHA, tipo),
      tipo,
      partido,
      nombre: partido,
      periodo: { desde: '2026-11-08', hasta: FECHA },
      plantilla: 'p',
      consultas: [
        { texto: `${partido} ${tipo}`, motor: 'WebSearch', dominios: [] },
        { texto: `${partido} ${tipo} b`, motor: 'WebSearch', dominios: ['b.es'], ...(tipo === 'bulos' ? { bloqueada } : {}) },
      ],
      salida: `equidad/${tipo}.${partido}.json`,
    })),
  );
  const respuestaIgual = (tarea: TareaEquidad): Respuesta => ({
    contenido: { resultados: [], consultas: tarea.consultas.map((c) => ({ texto: c.texto, estado: c.bloqueada ? 'bloqueada' : 'ok', resultados: 0 })) },
  });
  const [fuenteA, fuenteB] = [fuente('a'), fuente('b')];
  const fuentes = [fuenteA, fuenteB];
  const base = {
    fuentes,
    porFuente: (emisor: string) => respuestaFuente(fuentes.find((f) => f.emisor === emisor)!),
    iguales,
    porIgual: respuestaIgual,
  };

  it('is empty when every source term and every unblocked equal query ran', () => {
    expect(faltasBusqueda(base)).toEqual([]);
  });

  it('checks an atrasos task at its own answer file, next to the same source\'s day task', () => {
    const atrasos: TareaBusqueda = { ...fuenteA, desde: '2026-10-05', hasta: '2026-11-08', nota: 'Atrasos: devuelve solo lo publicado del 2026-10-05 al 2026-11-08.', salida: 'busqueda/a.atrasos.json' };
    const vistas: string[] = [];
    const porFuente = (emisor: string, tarea: TareaBusqueda): Respuesta => {
      vistas.push(tarea.salida ?? `busqueda/${emisor}.json`);
      return tarea.salida ? undefined : respuestaFuente(tarea);
    };
    const revision = revisarBusqueda({ ...base, fuentes: [fuenteA, atrasos], porFuente });
    expect(vistas).toEqual(['busqueda/a.json', 'busqueda/a.atrasos.json']);
    expect(revision.faltas).toEqual(['busqueda/a.atrasos.json: falta']);
    expect(revision.reintentables.fuentes).toEqual([atrasos]);
    expect(faltasBusqueda({ ...base, fuentes: [fuenteA, atrasos], porFuente: (_e, tarea) => respuestaFuente(tarea) })).toEqual([]);
    // A retry round with the atrasos task: its own file in reintento-rutas.txt, and its searches counted against the retry session.
    expect(rutasReintento(revision.reintentables)).toEqual(['busqueda/a.atrasos.json']);
    expect(textoRutasReintento(rutasReintento(revision.reintentables))).toBe('./busqueda/a.atrasos.json\n./busqueda/a.atrasos.json.error.txt\n');
    const reintento = { fuentes: ['busqueda/a.atrasos.json'], iguales: [] };
    const todas = { ...base, fuentes: [fuenteA, atrasos], porFuente: (_e: string, tarea: TareaBusqueda) => respuestaFuente(tarea) };
    // Pass 1: a (4) + 16 equal searches × their unblocked queries (28) = 32; the retry: the atrasos task's 4.
    expect(faltasBusqueda({ ...todas, busquedasReales: 32, reintento: { ...reintento, busquedasReales: 4 } })).toEqual([]);
    expect(faltasBusqueda({ ...todas, busquedasReales: 32, reintento: { ...reintento, busquedasReales: 3 } })).toEqual([
      'claude/busqueda-reintento.salida-*.json: las respuestas reintentadas declaran 4 búsquedas web hechas, pero Claude Code registró 3',
    ]);
    // The day task of the same source is not counted as retried: only its own path is.
    expect(faltasBusqueda({ ...todas, busquedasReales: 31, reintento: { ...reintento, busquedasReales: 500 } })).toHaveLength(1);
    // Only the atrasos file name is accepted as another answer path.
    expect(faltasBusqueda({ ...base, fuentes: [{ ...atrasos, salida: '../fuera.json' }] })).toEqual(['descubrir.json: la tarea de a tiene una salida no admitida (../fuera.json)']);
  });

  it('lists a missing source answer, one that is not JSON, and one without the consultas list', () => {
    const porFuente = (emisor: string): Respuesta => (emisor === 'a' ? undefined : { error: true });
    expect(faltasBusqueda({ ...base, porFuente })).toEqual(['busqueda/a.json: falta', 'busqueda/b.json: la respuesta no es JSON (busqueda/b.json.error.txt)']);
    expect(faltasBusqueda({ ...base, porFuente: () => ({ contenido: { emisor: 'a', candidatos: [], nota: 'ok' } }) })).toEqual([
      'busqueda/a.json: sin las listas candidatos y consultas',
      'busqueda/b.json: sin las listas candidatos y consultas',
    ]);
  });

  it('lists every planned query not searched, as in the first live run, whatever the nota says', () => {
    const parcial = respuestaFuente(fuenteB, (c) => (c.partido === 'frente-amplio' ? c : { ...c, estado: 'no_buscado' }));
    const sinUno = respuestaFuente(fuenteA, (c) => (c.partido === 'pp' ? { ...c, partido: 'vox' } : c));
    const sinNumero = respuestaFuente(fuenteA, (c) => (c.partido === 'psoe' ? { partido: c.partido, texto: `  ${c.texto} `, estado: 'ok' } : c));
    expect(faltasBusqueda({ ...base, porFuente: (emisor) => (emisor === 'a' ? sinUno : parcial) })).toEqual([
      'busqueda/a.json: pp «site:a.es ("PP" OR "Feijóo")» sin buscar',
      'busqueda/b.json: pp «site:b.es ("PP" OR "Feijóo")» sin buscar (no_buscado)',
      'busqueda/b.json: psoe «site:b.es ("PSOE")» sin buscar (no_buscado)',
      'busqueda/b.json: vox «site:b.es ("Vox")» sin buscar (no_buscado)',
    ]);
    expect(faltasBusqueda({ ...base, fuentes: [fuenteA], porFuente: () => sinNumero })).toEqual(['busqueda/a.json: psoe «site:a.es ("PSOE")» sin número de resultados (entero mayor o igual que 0)']);
    for (const resultados of [-1, 2.5, '3']) {
      const raro = respuestaFuente(fuenteA, (c) => (c.partido === 'vox' ? ({ ...c, resultados } as unknown as Hecha) : c));
      expect(faltasBusqueda({ ...base, fuentes: [fuenteA], porFuente: () => raro }), String(resultados)).toEqual(['busqueda/a.json: vox «site:a.es ("Vox")» sin número de resultados (entero mayor o igual que 0)']);
    }
    expect(faltasBusqueda({ ...base, fuentes: [{ ...fuenteA, busquedas: [] }] })).toEqual(['descubrir.json: la tarea de a no tiene búsquedas']);
  });

  it('marks the tasks another session may redo, whatever their party, and the gaps it cannot fix', () => {
    const porIgual = (tarea: TareaEquidad): Respuesta => (tarea.tipo === 'causas' && tarea.partido === 'psoe' ? { error: true } : respuestaIgual(tarea));
    const porFuente = (emisor: string): Respuesta => (emisor === 'b' ? undefined : respuestaFuente(fuenteA));
    const revision = revisarBusqueda({ ...base, porFuente, porIgual });
    expect(revision.reintentables.fuentes.map((t) => t.emisor)).toEqual(['b']);
    // One party's equal search failed: the four parties of that kind are redone together.
    expect(revision.reintentables.iguales.map((t) => t.salida)).toEqual(PARTIDOS.map((p) => `equidad/causas.${p}.json`));
    expect(revision.reintentables.iguales[1]).toBe(iguales.find((t) => t.salida === 'equidad/causas.pp.json'));
    expect(revision.definitivas).toEqual([]);
    expect(revision.faltas).toEqual(['busqueda/b.json: falta', 'equidad/causas.psoe.json: la respuesta no es JSON (equidad/causas.psoe.json.error.txt)']);
    const sinVox = iguales.filter((t) => !(t.tipo === 'defensores' && t.partido === 'vox'));
    expect(revisarBusqueda({ ...base, iguales: sinVox, busquedasReales: 1 }).definitivas).toEqual([
      'equidad: defensores sin tarea para vox',
      'claude/busqueda.salida-*.json: las respuestas de la pasada declaran 34 búsquedas web hechas, pero Claude Code registró 1',
    ]);
  });

  it('fails, without retry, when the four parties of a kind do not have the same blocked queries', () => {
    const distinto = iguales.map((t) => (t.tipo === 'criticos' && t.partido === 'vox' ? { ...t, consultas: t.consultas.map((c, i) => (i === 1 ? { ...c, bloqueada } : c)) } : t));
    const revision = revisarBusqueda({ ...base, iguales: distinto, porIgual: (t) => respuestaIgual(t) });
    expect(revision.definitivas).toEqual(['equidad: criticos no tiene las mismas consultas bloqueadas para los cuatro partidos']);
  });

  it('keeps only equal-search results dated on or before the run date', () => {
    expect(enPeriodo('2026-11-10', '2026-11-10')).toBe(true);
    expect(enPeriodo('2026-11-08', '2026-11-10')).toBe(true);
    expect(enPeriodo('2026-11-11', '2026-11-10')).toBe(false);
    for (const raro of [undefined, null, '', '10/11/2026', '2026-11-10T09:00', 20261110]) expect(enPeriodo(raro, '2026-11-10')).toBe(false);
  });

  it('accepts a saved answer only if it is valid JSON with nothing but whitespace around it', () => {
    expect(respuestaAceptable('{"a": 1}')).toBe(true);
    expect(respuestaAceptable('  {"a": 1}\n\n\t ')).toBe(true);
    // The 11 Nov case: valid JSON followed by "]}".
    expect(respuestaAceptable('{"a": [1]}]}\n')).toBe(false);
    expect(respuestaAceptable('```json\n{"a": 1}\n```')).toBe(false);
    expect(respuestaAceptable('{"a": 1} texto')).toBe(false);
    expect(respuestaAceptable('')).toBe(false);
  });

  it('needs exactly one planned query per party in every source task', () => {
    const sinVox = { ...fuenteA, busquedas: fuenteA.busquedas.filter((b) => b.partido !== 'vox') };
    const ppDoble = { ...fuenteA, busquedas: [...fuenteA.busquedas, fuenteA.busquedas[1]!] };
    expect(faltasBusqueda({ ...base, fuentes: [sinVox, ppDoble] })).toEqual([
      'descubrir.json: la tarea de a no tiene exactamente una búsqueda por partido (frente-amplio 1, pp 1, psoe 1, vox 0)',
      'descubrir.json: la tarea de a no tiene exactamente una búsqueda por partido (frente-amplio 1, pp 2, psoe 1, vox 1)',
    ]);
  });

  it('fails when the answers declare more web searches than Claude Code counted, and skips the check without a count', () => {
    // Declared: 4 queries × 2 sources, plus 4 parties × (2 + 2 + 2 + 1 unblocked queries: one bulos query is blocked) = 8 + 28 = 36.
    expect(faltasBusqueda({ ...base, busquedasReales: 36 })).toEqual([]);
    expect(faltasBusqueda({ ...base, busquedasReales: 203 })).toEqual([]);
    expect(faltasBusqueda({ ...base, busquedasReales: 35 })).toEqual(['claude/busqueda.salida-*.json: las respuestas de la pasada declaran 36 búsquedas web hechas, pero Claude Code registró 35']);
    // After a retry, each session's answers are checked against that session's own count.
    const reintento = { fuentes: ['b'], iguales: PARTIDOS.map((p) => `equidad/causas.${p}.json`) };
    // Retried: source b (4) + causas × 4 parties × 2 queries (8) = 12; pass 1: the other 24.
    expect(faltasBusqueda({ ...base, busquedasReales: 24, reintento: { ...reintento, busquedasReales: 12 } })).toEqual([]);
    expect(faltasBusqueda({ ...base, busquedasReales: 24, reintento: { ...reintento, busquedasReales: 11 } })).toEqual([
      'claude/busqueda-reintento.salida-*.json: las respuestas reintentadas declaran 12 búsquedas web hechas, pero Claude Code registró 11',
    ]);
    // A large retry count does not cover answers that came from pass 1.
    expect(faltasBusqueda({ ...base, busquedasReales: 23, reintento: { ...reintento, busquedasReales: 500 } })).toHaveLength(1);
    expect(faltasBusqueda({ ...base, busquedasReales: undefined })).toEqual([]);
    const salida = { usage: { server_tool_use: { web_search_requests: 0 } }, modelUsage: { 'claude-opus-5-5': { webSearchRequests: 0 }, 'claude-haiku-5-5': { webSearchRequests: 203 } } };
    expect(busquedasRegistradas(salida)).toBe(203);
    expect(busquedasRegistradas({ modelUsage: { x: { costUSD: 1 } } })).toBeUndefined();
    expect(busquedasRegistradas({ result: 'sin uso' })).toBeUndefined();
  });

  it('needs both halves of a saturated query, and nothing more from a single-term query', () => {
    const saturada = (c: Hecha): Hecha => ({ ...c, resultados: RESULTADOS_SATURACION });
    expect(faltasBusqueda({ ...base, fuentes: [fuenteA], porFuente: () => respuestaFuente(fuenteA, (c) => (c.partido === 'pp' || c.partido === 'vox' ? saturada(c) : c)) })).toEqual([
      'busqueda/a.json: pp «site:a.es ("PP")» sin buscar (mitad de una consulta saturada)',
      'busqueda/a.json: pp «site:a.es ("Feijóo")» sin buscar (mitad de una consulta saturada)',
    ]);
    const conMitades = (c: Hecha): Hecha => {
      const plan = fuenteA.busquedas.find((b) => b.partido === c.partido)!;
      return plan.mitades ? { ...saturada(c), subconsultas: plan.mitades.map((texto) => ({ texto, estado: 'ok', resultados: 3 })) } : saturada(c);
    };
    expect(faltasBusqueda({ ...base, fuentes: [fuenteA], porFuente: () => respuestaFuente(fuenteA, conMitades) })).toEqual([]);
    // The halves count as searches done: 4 queries + 2 halves for frente-amplio and pp, plus 28 equal queries = 36.
    expect(faltasBusqueda({ ...base, fuentes: [fuenteA], porFuente: () => respuestaFuente(fuenteA, conMitades), busquedasReales: 36 })).toEqual([]);
    expect(faltasBusqueda({ ...base, fuentes: [fuenteA], porFuente: () => respuestaFuente(fuenteA, conMitades), busquedasReales: 35 })).toHaveLength(1);
    expect(fuenteA.busquedas.find((b) => b.partido === 'frente-amplio')!.mitades).toEqual(['site:a.es ("Frente Amplio" OR "IU")', 'site:a.es ("Ada Colau")']);
    expect(faltasBusqueda({ ...base, fuentes: [fuenteA], porFuente: () => respuestaFuente(fuenteA, (c) => ({ ...c, resultados: RESULTADOS_SATURACION - 1 })) })).toEqual([]);
  });

  it('lists a missing or incomplete equal search, and a kind without its four parties', () => {
    const porIgual = (tarea: TareaEquidad): Respuesta => {
      if (tarea.tipo === 'causas' && tarea.partido === 'vox') return undefined;
      if (tarea.tipo === 'criticos' && tarea.partido === 'pp') {
        return { contenido: { resultados: [], consultas: [{ texto: tarea.consultas[0]!.texto, estado: 'ok' }, { texto: tarea.consultas[1]!.texto, estado: 'error' }] } };
      }
      return respuestaIgual(tarea);
    };
    const sinVox = iguales.filter((t) => !(t.tipo === 'defensores' && t.partido === 'vox'));
    expect(faltasBusqueda({ ...base, iguales: sinVox, porIgual })).toEqual([
      'equidad: defensores sin tarea para vox',
      'equidad/criticos.pp.json: incompleta (consulta 2 «pp criticos b»: error)',
      'equidad/causas.vox.json: falta',
    ]);
  });

  it('needs no answer for an equal search with every query blocked', () => {
    const todasBloqueadas = iguales.map((t) => (t.tipo === 'bulos' ? { ...t, consultas: t.consultas.map((c) => ({ ...c, bloqueada })) } : t));
    expect(faltasBusqueda({ ...base, iguales: todasBloqueadas, porIgual: (t) => (t.tipo === 'bulos' ? undefined : respuestaIgual(t)) })).toEqual([]);
  });
});

describe('informe: clasificaciones que faltan', () => {
  it('lists them per party', () => {
    expect(informe({ fecha: FECHA, etapas: '', sinClasificar: { pp: ['a', 'b'] } })).toContain('- pp: a, b');
  });
});

describe('fuentesEsperadas (alcance-fuentes)', () => {
  const antes = { meta: 1, emisores: [{ id: 'medio', nombre: 'Medio', hosts: ['medio.es'], tipo: 'medio', recogida: { metodo: 'rss', url: 'https://medio.es/rss' } }] };
  const veto: VetoGuia = { tipo: 'robots', host: 'medio.es', consultado: FECHA, url: 'https://medio.es/a', evidencia: 'User-agent: Claude-User · Disallow: /', robots: 'https://medio.es/robots.txt', agentes: ['Claude-User'] };
  it('accepts exactly what fuentes-bloqueo writes, or no change', () => {
    const escrito = JSON.parse(JSON.stringify(registrarBloqueos(antes as never, [veto], FECHA).registro));
    expect(fuentesEsperadas(antes, escrito, [veto], FECHA)).toEqual([]);
    expect(fuentesEsperadas(antes, structuredClone(antes), [veto], FECHA)).toEqual([]);
  });
  it('refuses a bloqueo the day\'s vetos do not explain, even with the right shape', () => {
    const escrito = JSON.parse(JSON.stringify(registrarBloqueos(antes as never, [veto], FECHA).registro));
    expect(fuentesEsperadas(antes, escrito, [], FECHA)).toHaveLength(1);
    escrito.emisores[0].bloqueo.agentes = ['Claude-User', 'Claude-SearchBot'];
    expect(fuentesEsperadas(antes, escrito, [veto], FECHA)).toHaveLength(1);
  });
});
