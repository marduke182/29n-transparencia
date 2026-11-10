import { describe, expect, it } from 'vitest';
import type { Emisor } from '../data/fuentes';
import { citasPorEmisor, emisorDe, emisoresDe, hostDe, validateFuentes as validar, webDePartido } from './fuentes';
import type { Item, Partido } from './partidos';
import type { PartyId } from '../config';

const ESPANOL: Emisor = { id: 'el-espanol', nombre: 'El Español', hosts: ['elespanol.com'], tipo: 'medio' };
const AVISOS: Emisor = { id: 'diario-de-avisos', nombre: 'Diario de Avisos', hosts: ['diariodeavisos.elespanol.com'], tipo: 'medio' };
const ARA: Emisor = { id: 'ara', nombre: 'Ara', hosts: ['es.ara.cat', 'en.ara.cat'], tipo: 'medio' };
const BOE: Emisor = { id: 'boe', nombre: 'BOE', hosts: ['boe.es'], tipo: 'oficial' };
const MALDITA: Emisor = {
  id: 'maldita',
  nombre: 'Maldita.es',
  hosts: ['maldita.es'],
  tipo: 'verificador',
  mbfc: {
    sesgo: 'Least Biased',
    puntuacion: -1.3,
    factual: 'High',
    credibilidad: 'High',
    fecha: '2026-06-12',
    consultado: '2026-11-10',
    url: 'https://mediabiasfactcheck.com/maldita-es-bias-and-credibility/',
  },
};
/** One website emisor per party, as the registry requires; none of them is linked in the fixtures. */
const WEBS: Emisor[] = (['frente-amplio', 'podemos', 'pp', 'psoe', 'vox'] as const).map((partido) => ({
  id: `web-${partido}`,
  nombre: `Web de ${partido}`,
  hosts: [`${partido}.example`],
  tipo: 'partido',
  partido,
  acceso: {
    estado: partido === 'pp' ? 'abierto' : 'bloqueado',
    comprobado: '2026-11-10',
    detalle: 'Responde 403 a clientes automatizados.',
  },
}));
const EMISORES = [ESPANOL, AVISOS, ARA, BOE, MALDITA, ...WEBS];

/**
 * The `mbfc` and `cis_estudios` blocks of the registry. The site defaults to its
 * fuentes.json; this standalone copy publishes no data, so every call gets this fixture.
 */
const REGISTRO = {
  mbfc: { nombre: 'Media Bias/Fact Check', metodologia: 'https://mediabiasfactcheck.com/methodology/' },
  cis_estudios: {
    '3511': { titulo: 'Estudio (II)', campo: '8 de mayo – 12 de junio de 2025', muestra: 100, url: 'https://www.cis.es/a' },
    '3421': { titulo: 'Estudio (I)', campo: '18 de septiembre – 16 de octubre de 2023', muestra: 100, url: 'https://www.cis.es/b' },
  },
};
const validateFuentes = (emisores: unknown, partidos: Partido[], registro: unknown = REGISTRO) => validar(emisores, partidos, registro);

let refs = 0;
const item = (urls: string[], extra: Partial<Item> = {}): Item => ({
  ref: `r${++refs}`,
  texto: 'Texto.',
  estado: 'VERIFICADO',
  fuentes: urls.map((url) => ({ url, medio: 'x' })),
  ...extra,
});

function partido(id: PartyId, items: Item[], tarjeta: Partial<Partido['tarjeta']> = {}): Partido {
  return {
    id,
    nombre: id,
    corte: '2026-11-09',
    tarjeta: {
      candidato: 'Nombre',
      lema: 'Lema',
      fuente_lema: 'https://boe.es/lema',
      que_propone: 'Algo.',
      fuente_propuesta: 'https://boe.es/prop',
      ...tarjeta,
    },
    secciones: [{ id: 'candidatura', titulo: 'Candidatura', items }],
    pendientes: [],
  };
}

const partidos = () => [
  partido('pp', [
    item(['https://www.elespanol.com/a', 'https://es.ara.cat/b', 'https://en.ara.cat/c']),
    item(['https://diariodeavisos.elespanol.com/d'], { cita: { texto: 'Dijo.', url: 'https://maldita.es/e' } }),
  ]),
  partido('vox', [item(['https://ELESPANOL.com/f'])]),
];

const mbfc = (extra: Partial<NonNullable<Emisor['mbfc']>>) => ({ ...MALDITA, mbfc: { ...MALDITA.mbfc!, ...extra } });
const issuesWith = (emisor: Emisor) =>
  validateFuentes(
    EMISORES.map((other) => (other.id === emisor.id ? emisor : other)),
    partidos(),
  );

describe('hostDe / emisorDe', () => {
  it('lowercases and strips www.', () => {
    expect(hostDe('https://WWW.ElEspanol.com/x?y=1')).toBe('elespanol.com');
    expect(hostDe('not a url')).toBe('');
  });

  it('matches exact hosts only: a subdomain is another emisor', () => {
    expect(emisorDe('https://www.elespanol.com/x', EMISORES)).toBe(ESPANOL);
    expect(emisorDe('https://diariodeavisos.elespanol.com/x', EMISORES)).toBe(AVISOS);
    expect(emisorDe('https://otro.elespanol.com/x', EMISORES)).toBeUndefined();
  });

  it('merges several hosts into one emisor', () => {
    expect(emisorDe('https://es.ara.cat/x', EMISORES)).toBe(ARA);
    expect(emisorDe('https://en.ara.cat/x', EMISORES)).toBe(ARA);
  });
});

describe('webDePartido', () => {
  it("finds each party's own website emisor", () => {
    expect(webDePartido('psoe', EMISORES)?.id).toBe('web-psoe');
    expect(webDePartido('psoe', [ESPANOL, BOE])).toBeUndefined();
  });
});

describe('citasPorEmisor', () => {
  it('counts item sources per party, with zeros for every party and emisor', () => {
    const counts = citasPorEmisor(partidos(), EMISORES);
    expect([...counts.keys()]).toEqual(['el-espanol', 'diario-de-avisos', 'ara', 'boe', 'maldita', ...WEBS.map((web) => web.id)]);
    expect(counts.get('el-espanol')).toEqual({ 'frente-amplio': 0, podemos: 0, pp: 1, psoe: 0, vox: 1 });
    expect(counts.get('ara')).toEqual({ 'frente-amplio': 0, podemos: 0, pp: 2, psoe: 0, vox: 0 });
    expect(counts.get('diario-de-avisos')?.pp).toBe(1);
  });

  it('does not count card links or quotes', () => {
    const counts = citasPorEmisor(partidos(), EMISORES);
    expect(Object.values(counts.get('boe')!).every((n) => n === 0)).toBe(true);
    expect(Object.values(counts.get('maldita')!).every((n) => n === 0)).toBe(true);
  });
});

describe('emisoresDe', () => {
  it('dedups and orders by kind, then by name (es collation), dropping unknown hosts', () => {
    const urls = [
      'https://maldita.es/a',
      'https://boe.es/b',
      'https://elespanol.com/c',
      'https://www.elespanol.com/d',
      'https://es.ara.cat/e',
      'https://desconocido.com/f',
      'https://diariodeavisos.elespanol.com/g',
    ];
    expect(emisoresDe(urls, EMISORES).map((emisor) => emisor.id)).toEqual(['ara', 'diario-de-avisos', 'el-espanol', 'maldita', 'boe']);
  });
});

describe('validateFuentes', () => {
  it('accepts a valid registry', () => {
    expect(validateFuentes(EMISORES, partidos())).toEqual([]);
  });

  it('requires an emisor for every linked host (sources, quotes and card links)', () => {
    const data = partidos();
    data[0]!.secciones[0]!.items.push(item(['https://nuevo.es/a'], { cita: { texto: 'x', url: 'https://cita.es/b' } }));
    data[1]!.tarjeta.fuente_lema = 'https://lema.es/c';
    data[1]!.tarjeta.fuente_propuesta = 'https://prop.es/d';
    data[1]!.tarjeta.fuentes_propuesta = ['https://extra.es/e'];
    const issues = validateFuentes(EMISORES, data).join('\n');
    for (const host of ['nuevo.es', 'cita.es', 'lema.es', 'prop.es', 'extra.es']) expect(issues).toContain(`"${host}"`);
  });

  it('rejects a host under two emisores', () => {
    expect(issuesWith({ ...BOE, hosts: ['boe.es', 'es.ara.cat'] }).join()).toMatch(/es.ara.cat" is already under ara/);
  });

  it('rejects hosts that are not normalised', () => {
    expect(issuesWith({ ...BOE, hosts: ['boe.es', 'www.boe.es'] }).join()).toMatch(/without www/);
  });

  it('rejects emisores no party links to', () => {
    const extra: Emisor = { id: 'nadie', nombre: 'Nadie', hosts: ['nadie.es'], tipo: 'medio' };
    expect(validateFuentes([...EMISORES, extra], partidos())).toEqual(['fuentes.nadie: not linked from any party file']);
  });

  it('does not require party websites to be linked', () => {
    expect(validateFuentes(EMISORES, partidos())).toEqual([]);
    expect(citasPorEmisor(partidos(), EMISORES).get('web-psoe')).toEqual({ 'frente-amplio': 0, podemos: 0, pp: 0, psoe: 0, vox: 0 });
  });

  it('requires exactly one website emisor per party', () => {
    const sinPsoe = EMISORES.filter((emisor) => emisor.id !== 'web-psoe');
    expect(validateFuentes(sinPsoe, partidos())).toEqual(['fuentes: psoe needs exactly one partido emisor (its website), found 0']);
    const doble: Emisor = { ...WEBS[2]!, id: 'otra-web-pp', nombre: 'Otra web del PP', hosts: ['otra-pp.example'] };
    expect(validateFuentes([...EMISORES, doble], partidos())).toEqual([
      'fuentes: pp needs exactly one partido emisor (its website), found 2 (web-pp, otra-web-pp)',
    ]);
  });

  it('validates the partido field: required on party websites, a party id, and only there', () => {
    expect(malformed({ ...WEBS[3]!, partido: undefined })).toMatch(/web-psoe: partido "undefined" is not one of/);
    expect(malformed({ ...WEBS[3]!, partido: 'psoe-es' })).toMatch(/partido "psoe-es" is not one of/);
    expect(issuesWith({ ...BOE, partido: 'pp' }).join()).toMatch(/fuentes.boe: partido is only allowed on tipo partido/);
  });

  it('requires a dated acceso check on party websites, and only there', () => {
    expect(issuesWith({ ...WEBS[4]!, acceso: { ...WEBS[4]!.acceso!, estado: 'parcial' } })).toEqual([]);
    expect(issuesWith({ ...WEBS[3]!, acceso: undefined })).toEqual([
      'fuentes.web-psoe: missing acceso (the dated check of the party website)',
    ]);
    expect(issuesWith({ ...BOE, acceso: WEBS[0]!.acceso })).toEqual(['fuentes.boe: acceso is only allowed on tipo partido']);
    const issues = malformed({ ...WEBS[3]!, acceso: { estado: 'cerrado', comprobado: '10/11/2026', detalle: ' ', nota: 'x' } });
    expect(issues).toMatch(/acceso.estado "cerrado" is not one of abierto, parcial, bloqueado/);
    expect(issues).toMatch(/acceso.comprobado is not an ISO date/);
    expect(issues).toMatch(/acceso.detalle must be text/);
    expect(issues).toMatch(/web-psoe.acceso: unknown field "nota"/);
    expect(malformed({ ...WEBS[3]!, acceso: 'bloqueado' })).toMatch(/acceso must be an object/);
  });

  it('validates the optional recogida on any emisor', () => {
    expect(
      issuesWith({ ...BOE, recogida: { metodo: 'api', url: 'https://www.boe.es/datosabiertos/api/boe/sumario/', nota: 'Diario.' } }),
    ).toEqual([]);
    expect(issuesWith({ ...WEBS[3]!, recogida: { metodo: 'omitir', nota: 'bloquea bots' } })).toEqual([]);
    expect(issuesWith({ ...BOE, recogida: { metodo: 'seccion', url: 'https://www.boe.es/diario_boe/' } })).toEqual([]);
    const issues = malformed({ ...ESPANOL, recogida: { metodo: 'scraping', url: 'http://elespanol.com/feed', nota: '', cada: 'día' } });
    expect(issues).toMatch(/recogida.metodo "scraping" is not one of sitemap, rss, api, seccion, busqueda, omitir/);
    expect(issues).toMatch(/recogida.url is not an https URL/);
    expect(issues).toMatch(/recogida.nota must be text/);
    expect(issues).toMatch(/el-espanol.recogida: unknown field "cada"/);
    expect(malformed({ ...ESPANOL, recogida: 'rss' })).toMatch(/recogida must be an object/);
  });

  it('allows ratings only on medios, verificadores and agencias', () => {
    expect(issuesWith({ ...BOE, mbfc: MALDITA.mbfc }).join()).toMatch(/ratings are only allowed/);
    expect(issuesWith({ ...BOE, cis: [{ estudio: '3511', media: 5, de: 2, n: 100, consultado: '2026-11-10' }] }).join()).toMatch(
      /ratings are only allowed/,
    );
  });

  it('keeps the MBFC score inside its label band, and allows no score', () => {
    expect(issuesWith(mbfc({ puntuacion: -2.5 })).join()).toMatch(/outside Least Biased/);
    expect(issuesWith(mbfc({ sesgo: 'Left-Center', puntuacion: -2 }))).toEqual([]);
    expect(issuesWith(mbfc({ sesgo: 'Left', puntuacion: -4.9 })).join()).toMatch(/outside Left/);
    expect(issuesWith(mbfc({ sesgo: 'Right', puntuacion: 5 }))).toEqual([]);
    expect(issuesWith(mbfc({ sesgo: 'Right-Center', puntuacion: 5 })).join()).toMatch(/outside Right-Center/);
    expect(issuesWith(mbfc({ puntuacion: undefined }))).toEqual([]);
  });

  it('requires the MBFC link to be https on mediabiasfactcheck.com', () => {
    expect(issuesWith(mbfc({ url: 'http://mediabiasfactcheck.com/x/' })).join()).toMatch(/MBFC url/);
    expect(issuesWith(mbfc({ url: 'https://example.com/x/' })).join()).toMatch(/MBFC url/);
  });

  it('keeps CIS means within 1..10', () => {
    expect(issuesWith({ ...MALDITA, cis: [{ estudio: '3511', media: 0.5, de: 2, n: 100, consultado: '2026-11-10' }] }).join()).toMatch(
      /outside 1\.\.10/,
    );
    expect(issuesWith({ ...MALDITA, cis: [{ estudio: '3511', media: 4.6, de: 2.52, n: 8288, consultado: '2026-11-10' }] })).toEqual([]);
  });

  it('requires ISO dates for the rater date and the date we read each value', () => {
    expect(issuesWith(mbfc({ fecha: '12 Jun 2026' })).join()).toMatch(/fecha is not an ISO date/);
    expect(issuesWith(mbfc({ consultado: '2026-02-30' })).join()).toMatch(/consultado is not an ISO date/);
    const { consultado: _, ...sinFecha } = MALDITA.mbfc!;
    expect(issuesWith({ ...MALDITA, mbfc: sinFecha as Emisor['mbfc'] }).join()).toMatch(/consultado is not an ISO date/);
    expect(issuesWith({ ...MALDITA, cis: [{ estudio: '3511', media: 5, de: 2, n: 100, consultado: 'ayer' }] }).join()).toMatch(
      /CIS consultado is not an ISO date/,
    );
  });

  it('requires an https owner link', () => {
    expect(issuesWith({ ...ESPANOL, titular: { nombre: 'S.L.', url: 'http://x.es' } }).join()).toMatch(/titular.url/);
  });

  it('requires unique slug ids', () => {
    const renamed = EMISORES.map((emisor) => (emisor === BOE ? { ...BOE, id: 'BOE oficial' } : emisor));
    expect(validateFuentes(renamed, partidos()).join()).toMatch(/not a slug/);
    expect(validateFuentes([...EMISORES, { ...BOE, hosts: ['boe2.es'] }], partidos()).join()).toMatch(/duplicate id/);
  });
});

/** Simulates a hand or agent edit of fuentes.json: any shape, loosely typed. */
const malformed = (emisor: Record<string, unknown>) =>
  validateFuentes(
    EMISORES.map((other) => (other.id === emisor.id ? emisor : other)),
    partidos(),
  ).join('\n');

describe('validateFuentes: shape of fuentes.json', () => {
  it('rejects a registry that is not a list, and entries that are not objects', () => {
    expect(validateFuentes({}, partidos())).toContain('fuentes.emisores: must be a list');
    expect(validateFuentes([...EMISORES, 'boe'], partidos()).join()).toMatch(
      new RegExp(`emisores\\[${EMISORES.length + 1}\\]: must be an object`),
    );
  });

  it('reports missing required fields and wrong types', () => {
    const issues = malformed({ id: 'boe', hosts: 'boe.es' });
    expect(issues).toMatch(/fuentes.boe: missing nombre/);
    expect(issues).toMatch(/tipo "undefined" is not one of/);
    expect(issues).toMatch(/hosts must be a non-empty list/);
  });

  it('reports unknown fields (typos)', () => {
    expect(malformed({ ...BOE, tipos: 'oficial' })).toMatch(/unknown field "tipos"/);
    expect(malformed({ ...MALDITA, mbfc: { ...MALDITA.mbfc, consultada: '2026-11-10' } })).toMatch(/unknown field "consultada"/);
  });

  it('checks MBFC enums and types', () => {
    const issues = malformed({
      ...MALDITA,
      mbfc: { ...MALDITA.mbfc, sesgo: 'Center', factual: 'Alta', puntuacion: '-1.3', cuestionable: false },
    });
    expect(issues).toMatch(/sesgo "Center" is not one of/);
    expect(issues).toMatch(/factual "Alta" is not one of/);
    expect(issues).toMatch(/puntuacion must be a number/);
    expect(issues).toMatch(/cuestionable must be true/);
  });

  it('checks CIS entries against the known studies', () => {
    const issues = malformed({
      ...MALDITA,
      cis: [
        { estudio: '9999', media: 5, de: 2, n: 100, consultado: '2026-11-10' },
        { estudio: '3511', media: 5, de: -1, n: 1.5, consultado: '2026-11-10' },
        { estudio: '3511', media: 5, de: 2, n: 100, consultado: '2026-11-10' },
      ],
    });
    expect(issues).toMatch(/unknown CIS study 9999/);
    expect(issues).toMatch(/de must be a number/);
    expect(issues).toMatch(/n must be a positive integer/);
    expect(issues).toMatch(/3511 listed twice/);
  });

  it('checks the mbfc and cis_estudios blocks', () => {
    const issues = validateFuentes(EMISORES, partidos(), {
      mbfc: { nombre: '', metodologia: 'http://x' },
      cis_estudios: { '3511': { titulo: 'T', campo: 'C', muestra: 0, url: 'https://cis.es', datos: 'ftp://x' } },
    }).join('\n');
    expect(issues).toMatch(/mbfc: missing nombre/);
    expect(issues).toMatch(/metodologia is not an https URL/);
    expect(issues).toMatch(/muestra must be a positive integer/);
    expect(issues).toMatch(/datos is not an https URL/);
    expect(validateFuentes(EMISORES, partidos(), {}).join()).toMatch(/cis_estudios: must be an object/);
  });

  it('requires numeric CIS study keys and a four-digit year in campo', () => {
    const estudio = { titulo: 'T', campo: '8 de mayo – 12 de junio de 2025', muestra: 100, url: 'https://cis.es' };
    const issues = validateFuentes(EMISORES, partidos(), {
      mbfc: { nombre: 'MBFC', metodologia: 'https://mediabiasfactcheck.com/methodology/' },
      cis_estudios: { '3511': estudio, '35a': estudio, '3421': { ...estudio, campo: 'mayo a junio' } },
    }).join('\n');
    expect(issues).toMatch(/cis_estudios.35a: the key must be the CIS study number/);
    expect(issues).not.toMatch(/cis_estudios.3511:/);
    expect(issues).toMatch(/cis_estudios.3421: campo must include the four-digit year/);
  });

  it('accepts the fixture registry blocks', () => {
    expect(validateFuentes(EMISORES, partidos())).toEqual([]);
  });
});

describe('determinism', () => {
  it('gives identical output for the same input, whatever the input order', () => {
    const urls = ['https://maldita.es/a', 'https://boe.es/b', 'https://elespanol.com/c', 'https://es.ara.cat/e'];
    const shuffled = [...EMISORES].reverse();
    expect(emisoresDe(urls, EMISORES)).toEqual(emisoresDe([...urls].reverse(), shuffled));
    expect([...citasPorEmisor(partidos(), EMISORES)]).toEqual([...citasPorEmisor(partidos(), EMISORES)]);
    expect(validateFuentes(EMISORES, partidos())).toEqual(validateFuentes(EMISORES, partidos()));
  });

  it('breaks name ties by id', () => {
    const a: Emisor = { ...ESPANOL, id: 'b-dup', hosts: ['b.es'] };
    const b: Emisor = { ...ESPANOL, id: 'a-dup', hosts: ['a.es'] };
    expect(emisoresDe(['https://b.es', 'https://a.es'], [a, b]).map((emisor) => emisor.id)).toEqual(['a-dup', 'b-dup']);
  });
});
