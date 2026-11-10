import { describe, expect, it } from 'vitest';
import type { Emisor } from '../data/fuentes';
import { SECCIONES } from './partidos';
import { countWords, notArticleUrl, quotedFragments, validatePartido } from './validate';

let refs = 0;
const item = (extra: Record<string, unknown> = {}) => ({
  ref: `r${++refs}`,
  texto: 'Texto neutral.',
  estado: 'VERIFICADO',
  fuentes: [{ url: 'https://example.com/a', medio: 'EFE' }],
  ...extra,
});

function partido(overrides: Record<string, unknown> = {}, sectionItems: Partial<Record<string, unknown[]>> = {}) {
  return {
    id: 'pp',
    nombre: 'Partido Popular (PP)',
    corte: '2026-11-09',
    tarjeta: {
      candidato: 'Nombre',
      lema: 'Un lema',
      fuente_lema: 'https://example.com/lema',
      que_propone: 'Tres ejes y una medida.',
      fuente_propuesta: 'https://example.com/prop',
    },
    secciones: SECCIONES.map((seccion) => ({ ...seccion, items: sectionItems[seccion.id] ?? [item()] })),
    pendientes: [],
    ...overrides,
  };
}

const verificado = item({ afirmacion: 'Dijo algo.', veredicto: 'Matizable' });
const valid = () =>
  partido(
    {},
    { verificacion: [verificado], cambios: [item({ antes: 'a', ahora: 'b' })], 'criticos-defensores': [item({ postura: 'critico' })] },
  );

describe('countWords / quotedFragments', () => {
  it('counts words, not punctuation', () => {
    expect(countWords('Hola, mundo — 1.800 €')).toBe(3);
  });
  it('finds «…», “…”, "…" and ‘…’ quotes', () => {
    expect(quotedFragments('dijo «uno dos» y “tres”, "cuatro" y ‘cinco’')).toEqual(['uno dos', 'tres', 'cuatro', 'cinco']);
  });
});

describe('validatePartido', () => {
  it('accepts a valid file', () => {
    expect(validatePartido('pp', valid())).toEqual([]);
  });

  it('rejects unpublishable estados', () => {
    const data = valid();
    data.secciones[0]!.items = [item({ estado: 'NO VERIFICABLE' })];
    expect(validatePartido('pp', data).join()).toMatch(/not publishable/);
  });

  it('requires an https source', () => {
    const data = valid();
    data.secciones[0]!.items = [item({ fuentes: [{ url: 'http://example.com', medio: 'X' }] })];
    expect(validatePartido('pp', data).join()).toMatch(/no https source/);
  });

  it('requires matiz for PARCIAL', () => {
    const data = valid();
    data.secciones[0]!.items = [item({ estado: 'PARCIAL' })];
    expect(validatePartido('pp', data).join()).toMatch(/PARCIAL without matiz/);
  });

  it('rejects quotes of 15 words or more', () => {
    const long = 'una dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince';
    const data = valid();
    data.secciones[0]!.items = [item({ cita: { texto: long, url: 'https://example.com' } }), item({ texto: `Dijo «${long}».` })];
    const issues = validatePartido('pp', data).join('\n');
    expect(issues).toMatch(/cita of 15 words/);
    expect(issues).toMatch(/texto: quote of 15 words/);
  });

  it('requires the nine sections in order', () => {
    const data = valid();
    data.secciones = [...data.secciones].reverse();
    expect(validatePartido('pp', data).join()).toMatch(/expected the nine/);
  });

  it('limits que_propone to 20 words', () => {
    const data = valid();
    data.tarjeta.que_propone = Array.from({ length: 21 }, () => 'palabra').join(' ');
    expect(validatePartido('pp', data).join()).toMatch(/21 words/);
  });

  it('accepts only the four veredictos', () => {
    const data = valid();
    data.secciones[4]!.items = [item({ afirmacion: 'x', veredicto: 'Falso' })];
    expect(validatePartido('pp', data).join()).toMatch(/veredicto "Falso"/);
  });

  it('checks the optional perfil and fuentes_propuesta', () => {
    const data = valid();
    data.secciones[7]!.items = [item({ postura: 'defensor', perfil: 'amigo' })];
    (data.tarjeta as Record<string, unknown>).fuentes_propuesta = ['http://example.com'];
    const issues = validatePartido('pp', data).join('\n');
    expect(issues).toMatch(/perfil "amigo"/);
    expect(issues).toMatch(/fuentes_propuesta/);
  });

  const long = 'una dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince';

  it('checks quotes in atribucion, medio, nota_bulos, pendientes and que_propone', () => {
    const data = valid();
    data.secciones[0]!.items = [item({ atribucion: `"${long}"`, fuentes: [{ url: 'https://example.com', medio: `‘${long}’` }] })];
    (data.secciones[4] as Record<string, unknown>).nota_bulos = `«${long}»`;
    data.pendientes = [`“${long}”`] as never[];
    data.tarjeta.que_propone = `«${long}»`;
    const issues = validatePartido('pp', data).join('\n');
    for (const where of ['atribucion', 'medio', 'nota_bulos', 'pendientes', 'que_propone'])
      expect(issues).toMatch(new RegExp(`${where}.*quote of 15`));
  });

  it('keeps the slogan under 15 words', () => {
    const data = valid();
    data.tarjeta.lema = long;
    expect(validatePartido('pp', data).join()).toMatch(/lema of 15 words/);
  });

  it('rejects section-specific fields in other sections', () => {
    const data = valid();
    data.secciones[0]!.items = [
      item({ veredicto: 'Respaldado', afirmacion: 'x', bulo: true, postura: 'critico', perfil: 'externo', antes: 'a', ahora: 'b' }),
    ];
    const issues = validatePartido('pp', data).join('\n');
    for (const field of ['veredicto', 'afirmacion', 'bulo', 'postura', 'perfil', 'antes', 'ahora']) {
      expect(issues).toMatch(new RegExp(`${field} is only allowed in`));
    }
  });

  it('requires a veredicto on hoax items too', () => {
    const data = valid();
    data.secciones[4]!.items = [item({ bulo: true })];
    expect(validatePartido('pp', data).join()).toMatch(/verificacion item without veredicto/);
  });

  it('requires unique refs per party', () => {
    expect(validatePartido('pp', valid()).join()).toBe('');
    const data = valid();
    data.secciones[0]!.items = [item({ ref: 'dup' })];
    data.secciones[1]!.items = [item({ ref: 'dup' })];
    expect(validatePartido('pp', data).join()).toMatch(/ref "dup" is used 2 times/);
  });
});

describe('notArticleUrl', () => {
  it('accepts article and document URLs', () => {
    for (const url of [
      'https://www.eldiario.es/politica/feijoo-firma-contrato-espana-si-gobierna-elecciones-29-noviembre-revelar-sola-medida-nueva_1_13596902.html',
      'https://frenteamplio.info/noticias/frente-amplio-propone-impuesto-acumulacion-vivienda/',
      'https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-21000',
      'https://www.elsaltodiario.com/elecciones/ada-colau-arranque-frente-amplio-alguien-no-se-quiere-sentar-una-mesa-no-se-le-puede-obligar',
    ]) {
      expect(notArticleUrl(url), url).toBeUndefined();
    }
  });

  it('rejects home pages', () => {
    expect(notArticleUrl('https://frenteamplio.info')).toBe('is a home page');
    expect(notArticleUrl('https://frenteamplio.info/')).toBe('is a home page');
    expect(notArticleUrl('https://www.pp.es/?utm=x')).toBe('is a home page');
  });

  it('rejects section indexes by their last segment', () => {
    for (const segment of ['noticias', 'actualidad', 'news', 'blog', 'category', 'categoria', 'tag', 'etiqueta', 'seccion']) {
      expect(notArticleUrl(`https://example.com/${segment}/`)).toBe(`is a section index ("${segment}")`);
    }
    for (const segment of ['politica', 'opinion', 'home', 'inicio', 'portada']) {
      expect(notArticleUrl(`https://example.com/es/${segment}`)).toBe(`is a section index ("${segment}")`);
    }
    expect(notArticleUrl('https://example.com/Noticias')).toBe('is a section index ("noticias")');
  });

  it('rejects short links', () => {
    expect(notArticleUrl('https://www.eldiario.es/1_cf78e6')).toBe('is an eldiario.es short link');
    for (const host of ['bit.ly', 't.co', 'goo.gl', 'ow.ly', 'tinyurl.com', 'lnkd.in']) {
      expect(notArticleUrl(`https://${host}/abc123`)).toBe(`is a short link (${host})`);
    }
  });

  it('fails the party file with its path and JSON path', () => {
    const data = valid();
    data.tarjeta.fuente_lema = 'https://frenteamplio.info';
    data.secciones[2]!.items = [
      item({ cita: { texto: 'una frase', url: 'https://example.com/noticias/' }, fuentes: [{ url: 'https://bit.ly/x', medio: 'EFE' }] }),
    ];
    const issues = validatePartido('pp', data);
    expect(issues).toContain(
      'src/data/partidos/pp.json .tarjeta.fuente_lema: https://frenteamplio.info is a home page; link the exact article',
    );
    expect(issues).toContain(
      'src/data/partidos/pp.json .secciones[2].items[0].cita.url: https://example.com/noticias/ is a section index ("noticias"); link the exact article',
    );
    expect(issues).toContain(
      'src/data/partidos/pp.json .secciones[2].items[0].fuentes[0].url: https://bit.ly/x is a short link (bit.ly); link the exact article',
    );
  });

  it('checks fuentes_propuesta too', () => {
    const data = valid();
    Object.assign(data.tarjeta, { fuentes_propuesta: ['https://example.com/a', 'https://example.com/blog'] });
    expect(validatePartido('pp', data).join()).toMatch(/\.tarjeta\.fuentes_propuesta\[1\]: .* is a section index \("blog"\)/);
  });

  describe('party home pages for self-statements', () => {
    const WEBS: Emisor[] = [
      { id: 'web-pp', nombre: 'Web del PP', hosts: ['pp.es'], tipo: 'partido', partido: 'pp' },
      { id: 'web-psoe', nombre: 'Web del PSOE', hosts: ['psoe.es'], tipo: 'partido', partido: 'psoe' },
      { id: 'efe', nombre: 'EFE', hosts: ['efe.com'], tipo: 'agencia' },
    ];
    const lemaItem = (url: string) => item({ cita: { texto: 'Un lema', url }, fuentes: [{ url, medio: 'Web' }] });

    it('accepts the own site home page for fuente_lema and lema-y-frases items', () => {
      const data = valid();
      data.tarjeta.fuente_lema = 'https://www.pp.es/';
      data.secciones[1]!.items = [lemaItem('https://pp.es')];
      expect(SECCIONES[1]!.id).toBe('lema-y-frases');
      expect(validatePartido('pp', data, WEBS)).toEqual([]);
    });

    it("rejects another party's home page", () => {
      const data = valid();
      data.tarjeta.fuente_lema = 'https://psoe.es/';
      data.secciones[1]!.items = [lemaItem('https://psoe.es')];
      expect(validatePartido('pp', data, WEBS).filter((issue) => issue.includes('is a home page'))).toHaveLength(3);
    });

    it('rejects the own home page outside self-statements', () => {
      const data = valid();
      data.tarjeta.fuente_propuesta = 'https://pp.es/';
      data.secciones[2]!.items = [lemaItem('https://pp.es')];
      const issues = validatePartido('pp', data, WEBS).join('\n');
      expect(issues).toMatch(/\.tarjeta\.fuente_propuesta: https:\/\/pp\.es\/ is a home page/);
      expect(issues).toMatch(/\.secciones\[2\]\.items\[0\]\.cita\.url: .* is a home page/);
      expect(issues).toMatch(/\.secciones\[2\]\.items\[0\]\.fuentes\[0\]\.url: .* is a home page/);
    });

    it('rejects media home pages, own section indexes and short links even in self-statements', () => {
      const data = valid();
      data.tarjeta.fuente_lema = 'https://efe.com/';
      data.secciones[1]!.items = [lemaItem('https://pp.es/actualidad/'), lemaItem('https://bit.ly/lema')];
      const issues = validatePartido('pp', data, WEBS).join('\n');
      expect(issues).toMatch(/fuente_lema: https:\/\/efe\.com\/ is a home page/);
      expect(issues).toMatch(/is a section index \("actualidad"\)/);
      expect(issues).toMatch(/is a short link \(bit\.ly\)/);
    });
  });
});
