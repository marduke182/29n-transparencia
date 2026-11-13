import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dentroDeRepo, guardar, idDocumento, raizCache, textoDePdf, urlCanonica } from './cache.ts';

let raiz: string;
beforeEach(async () => {
  raiz = await mkdtemp(join(tmpdir(), 'n29-cache-'));
});
afterEach(async () => {
  await rm(raiz, { recursive: true, force: true });
});

describe('urlCanonica', () => {
  it('drops www, tracking parameters, the fragment and the trailing slash, and sorts the rest', () => {
    expect(urlCanonica('http://WWW.Ejemplo.es/a/b/?utm_source=x&b=2&fbclid=y&a=1#frag')).toBe('https://ejemplo.es/a/b?a=1&b=2');
  });
  it('keeps the root slash', () => {
    expect(urlCanonica('https://www.ejemplo.es/')).toBe('https://ejemplo.es/');
  });
});

describe('guardar', () => {
  const base = { url: 'https://www.ejemplo.es/noticia?utm_medium=rss', consultado: '2026-11-10', via: 'web' as const, estado_http: 200, ext: 'html' };

  it('writes meta.json, raw and texto under the hashed canonical URL', async () => {
    const guardado = await guardar(raiz, { ...base, raw: '<p>uno</p>', texto: 'uno' });
    expect(guardado.estado).toBe('nuevo');
    expect(guardado.id).toBe(idDocumento('https://ejemplo.es/noticia'));
    expect(guardado.id).toHaveLength(16);
    const meta = JSON.parse(await readFile(join(raiz, 'docs', guardado.id, 'meta.json'), 'utf8'));
    expect(Object.keys(meta)).toEqual(['url', 'url_canonica', 'consultado', 'via', 'sha256_contenido', 'estado_http']);
    expect(meta.url_canonica).toBe('https://ejemplo.es/noticia');
    expect(await readFile(join(raiz, 'docs', guardado.id, 'texto.txt'), 'utf8')).toBe('uno\n');
  });

  it('treats new content under the same URL as a new version of the same document', async () => {
    const primero = await guardar(raiz, { ...base, raw: 'v1', texto: 'v1' });
    expect((await guardar(raiz, { ...base, raw: 'v1', texto: 'v1', consultado: '2026-11-11' })).estado).toBe('sin-cambios');
    const segundo = await guardar(raiz, { ...base, raw: 'v2', texto: 'v2', consultado: '2026-11-12' });
    expect(segundo.estado).toBe('version');
    expect(segundo.id).toBe(primero.id);
    expect(await readdir(join(raiz, 'docs'))).toEqual([primero.id]);
    const versiones = await readdir(join(raiz, 'docs', primero.id, 'versiones'));
    expect(versiones).toEqual([`2026-11-10-${primero.meta.sha256_contenido.slice(0, 8)}`]);
    expect(await readFile(join(raiz, 'docs', primero.id, 'texto.txt'), 'utf8')).toBe('v2\n');
  });

  it('keeps the owner\'s mark when the owner supplies a document the run had already cached with the same content', async () => {
    await guardar(raiz, { ...base, raw: 'v1', texto: 'v1' });
    const marcado = await guardar(raiz, { ...base, raw: 'v1', texto: 'v1', consultado: '2026-11-11', extra: { origen: 'buzon-enlaces', url_pedida: 'https://corto.es/x' } });
    expect(marcado.estado).toBe('sin-cambios');
    expect(marcado.meta).toMatchObject({ consultado: '2026-11-10', origen: 'buzon-enlaces', url_pedida: 'https://corto.es/x' });
    const meta = JSON.parse(await readFile(join(raiz, 'docs', marcado.id, 'meta.json'), 'utf8'));
    expect(meta.origen).toBe('buzon-enlaces');
    // A later run without the mark does not remove it, and nothing else changes.
    expect((await guardar(raiz, { ...base, raw: 'v1', texto: 'v1', consultado: '2026-11-12' })).meta.origen).toBe('buzon-enlaces');
  });
});

describe('raizCache', () => {
  it('refuses a cache inside a repository and requires the env var', () => {
    expect(dentroDeRepo(process.cwd())).toBe(true);
    expect(() => raizCache({ N29_CACHE: join(process.cwd(), 'cache') })).toThrow(/repositorio/);
    expect(() => raizCache({})).toThrow(/N29_CACHE/);
    expect(raizCache({ N29_CACHE: raiz })).toBe(raiz);
  });
});

/** A minimal one-page PDF with the text "Hola debate" (offsets computed below). */
function pdfMinimo(): Uint8Array {
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 41 >>\nstream\nBT /F1 12 Tf 20 50 Td (Hola debate) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objetos.forEach((objeto, indice) => {
    offsets.push(pdf.length);
    pdf += `${indice + 1} 0 obj\n${objeto}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('textoDePdf', () => {
  it('extracts the text with pdfjs-dist', async () => {
    expect(await textoDePdf(pdfMinimo())).toContain('Hola debate');
  });
});
