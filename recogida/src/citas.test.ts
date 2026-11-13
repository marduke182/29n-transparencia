import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { idDocumento, urlCanonica } from './cache.ts';
import { citableEn, comprobarCitas, extraerCitas, hostsRegistrados, lectorCache, normalizar, type LectorCache } from './citas.ts';

const URL_A = 'https://ejemplo.es/2026/11/08/articulo-a.html';
const URL_B = 'https://ejemplo.es/2026/11/08/articulo-b.html';

const TEXTOS: Record<string, string> = {
  [URL_A]: 'El candidato dijo que la vivienda es la prioridad del próximo Gobierno y que bajará los impuestos.',
  [URL_B]: 'Propone un plan de infraestruc-\nturas ferroviarias con revisión independiente de toda la red.',
};
const leer: LectorCache = (url) => TEXTOS[url];

const ficha = (cita: string, texto = 'Texto sin comillas.', url = URL_A) => ({
  id: 'pp',
  tarjeta: { lema: 'Lema', fuente_lema: URL_A, que_propone: 'Algo', fuente_propuesta: URL_A },
  secciones: [{ id: 'temas', items: [{ ref: '2.1', texto, estado: 'VERIFICADO', fuentes: [{ url, medio: 'Ejemplo' }], cita: { texto: cita, url } }] }],
  pendientes: [],
});

describe('normalizar', () => {
  it('une palabras partidas con guion a final de línea y colapsa espacios', () => {
    expect(normalizar('infraestruc-\nturas   ferroviarias\n')).toBe('infraestructuras ferroviarias');
  });
});

describe('comprobarCitas', () => {
  it('acepta una cita literal', () => {
    expect(comprobarCitas(extraerCitas(ficha('la vivienda es la prioridad')), leer)).toEqual([]);
  });

  it('señala una cita no literal', () => {
    const problemas = comprobarCitas(extraerCitas(ficha('la vivienda será la prioridad')), leer);
    expect(problemas.map((p) => [p.donde, p.tipo])).toEqual([['temas[2.1].cita', 'no_literal']]);
  });

  it('encuentra una cita partida por un guion a final de línea', () => {
    const datos = ficha('un plan de infraestructuras ferroviarias', 'Propone «revisión independiente de toda la red».', URL_B);
    expect(comprobarCitas(extraerCitas(datos), leer)).toEqual([]);
  });

  it('señala una cita de 15 palabras o más aunque sea literal', () => {
    const larga = 'El candidato dijo que la vivienda es la prioridad del próximo Gobierno y que bajará';
    const problemas = comprobarCitas(extraerCitas(ficha(larga)), leer);
    expect(problemas.map((p) => p.tipo)).toEqual(['larga']);
  });

  it('comprueba los fragmentos «» del texto contra las fuentes del elemento', () => {
    const problemas = comprobarCitas(extraerCitas(ficha('la vivienda es la prioridad', 'Dijo «subirá los impuestos».')), leer);
    expect(problemas.map((p) => [p.donde, p.tipo])).toEqual([['temas[2.1].texto', 'no_literal']]);
  });

  it('comprueba también las comillas “…”, "…" y ‘…’, como el validador del sitio', () => {
    const texto = 'Dijo “la vivienda es la prioridad”, "bajará los impuestos" y ‘subirá el gasto’.';
    const problemas = comprobarCitas(extraerCitas(ficha('la vivienda es la prioridad', texto)), leer);
    expect(problemas.map((p) => [p.texto, p.tipo])).toEqual([['subirá el gasto', 'no_literal']]);
  });

  it('señala documentos sin caché e ignora pendientes y nota_bulos', () => {
    const base = ficha('algo', 'Texto.', 'https://otro.es/nota.html');
    const datos = {
      ...base,
      secciones: [...base.secciones, { id: 'verificacion', nota_bulos: 'Sin «bulos».', items: [] }],
      pendientes: ['Falta el «programa».'],
    };
    const problemas = comprobarCitas(extraerCitas(datos), leer);
    expect(problemas.map((p) => [p.donde, p.tipo])).toEqual([['temas[2.1].cita', 'sin_cache']]);
  });

  it('lee los perfiles: la cita va contra cita_documento', () => {
    const perfil = {
      partido: 'pp',
      documentos: [{ id: 'doc-a', url: URL_A }],
      propuestas: [{ texto: 'Propone «bajará los impuestos».', cita: 'la vivienda es la prioridad', cita_documento: 'doc-a', documentos: ['doc-a'] }],
      mensajes: [{ texto: 'Habla de «otra cosa».', documentos: ['doc-a'] }],
    };
    const problemas = comprobarCitas(extraerCitas(perfil), leer);
    expect(problemas.map((p) => [p.donde, p.tipo])).toEqual([['mensajes[1].texto', 'no_literal']]);
  });
});

describe('lectorCache', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'n29-cache-'));
  afterAll(() => rmSync(raiz, { recursive: true, force: true }));

  const guardar = (canonica: string, url: string, texto: string) => {
    const dir = join(raiz, 'docs', idDocumento(canonica));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ url, url_canonica: canonica, estado_http: 200 }));
    writeFileSync(join(dir, 'texto.txt'), texto);
  };

  it('encuentra un documento por su URL canónica, por otra forma de la misma URL y por el índice de meta.json', () => {
    guardar(urlCanonica(URL_A), `${URL_A}#comentarios`, 'texto del documento');
    guardar('https://otro.es/clave-propia/', 'https://otro.es/original', 'otro texto');
    const leerDisco = lectorCache(raiz);
    expect(leerDisco(URL_A)).toBe('texto del documento');
    expect(leerDisco(URL_A.replace('https://', 'https://www.'))).toBe('texto del documento');
    expect(leerDisco('https://otro.es/original')).toBe('otro texto');
    expect(leerDisco(URL_B)).toBeUndefined();
  });
});

describe('citableEn: solo hosts registrados o documentos del dueño', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'n29-citable-'));
  afterAll(() => rmSync(raiz, { recursive: true, force: true }));
  const guardarMeta = (url: string, meta: Record<string, unknown>) => {
    const dir = join(raiz, 'docs', idDocumento(urlCanonica(url)));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ url, url_canonica: urlCanonica(url), ...meta }));
  };

  it('admite un host de fuentes.json y sus subdominios, y un documento traído por el buzón o la lista de enlaces; nada más', () => {
    const hosts = hostsRegistrados({ emisores: [{ id: 'medio', hosts: ['www.Medio.es'] }, { id: 'roto' }, { hosts: [3] }] });
    expect(hosts).toEqual(['medio.es']);
    guardarMeta('https://ajeno.com/buzon', { via: 'buzon' });
    guardarMeta('https://ajeno.com/enlace', { via: 'web', origen: 'buzon-enlaces' });
    guardarMeta('https://ajeno.com/busqueda', { via: 'web' });
    const citable = citableEn(raiz, hosts);
    expect(['https://medio.es/a', 'https://www.medio.es/b?utm_source=x', 'https://cdn.medio.es/c.pdf'].every(citable)).toBe(true);
    expect(citable('https://ajeno.com/buzon')).toBe(true);
    expect(citable('https://ajeno.com/enlace')).toBe(true);
    // Found by a search, cached, but on an unregistered host: not citable.
    expect(citable('https://ajeno.com/busqueda')).toBe(false);
    for (const mala of ['https://medio.es.ajeno.com/x', 'https://notmedio.es/x', 'ftp://medio.es/x', 'no es una url', 'https://ajeno.com/sin-cache']) expect(citable(mala), mala).toBe(false);
  });
});
