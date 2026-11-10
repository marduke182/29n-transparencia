import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leerBuzon, ocultarPrivado, textoDeHtml, urlDeArchivo, urlDeHtml } from './buzon.ts';

const PAGINA = `<!doctype html><html><head>
<meta charset="utf-8"><meta name="csrf-token" content="a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4">
<link rel="canonical" href="https://www.psoe.es/actualidad/noticias/propuesta-vivienda/?utm_source=tw">
<script>window.user = { email: "cuenta.privada@example.com", session: "abc" };</script>
</head><body>
<header>Menú · Hola, cuenta.privada@example.com</header>
<form action="/login"><input name="password" value="secreto"></form>
<article><h1>Propuesta de vivienda</h1><p>El partido presentó &laquo;su plan&raquo; el lunes.</p>
<p>Contacto: prensa@example.org · PHPSESSID=9f8e7d6c5b4a3f2e1d0c</p></article>
<footer>© Partido</footer></body></html>`;

describe('urlDeHtml', () => {
  it('reads link[rel=canonical], else og:url', () => {
    expect(urlDeHtml(PAGINA)).toBe('https://www.psoe.es/actualidad/noticias/propuesta-vivienda/?utm_source=tw');
    expect(urlDeHtml('<meta property="og:url" content="https://voxespana.es/noticias/x">')).toBe('https://voxespana.es/noticias/x');
    expect(urlDeHtml('<p>sin url</p>')).toBeUndefined();
  });
  it('prefers the .url sidecar', () => {
    expect(urlDeArchivo(PAGINA, '\nhttps://podemos.info/a\n')).toBe('https://podemos.info/a');
    expect(urlDeArchivo(undefined, undefined)).toBeUndefined();
  });
});

describe('private content', () => {
  it('hides emails, tokens and session ids', () => {
    const texto = ocultarPrivado('Escribe a ana.perez@example.com; token=abcdefghijklmnop1234; sessionid=QWERTY123456; eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q');
    expect(texto).not.toMatch(/ana\.perez|abcdefghijklmnop1234|QWERTY123456|eyJhbGci/);
    expect(texto).toContain('[correo]');
    expect(texto).toContain('[sesión]');
  });

  it('keeps only the article text: no scripts, forms, meta tags or account data', () => {
    const texto = textoDeHtml(PAGINA);
    expect(texto).toBe('Propuesta de vivienda\nEl partido presentó «su plan» el lunes.\nContacto: [correo] · [sesión]');
    expect(texto).not.toMatch(/cuenta\.privada|secreto|csrf|window\.user|Menú/);
  });
});

describe('leerBuzon', () => {
  let raiz: string;
  beforeEach(async () => {
    raiz = await mkdtemp(join(tmpdir(), 'n29-buzon-'));
  });
  afterEach(async () => {
    await rm(raiz, { recursive: true, force: true });
  });

  it('ingests with via buzon and the folder date, and rejects files without a URL', async () => {
    const buzon = join(raiz, 'buzon');
    const cache = join(raiz, 'cache');
    await mkdir(join(buzon, 'psoe', '2026-11-09'), { recursive: true });
    await mkdir(join(buzon, 'vox', '2026-11-09'), { recursive: true });
    await writeFile(join(buzon, 'psoe', '2026-11-09', 'vivienda.html'), PAGINA);
    await writeFile(join(buzon, 'vox', '2026-11-09', 'nota.txt'), 'Texto de una nota. Contacto: x@example.com');
    await writeFile(join(buzon, 'vox', '2026-11-09', 'sin-url.html'), '<article><p>Sin URL</p></article>');
    await writeFile(join(buzon, 'vox', '2026-11-09', 'nota.url'), 'https://www.voxespana.es/noticias/nota\n');
    await writeFile(join(buzon, 'vox', '2026-11-09', 'programa.pdf'), '%PDF-1.4');

    const resultado = await leerBuzon(buzon, cache);
    expect(resultado.guardados.map((g) => [g.archivo, g.meta.url_canonica, g.meta.via, g.meta.consultado, g.meta.estado_http])).toEqual([
      ['psoe/2026-11-09/vivienda.html', 'https://psoe.es/actualidad/noticias/propuesta-vivienda', 'buzon', '2026-11-09', null],
      ['vox/2026-11-09/nota.txt', 'https://voxespana.es/noticias/nota', 'buzon', '2026-11-09', null],
    ]);
    expect(resultado.rechazados).toEqual([
      { archivo: 'vox/2026-11-09/programa.pdf', motivo: 'sin URL: falta el archivo .url, obligatorio para PDF y texto' },
      { archivo: 'vox/2026-11-09/sin-url.html', motivo: 'sin URL: no hay link[rel=canonical] ni og:url, y falta el archivo .url' },
    ]);
    const psoe = resultado.guardados[0]!;
    const raw = await readFile(join(psoe.dir, 'raw.txt'), 'utf8');
    expect(raw).not.toMatch(/cuenta\.privada|<script|<meta|password/);
    expect(await readFile(join(resultado.guardados[1]!.dir, 'texto.txt'), 'utf8')).toBe('Texto de una nota. Contacto: [correo]\n');
  });
});
