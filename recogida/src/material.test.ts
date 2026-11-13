import { describe, expect, it } from 'vitest';
import type { Alias, Emisor, TareaBusqueda } from './descubrir.ts';
import type { TareaClasificar, TareaEquidad } from './diario.ts';
import {
  MAX_DOCUMENTO,
  bloqueDocumento,
  busquedasDelPartido,
  eventoDe,
  extractoNeutral,
  fichaResumida,
  hechosPublicados,
  llamadasBusqueda,
  perfilResumido,
  promptClasificacion,
  bloquesDocumento,
  fichaCompacta,
  promptsAdjudicacion,
  promptsBusqueda,
  promptsHechos,
  respuestasQueCuentan,
  terminosNeutrales,
  textoDocumento,
  type MaterialAdjudicacion,
} from './material.ts';

const alias = (nombres: string[], personas: string[]): Alias => ({ nombres, marcas_regionales: [], miembros: [], personas, excluir: [] });
const ALIAS = { 'frente-amplio': alias(['Frente Amplio'], ['Maíllo']), pp: alias(['Partido Popular'], ['Feijóo']), psoe: alias(['PSOE'], ['Sánchez']), vox: alias(['Vox'], ['Abascal']) };
const TERMINOS = terminosNeutrales(ALIAS);
const FUENTES = [{ id: 'medio', nombre: 'Medio', hosts: ['medio.es'], tipo: 'medio' }] as Emisor[];

const FICHA = {
  id: 'pp',
  corte: '2026-11-09',
  tarjeta: { candidato: 'Persona Dos', lema: 'El cambio', fuente_lema: 'https://medio.es/lema', que_propone: 'x' },
  pendientes: ['Debate del 16 de noviembre.'],
  descartados: [{ ref: '5', estado: 'NO VERIFICABLE', motivo: 'No reproducible.', texto: 'largo' }],
  secciones: [
    { id: 'temas', items: [{ ref: '1', texto: 'Propone A.', estado: 'PARCIAL', matiz: 'Según Medio.', fuentes: [{ url: 'https://medio.es/a', medio: 'Medio' }] }] },
    { id: 'encuestas', items: [{ ref: '2', texto: 'Encuesta B.', estado: 'VERIFICADO', hecho: 'encuesta-b', fuentes: [{ url: 'https://medio.es/b', medio: 'Medio' }] }] },
    { id: 'criticos-defensores', items: [{ ref: '3', texto: 'Critica C.', estado: 'PARCIAL', postura: 'critico', busqueda: 'diario-2026-11-09-criticos', fuentes: [{ url: 'https://medio.es/c', medio: 'Medio' }] }] },
  ],
  en_espera: [{ ref: '4', seccion: 'criticos-defensores', texto: 'Defiende D.', estado: 'PARCIAL', fuentes: [] }],
};

describe('textos: nada se recorta por longitud', () => {
  it('keeps every document up to MAX_DOCUMENTO whole, and reduces a longer one to the same party-neutral excerpt, recorded', () => {
    const corto = { id: 'a', meta: { url: 'https://medio.es/a', via: 'rss' }, texto: 'x'.repeat(120_000) };
    expect(textoDocumento(corto, TERMINOS)).toEqual({ texto: corto.texto });
    const relleno = 'lorem ipsum '.repeat(30_000);
    const largo = { id: 'b', meta: { url: 'https://medio.es/b', via: 'web' }, texto: `TITULAR\n${relleno}Dijo Sánchez que sí.${relleno}El PSOE votó.${relleno}Habló FEIJOO.${relleno}` };
    expect(largo.texto.length).toBeGreaterThan(MAX_DOCUMENTO);
    const { texto, recorte } = textoDocumento(largo, TERMINOS);
    expect(texto).toContain('TITULAR');
    expect(texto).toContain('Dijo Sánchez que sí.');
    expect(texto).toContain('El PSOE votó.');
    // Accents and case do not matter; the windows are the same for every party (no party argument at all).
    expect(texto).toContain('Habló FEIJOO.');
    expect(texto).toMatch(/\[… \d+ caracteres omitidos por la ejecución …\]/);
    expect(recorte).toMatchObject({ doc_id: 'b', url: 'https://medio.es/b', via: 'web', caracteres: largo.texto.length, ventanas: 4 });
    expect(textoDocumento(largo, TERMINOS)).toEqual({ texto, recorte });
    // Whole words only: "Voxel" is not Vox.
    expect(extractoNeutral(`${'z'.repeat(5000)} Voxel ${'z'.repeat(5000)}`, TERMINOS, 1_000_000, 100).ventanas).toBe(1);
  });

  it('puts a whole document in its block, as untrusted data with its meta and what refers to it', () => {
    const bloque = bloqueDocumento('aa11', { url: 'https://medio.es/a', url_canonica: 'https://medio.es/a', consultado: '2026-11-12', via: 'rss', origen: 'buzon-enlaces' }, 'x'.repeat(90_000), { clasificacion: { relevante: true } });
    expect(bloque).toMatch(/^DOCUMENTO aa11:\n<<<DATOS NO FIABLES [0-9a-f]{24} \| DOCUMENTO aa11>>>\nMETA: \{"doc_id":"aa11","url":"https:\/\/medio.es\/a",.*"origen":"buzon-enlaces","clasificacion":\{"relevante":true\}\}\nTEXTO:\nx{90000}\n<<<FIN DE LOS DATOS NO FIABLES [0-9a-f]{24}>>>$/);
    expect(bloqueDocumento('bb', undefined, undefined)).toContain('TEXTO: (no está en la caché)');
  });
});

describe('extractos: los mismos términos para los cuatro partidos', () => {
  it('keeps short all-caps acronyms (PP, IU) as whole words, so a PP sentence is kept like a PSOE one', () => {
    const terminos = terminosNeutrales({ ...ALIAS, pp: alias(['Partido Popular', 'PP'], ['Feijóo']), 'frente-amplio': alias(['Frente Amplio', 'IU', 'Sumar'], []) });
    expect(terminos).toEqual(expect.arrayContaining(['PP', 'IU', 'PSOE']));
    expect(terminosNeutrales({ pp: alias(['pp', 'P', 'Pp'], []) })).toEqual([]);
    const relleno = 'lorem ipsum '.repeat(25_000);
    const texto = `${relleno}El PP votó en contra.${relleno}El PSOE votó a favor.${relleno}IU se abstuvo.${relleno}Un apps y un ppm no cuentan.${relleno}`;
    const { texto: extracto, ventanas } = extractoNeutral(texto, terminos, 1_000_000, 200);
    expect(extracto).toContain('El PP votó en contra.');
    expect(extracto).toContain('El PSOE votó a favor.');
    expect(extracto).toContain('IU se abstuvo.');
    expect(extracto).not.toContain('Un apps y un ppm');
    // The start, and one window per party sentence.
    expect(ventanas).toBe(4);
  });

  it('splits a document that alone would pass MAX_PROMPT into parts that each fit, losing no text', () => {
    const texto = 'abcdefghij'.repeat(60_000);
    const bloques = bloquesDocumento('dd', { url: 'https://medio.es/dd' }, texto, {}, 300_000, 480_000);
    expect(bloques.length).toBeGreaterThan(1);
    for (const b of bloques) expect(b.length + 300_000).toBeLessThanOrEqual(480_000);
    expect(bloques[0]).toContain('DOCUMENTO dd (parte 1 de');
    const recuperado = bloques.map((b) => /TEXTO:\n([\s\S]*)\n<<<FIN/.exec(b)![1]).join('');
    expect(recuperado).toBe(texto);
    expect(bloquesDocumento('dd', undefined, 'corto', {}, 300_000)).toHaveLength(1);
  });
});

describe('resúmenes de la ficha, el perfil, las búsquedas y los hechos', () => {
  it('keeps the card, pending matters, discarded items and the chosen sections of a sheet', () => {
    const todo = fichaResumida(FICHA);
    expect(todo).toMatchObject({
      id: 'pp',
      tarjeta: { candidato: 'Persona Dos', lema: 'El cambio', fuente_lema: 'https://medio.es/lema' },
      pendientes: ['Debate del 16 de noviembre.'],
      descartados: [{ ref: '5', estado: 'NO VERIFICABLE', motivo: 'No reproducible.' }],
      secciones_incluidas: 'todas',
    });
    expect((todo.tarjeta as object)).not.toHaveProperty('que_propone');
    expect((todo.items as { ref: string }[]).map((i) => i.ref)).toEqual(['1', '2', '3']);
    expect(todo.items).toContainEqual({ ref: '1', seccion: 'temas', texto: 'Propone A.', estado: 'PARCIAL', matiz: 'Según Medio.', fuentes: ['https://medio.es/a'] });
    const solo = fichaResumida(FICHA, new Set(['criticos-defensores']));
    expect((solo.items as { ref: string }[]).map((i) => i.ref)).toEqual(['3']);
    expect((solo.en_espera as { ref: string }[]).map((i) => i.ref)).toEqual(['4']);
    expect(solo.descartados).toEqual(todo.descartados);
    expect(fichaResumida(undefined)).toEqual({});
  });

  it('keeps the perfil limits and its documents, proposals and messages', () => {
    const perfil = { partido: 'pp', periodo: { desde: '2026-10-05', hasta: '2026-11-09' }, limites: ['Solo documentos propios.'], documentos: [{ id: 'pp-d1', titulo: 'Programa', url: 'https://pp.es/p.pdf', procedencia: { via: 'web' } }], propuestas: [{ id: 'pp-p1', texto: 'X', documentos: ['pp-d1'], cita: { texto: 'y' } }], mensajes: [] };
    expect(perfilResumido(perfil)).toEqual({ partido: 'pp', periodo: perfil.periodo, limites: ['Solo documentos propios.'], documentos: [{ id: 'pp-d1', titulo: 'Programa', url: 'https://pp.es/p.pdf' }], propuestas: [{ id: 'pp-p1', texto: 'X', documentos: ['pp-d1'] }], mensajes: [] });
    expect(perfilResumido(null)).toBeUndefined();
  });

  it('gives each party the searches of busquedas.json with only its own counts, notes and findings', () => {
    const registro = { busquedas: [{ id: 'diario-2026-11-09-criticos', tipo: 'criticos', fecha: '2026-11-09', periodo: {}, consultas: [{ plantilla: 'x {partido}', motor: 'WebSearch', dominios: [], terminos: { pp: 'Feijóo' } }], resultados: { pp: 1, vox: 2 }, notas: { vox: 'nota vox' }, hallazgos: { pp: [{ url: 'https://medio.es/c', publicado: ['3'] }], vox: [] } }] };
    expect(busquedasDelPartido(registro, 'pp')).toEqual([{ id: 'diario-2026-11-09-criticos', tipo: 'criticos', fecha: '2026-11-09', periodo: {}, consultas: [{ plantilla: 'x {partido}', motor: 'WebSearch', dominios: [] }], resultados: 1, hallazgos: [{ url: 'https://medio.es/c', publicado: ['3'] }] }]);
    expect(busquedasDelPartido(registro, 'vox')[0]).toMatchObject({ resultados: 2, nota_partido: 'nota vox', hallazgos: [] });
  });

  it('lists each published shared fact once, with every party that carries it', () => {
    const otra = { ...FICHA, id: 'vox', secciones: [{ id: 'encuestas', items: [{ ref: '9', texto: 'Encuesta B.', estado: 'VERIFICADO', hecho: 'encuesta-b', fuentes: [{ url: 'https://medio.es/b' }] }] }] };
    expect(hechosPublicados({ pp: FICHA, vox: otra })).toEqual([{ hecho: 'encuesta-b', seccion: 'encuestas', texto: 'Encuesta B.', estado: 'VERIFICADO', fuentes: ['https://medio.es/b'], partidos: ['pp', 'vox'] }]);
  });
});

const tarea = (doc_id: string, partido: string): TareaClasificar => ({ doc_id, partido, url: `https://medio.es/${doc_id}`, url_canonica: `https://medio.es/${doc_id}`, via: 'rss', consultado: '2026-11-12', origen: ['alias'], texto: '/t', meta: '/m', salida: `clasificacion/${doc_id}.${partido}.json` }) as TareaClasificar;

describe('lotes de los juicios', () => {
  it('puts each classification document once in its batch, whole, after the tasks', () => {
    const docs = new Map([['aa', { id: 'aa', meta: { url: 'https://medio.es/aa' }, texto: 'y'.repeat(70_000) }]]);
    const { prompts, lotes, recortes } = promptClasificacion('BASE', [tarea('aa', 'pp'), tarea('aa', 'vox')], docs, TERMINOS);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.split('DOCUMENTO aa:').length).toBe(2);
    expect(prompts[0]).toContain('y'.repeat(70_000));
    // TAREAS is the script's own JSON, not delimited; the document is.
    expect(prompts[0]).toMatch(/TAREAS \(JSON\):\n\[\{"doc_id":"aa","partido":"pp"/);
    expect(lotes).toEqual([{ documentos: ['aa'], caracteres: prompts[0]!.length }]);
    expect(recortes).toEqual([]);
  });

  it('batches shared facts by event: an event never split unless it alone does not fit', () => {
    const c = (pregunta: string, seccion: string, tema: string, relevante = true) => ({ relevante, pregunta, seccion, tema, hecho_compartido: true });
    expect(eventoDe([c('Q7', 'encuestas', 'POL'), c('Q7', 'encuestas', 'POL'), c('Q1', 'candidatura', 'POL')])).toBe('Q7/encuestas/POL');
    expect(eventoDe([c('Q2', 'temas', 'VIV'), c('Q1', 'candidatura', 'POL', false)])).toBe('Q2/temas/VIV');
    const doc = (id: string, ...cl: object[]) => ({ id, meta: { url: `https://medio.es/${id}` }, texto: 'z'.repeat(40_000), clasificaciones: cl as Record<string, unknown>[] });
    const candidatos = [doc('e1', c('Q7', 'encuestas', 'POL')), doc('d1', c('Q2', 'temas', 'VIV')), doc('e2', c('Q7', 'encuestas', 'POL')), doc('d2', c('Q2', 'temas', 'VIV')), doc('e3', c('Q7', 'encuestas', 'POL'))];
    const r = promptsHechos('BASE', { fuentes: FUENTES, publicados: [], candidatos, terminos: TERMINOS }, 150_000);
    expect(r.lotes.map((l) => [l.grupos, l.documentos])).toEqual([
      [['Q2/temas/VIV'], ['d1', 'd2']],
      [['Q7/encuestas/POL'], ['e1', 'e2']],
      [['Q7/encuestas/POL'], ['e3']],
    ]);
    // The event of three polls (120 000 characters, plus the room kept for earlier facts) is the only one split, because it does not fit alone.
    const amplio = promptsHechos('BASE', { fuentes: FUENTES, publicados: [], candidatos, terminos: TERMINOS }, 180_000);
    expect(amplio.lotes.map((l) => l.documentos)).toEqual([['d1', 'd2'], ['e1', 'e2', 'e3']]);
    expect(r.prompts.every((p) => p.includes('HECHOS PUBLICADOS:\n<<<DATOS NO FIABLES'))).toBe(true);
    expect(promptsHechos('BASE', { fuentes: FUENTES, publicados: [], candidatos, terminos: TERMINOS }, 150_000)).toEqual(r);
  });

  const material = (documentos: MaterialAdjudicacion['documentos'], resultadosSueltos: Record<string, unknown>[] = []): MaterialAdjudicacion => ({
    partido: 'pp',
    criterios: '### preguntas.md\nCriterio.',
    ficha: FICHA,
    perfil: undefined,
    fuentes: FUENTES,
    busquedas: { busquedas: [] },
    hechos: { hechos: [] },
    documentos,
    resultadosSueltos,
    terminos: TERMINOS,
  });

  it('starts every adjudication batch with the same context, the whole sheet in one line per item included', () => {
    const docs: MaterialAdjudicacion['documentos'] = ['a1', 'a2', 'a3'].map((id, n) => ({ id, meta: { url: `https://medio.es/${id}` }, texto: 'q'.repeat(70_000), clasificacion: { relevante: true, seccion: ['temas', 'encuestas', 'cambios'][n] }, resultados: [] }));
    const r = promptsAdjudicacion('BASE', material(docs), 120_000);
    expect(r.prompts.length).toBe(3);
    const comun = r.lotes[0]!.comun!;
    expect(r.lotes.every((l) => l.comun === comun)).toBe(true);
    for (const p of r.prompts) expect(p.slice(0, comun)).toBe(r.prompts[0]!.slice(0, comun));
    expect(r.prompts[0]!.slice(0, comun)).toMatch(/CRITERIOS:[\s\S]*FUENTES \(JSON\)[\s\S]*BUSQUEDAS:[\s\S]*HECHOS:[\s\S]*FICHA COMPLETA EN UNA LÍNEA POR ELEMENTO:/);
    // Every batch knows every item of the sheet by ref, section and URL, even of sections it does not touch.
    for (const p of r.prompts) for (const ref of ['"ref":"1","seccion":"temas"', '"ref":"2","seccion":"encuestas"', '"ref":"3","seccion":"criticos-defensores"', '"ref":"4","seccion":"criticos-defensores","en_espera":true']) expect(p).toContain(ref);
    expect(fichaCompacta(FICHA)).toContainEqual({ ref: '2', seccion: 'encuestas', fuentes: ['https://medio.es/b'], hecho: 'encuesta-b' });
  });

  it('puts each document and each equal-search result of a party in exactly one adjudication batch, with only the sheet sections it touches', () => {
    const res = (url: string, tipo: string) => ({ url, tipo, busqueda: `diario-2026-11-12-${tipo}`, quien: 'X' });
    const docs: MaterialAdjudicacion['documentos'] = [
      { id: 'a1', meta: { url: 'https://medio.es/a1' }, texto: 't'.repeat(60_000), clasificacion: { relevante: true, seccion: 'temas' }, resultados: [] },
      { id: 'c1', meta: { url: 'https://medio.es/c1' }, texto: 'c'.repeat(60_000), clasificacion: { relevante: true, seccion: 'criticos-defensores' }, resultados: [res('https://medio.es/c1', 'criticos')] },
      { id: 'c2', meta: { url: 'https://medio.es/c2' }, texto: 'd'.repeat(60_000), resultados: [res('https://medio.es/c2', 'defensores'), res('https://medio.es/c2', 'criticos')] },
      { id: 'n1', meta: { url: 'https://medio.es/n1' }, texto: 'n'.repeat(60_000), clasificacion: { relevante: false, seccion: null }, resultados: [] },
    ];
    const r = promptsAdjudicacion('BASE', material(docs, [res('https://otro.es/x', 'bulos')]), 140_000);
    const vistos = r.lotes.flatMap((l) => l.resultados ?? []);
    expect(vistos.sort()).toEqual(['https://medio.es/c1', 'https://medio.es/c2', 'https://otro.es/x']);
    expect(new Set(vistos).size).toBe(vistos.length);
    expect(r.lotes.flatMap((l) => l.documentos).sort()).toEqual(['a1', 'c1', 'c2', 'n1']);
    // Each result travels in the batch of its document; the batches carry only the sections they touch.
    const deC2 = r.lotes.findIndex((l) => l.documentos.includes('c2'));
    expect(r.lotes[deC2]!.resultados).toContain('https://medio.es/c2');
    expect(r.prompts[deC2]!.split('"url":"https://medio.es/c2","tipo"').length).toBe(3);
    for (const [n, lote] of r.lotes.entries()) {
      const prompt = r.prompts[n]!;
      expect(prompt).toContain('FICHA:\n<<<DATOS NO FIABLES');
      expect(prompt).toContain('"secciones_incluidas"');
      // Full text of items only for the sections the batch touches (the one-line list has no text).
      if (!lote.secciones!.includes('temas')) expect(prompt).not.toContain('Propone A.');
      if (!lote.secciones!.includes('criticos-defensores')) expect(prompt).not.toContain('Critica C.');
      // Card, pending and discarded items in every batch.
      expect(prompt).toContain('Persona Dos');
      expect(prompt).toContain('No reproducible.');
    }
    // Whole texts: nothing is cut.
    expect(r.prompts.join('').includes('t'.repeat(60_000)) && r.prompts.join('').includes('n'.repeat(60_000))).toBe(true);
    expect(r.recortes).toEqual([]);
    expect(promptsAdjudicacion('BASE', material(docs, [res('https://otro.es/x', 'bulos')]), 140_000)).toEqual(r);
  });
});

describe('búsqueda en llamadas pequeñas', () => {
  const igual = (tipo: string, partido: string) => ({ tipo, partido, salida: `equidad/${tipo}.${partido}.json`, consultas: [] }) as unknown as TareaEquidad;
  const fuente = (emisor: string) => ({ emisor, hosts: [`${emisor}.es`], busquedas: [] }) as unknown as TareaBusqueda;
  const iguales = ['criticos', 'bulos'].flatMap((t) => ['frente-amplio', 'pp', 'psoe', 'vox'].map((p) => igual(t, p)));
  const fuentes = ['a', 'b', 'c', 'd', 'e', 'f'].map(fuente);

  it('runs one call per kind of equal search with its four parties, then the sources a few at a time', () => {
    const llamadas = llamadasBusqueda(fuentes, iguales);
    expect(llamadas.map((l) => [l.iguales.map((t) => `${t.tipo}.${t.partido}`), l.fuentes.map((t) => t.emisor)])).toEqual([
      [['criticos.frente-amplio', 'criticos.pp', 'criticos.psoe', 'criticos.vox'], []],
      [['bulos.frente-amplio', 'bulos.pp', 'bulos.psoe', 'bulos.vox'], []],
      [[], ['a', 'b', 'c', 'd']],
      [[], ['e', 'f']],
    ]);
    const { prompts, lotes } = promptsBusqueda('BASE', fuentes, iguales);
    expect(lotes.map((l) => l.salidas)).toEqual([iguales.slice(0, 4).map((t) => t.salida), iguales.slice(4).map((t) => t.salida), ['busqueda/a.json', 'busqueda/b.json', 'busqueda/c.json', 'busqueda/d.json'], ['busqueda/e.json', 'busqueda/f.json']]);
    expect(prompts[3]).toContain('TAREAS_EQUIDAD (JSON):\n[]');
  });

  it('counts the last valid reply for each file of the call, and nothing outside it', () => {
    const { porSalida, rechazadas } = respuestasQueCuentan(
      [
        { salida: 'busqueda/a.json', respuesta: '{"emisor": "a", "intento": 1}' },
        { salida: 'busqueda/a.json', respuesta: 'no pude' },
        { salida: 'busqueda/a.json', respuesta: '{"emisor": "a", "intento": 2}' },
        { salida: 'busqueda/b.json', respuesta: '{"emisor": "b"}' },
        { salida: 'busqueda/b.json', respuesta: 'error de red' },
        { salida: 'busqueda/c.json', respuesta: 'nada' },
        { salida: '../../etc/x', respuesta: '{}' },
      ],
      new Set(['busqueda/a.json', 'busqueda/b.json', 'busqueda/c.json']),
    );
    expect(porSalida.get('busqueda/a.json')).toEqual({ contenido: '{"emisor": "a", "intento": 2}\n', valida: true });
    expect(porSalida.get('busqueda/b.json')).toEqual({ contenido: '{"emisor": "b"}\n', valida: true });
    expect(porSalida.get('busqueda/c.json')!.valida).toBe(false);
    expect(rechazadas).toEqual(['../../etc/x']);
  });
});
