/**
 * diario.sh --reanudar and --sellar: the checks before a failed day is resumed.
 * Each case builds a throwaway repository, remote, worktree and run folder,
 * and a stand-in `claude` that only answers --version. No network.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', 'bin', 'diario.sh');
const FECHA = '2026-11-11';
const RAMA = `data/29n-diario-${FECHA}`;
let raiz: string;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.email=prueba@example.invalid', '-c', 'user.name=prueba', '-c', 'init.defaultBranch=master', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A day stopped at `etapa`, with its worktree on its branch at the base, and the remote without the branch. */
function preparar(etapa = 'busqueda-completa') {
  raiz = mkdtempSync(join(tmpdir(), 'n29-reanudar-'));
  const repo = join(raiz, 'repo');
  const origen = join(raiz, 'origen.git');
  for (const d of [repo, join(raiz, 'wt'), join(raiz, 'cache', 'ejecuciones', FECHA), join(raiz, 'buzon'), join(raiz, 'bin')]) mkdirSync(d, { recursive: true });
  git(raiz, 'init', '-q', '--bare', origen);
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', origen);
  git(repo, 'push', '-q', 'origin', 'master');
  git(repo, 'fetch', '-q', 'origin');
  const wt = join(raiz, 'wt', `29n-diario-${FECHA}`);
  git(repo, 'worktree', 'add', '-q', '-b', RAMA, wt, 'HEAD');
  const ej = join(raiz, 'cache', 'ejecuciones', FECHA);
  writeFileSync(join(ej, 'etapas.tsv'), `busqueda\tok\t\ntraer-busqueda\tok\t\n${etapa}\tfallo\tcódigo 1\n`);
  writeFileSync(join(ej, 'base.sha'), `${git(repo, 'rev-parse', 'HEAD')}\n`);
  writeFileSync(join(ej, 'descubrir.json'), '{}\n');
  writeFileSync(join(raiz, 'bin', 'claude'), '#!/bin/sh\necho "2.1.322 (Claude Code)"\n');
  chmodSync(join(raiz, 'bin', 'claude'), 0o755);
  return { repo, origen, wt, ej };
}

const entornoExtra: Record<string, string> = {};
function diario(...args: string[]) {
  const r = spawnSync('bash', [SCRIPT, '--fecha', FECHA, '--sin-git', ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: join(raiz, 'tmp'),
      N29_REPO: join(raiz, 'repo'),
      N29_WORKTREES: join(raiz, 'wt'),
      N29_CACHE: join(raiz, 'cache'),
      N29_BUZON: join(raiz, 'buzon'),
      N29_PRESUPUESTO_USD: '1',
      N29_CLAUDE: join(raiz, 'bin', 'claude'),
      ...entornoExtra,
    },
  });
  return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
}

const sellar = () => {
  const { codigo, salida } = diario('--sellar');
  expect(codigo, salida).toBe(0);
  return /--reanudar ([0-9a-f]{64})/.exec(salida)![1]!;
};

afterEach(() => {
  rmSync(raiz, { recursive: true, force: true });
});

describe('diario.sh --reanudar', { timeout: 60_000 }, () => {
  it('needs a run folder stopped at a resumable stage, and a seal', () => {
    preparar('alcance');
    mkdirSync(join(raiz, 'tmp'));
    expect(diario('--sellar').salida).toMatch(/--sellar: la ejecución del 2026-11-11 no se detuvo en una etapa que se pueda reanudar/);
    expect(diario('--reanudar', 'a'.repeat(64)).salida).toMatch(/no se detuvo en una etapa que se pueda reanudar/);
    rmSync(raiz, { recursive: true, force: true });
    preparar();
    mkdirSync(join(raiz, 'tmp'));
    expect(diario('--reanudar', 'a'.repeat(64)).salida).toMatch(/no hay sello \(reanudar.sello\); créalo con --sellar/);
    expect(diario('--reanudar').salida).toMatch(/falta el valor de --reanudar/);
  });

  it('checks the seal: its sha256, then the run folder, the cache and bloqueados.json against it', () => {
    const { ej } = preparar();
    mkdirSync(join(raiz, 'tmp'));
    const sello = sellar();
    expect(diario('--sellar').salida).toMatch(/ya hay un sello/);
    expect(diario('--reanudar', 'b'.repeat(64)).salida).toMatch(/el sha256 del sello no es el que se dio/);
    writeFileSync(join(ej, 'descubrir.json'), '{"cambiado": true}\n');
    expect(diario('--reanudar', sello).salida).toMatch(/cambiaron desde el sello/);
    writeFileSync(join(ej, 'descubrir.json'), '{}\n');
    writeFileSync(join(raiz, 'cache', 'bloqueados.json'), '{}\n');
    expect(diario('--reanudar', sello).salida).toMatch(/cambiaron desde el sello/);
  });

  it('refuses a day whose search retry already started, or with later files', () => {
    const { ej } = preparar();
    mkdirSync(join(raiz, 'tmp'));
    writeFileSync(join(ej, 'busqueda-reintento.iniciado'), '');
    expect(diario('--reanudar', sellar()).salida).toMatch(/ya empezó su sesión de reintento/);
    rmSync(join(ej, 'busqueda-reintento.iniciado'));
    rmSync(join(ej, 'reanudar.sello'));
    mkdirSync(join(ej, 'clasificacion'));
    writeFileSync(join(ej, 'clasificacion', 'x.pp.json'), '{}');
    expect(diario('--reanudar', sellar()).salida).toMatch(/ya tiene archivos de etapas posteriores/);
  });

  it('checks the worktree: clean, on its branch, at the base, in N29_REPO, and the branch not on the remote', () => {
    const { repo, origen, wt, ej } = preparar();
    mkdirSync(join(raiz, 'tmp'));
    writeFileSync(join(wt, 'suelto.txt'), 'x');
    const sello = sellar();
    expect(diario('--reanudar', sello).salida).toMatch(/el worktree tiene cambios o archivos sin seguir/);
    rmSync(join(wt, 'suelto.txt'));
    writeFileSync(join(ej, 'base.sha'), `${'0'.repeat(40)}\n`);
    rmSync(join(ej, 'reanudar.sello'));
    expect(diario('--reanudar', sellar()).salida).toMatch(/el HEAD del worktree no es la base del día/);
    writeFileSync(join(ej, 'base.sha'), `${git(repo, 'rev-parse', 'HEAD')}\n`);
    rmSync(join(ej, 'reanudar.sello'));
    git(repo, 'push', '-q', origen, `${RAMA}:${RAMA}`);
    expect(diario('--reanudar', sellar()).salida).toMatch(/la rama data\/29n-diario-2026-11-11 ya existe en origin/);
  });

  it('resumes at the search check when every check passes', () => {
    preparar();
    mkdirSync(join(raiz, 'tmp'));
    const { salida } = diario('--reanudar', sellar());
    expect(salida).toMatch(/Recogida del 2026-11-11: se reanuda en busqueda-completa/);
    // The empty test folder has no equidad-tareas.json: the check fails, as it must.
    expect(salida).toMatch(/FALLO en busqueda-completa/);
  });

  it('resumes at the classification after a failed classification, and keeps any adjudication aside', () => {
    const { ej } = preparar('clasificacion');
    mkdirSync(join(raiz, 'tmp'));
    mkdirSync(join(ej, 'adjudicado'));
    writeFileSync(join(ej, 'adjudicado', 'pp.json'), '{}');
    const { salida } = diario('--reanudar', sellar());
    expect(salida).toMatch(/se reanuda en tareas-clasificar/);
    expect(spawnSync('ls', [join(ej, 'anterior', 'adjudicacion-1', 'adjudicado')], { encoding: 'utf8' }).stdout.trim()).toBe('pp.json');
  });

  it('resumes a failed adjudication at the shared facts: keeps valid facts and parties, runs one session per missing party, retries once', () => {
    const { ej } = preparar('adjudicacion-completa');
    mkdirSync(join(raiz, 'tmp'));
    writeFileSync(join(ej, 'etapas.tsv'), 'busqueda\tok\t\ntraer-busqueda\tok\t\ntareas-clasificar\tok\t\nclasificacion\tok\t\nadjudicacion\tok\t\nadjudicacion-completa\tfallo\tcódigo 1\n');
    writeFileSync(join(ej, 'tareas-clasificar.json'), '[]\n');
    writeFileSync(join(ej, 'hechos.json'), '{"hechos": [], "descartados": []}\n');
    mkdirSync(join(ej, 'adjudicado'));
    const valida = (p: string) => `{"partido": "${p}", "propuestas": [], "decisiones": []}\n`;
    writeFileSync(join(ej, 'adjudicado', 'frente-amplio.json'), valida('frente-amplio'));
    writeFileSync(join(ej, 'adjudicado', 'vox.json.error.txt'), '{"partido": "vox", ...\n');
    // A stand-in call: it answers its party's adjudication on stdout, except in pp's first call, where it returns no structured output.
    const sesiones = join(raiz, 'sesiones.txt');
    writeFileSync(
      join(raiz, 'bin', 'claude'),
      `#!/bin/sh
[ "$1" = --version ] && { echo "2.1.322 (Claude Code)"; exit 0; }
p="$(sed -n 's/^Your party is \\([a-z-]*\\):.*/\\1/p' | head -n 1)"
echo "$p" >>'${sesiones}'
if [ "$p" != pp ] || [ "$(grep -c -x pp '${sesiones}')" = 2 ]; then
  printf '{"is_error": false, "structured_output": {"partido": "%s", "propuestas": [], "decisiones": [], "objeciones_hechos": [], "hosts_sin_registrar": [], "avisos": []}}\\n' "$p"
else
  # As claude -p does on an error (here, the budget): JSON on stdout with the cost so far, exit 1.
  echo '{"is_error": true, "subtype": "error_max_budget_usd", "total_cost_usd": 0.5}'
  exit 1
fi
`,
    );
    const { salida } = diario('--reanudar', sellar());
    expect(salida).toMatch(/se reanuda en hechos/);
    const etapas = readFileSync(join(ej, 'etapas.tsv'), 'utf8');
    // The classification is not redone; the kept facts and frente-amplio are not either.
    expect(etapas.split('reanudar\t')[1]).not.toMatch(/^(tareas-clasificar|clasificacion)\t/m);
    expect(etapas).toMatch(/^hechos\tok\t\nadjudicacion\tok\t\nadjudicacion-completa\tok\t$/m);
    expect(readFileSync(sesiones, 'utf8')).toBe('pp\npsoe\nvox\npp\n');
    expect(readFileSync(join(ej, 'adjudicado', 'frente-amplio.json'), 'utf8')).toBe(valida('frente-amplio'));
    expect(readFileSync(join(ej, 'anterior', 'adjudicacion-1', 'adjudicado', 'vox.json.error.txt'), 'utf8')).toBe('{"partido": "vox", ...\n');
    // Each session's audit copy under its own name; pp's first attempt kept as .intento-1.
    const claude = readdirSync(join(ej, 'claude'));
    expect(claude).toEqual(expect.arrayContaining(['adjudicacion-pp.prompt-1.txt', 'adjudicacion-pp.intento-1.prompt-1.txt', 'adjudicacion-vox.settings.json', 'adjudicacion-vox.esquema.json']));
    expect(claude.some((f) => f.startsWith('hechos.') || f.startsWith('adjudicacion-frente-amplio.'))).toBe(false);
    expect(readFileSync(join(ej, 'claude', 'adjudicacion-pp.prompt-1.txt'), 'utf8')).toContain('Your party is pp:');
    // The script wrote the answer from the structured output; pp's failed first call left only its error file, set aside.
    expect(JSON.parse(readFileSync(join(ej, 'adjudicado', 'pp.json'), 'utf8')).partido).toBe('pp');
    // A failed call does not end the day: its answer is missing, and the second round redoes it.
    expect(readFileSync(join(ej, 'anterior', 'adjudicacion-2', 'adjudicado', 'pp.json.error.txt'), 'utf8')).toMatch(/terminó con error: error_max_budget_usd/);
    const registro = readFileSync(join(ej, 'diario.log'), 'utf8');
    expect(registro).toMatch(/llamada 1 de 1 terminó con código 1/);
    expect(readFileSync(join(ej, 'gasto.tsv'), 'utf8')).toMatch(/^adjudicacion-pp\t1\t0\.5\t\d+$/m);
  });

  /** A day stopped at the adjudication check, frente-amplio complete, and a stand-in claude that costs `coste` per call and fails pp's first call. */
  const adjudicacionConCoste = (coste: string) => {
    const { ej } = preparar('adjudicacion-completa');
    mkdirSync(join(raiz, 'tmp'));
    writeFileSync(join(ej, 'etapas.tsv'), 'busqueda\tok\t\ntraer-busqueda\tok\t\ntareas-clasificar\tok\t\nclasificacion\tok\t\nadjudicacion\tok\t\nadjudicacion-completa\tfallo\tcódigo 1\n');
    writeFileSync(join(ej, 'tareas-clasificar.json'), '[]\n');
    writeFileSync(join(ej, 'hechos.json'), '{"hechos": [], "descartados": []}\n');
    mkdirSync(join(ej, 'adjudicado'));
    writeFileSync(join(ej, 'adjudicado', 'frente-amplio.json'), '{"partido": "frente-amplio", "propuestas": [], "decisiones": []}\n');
    const sesiones = join(raiz, 'sesiones.txt');
    writeFileSync(
      join(raiz, 'bin', 'claude'),
      `#!/bin/sh
[ "$1" = --version ] && { echo "2.1.322 (Claude Code)"; exit 0; }
p="$(sed -n 's/^Your party is \\([a-z-]*\\):.*/\\1/p' | head -n 1)"
echo "$p" >>'${sesiones}'
if [ "$p" != pp ] || [ "$(grep -c -x pp '${sesiones}')" = 2 ]; then
  printf '{"is_error": false, "total_cost_usd": ${coste}, "structured_output": {"partido": "%s", "propuestas": [], "decisiones": [], "objeciones_hechos": [], "hosts_sin_registrar": [], "avisos": []}}\\n' "$p"
else
  echo '{"is_error": true, "subtype": "error_max_budget_usd", "total_cost_usd": ${coste}}'
  exit 1
fi
`,
    );
    return { ej, sesiones };
  };

  it('never skips a call for money: costs over N29_PRESUPUESTO_USD are recorded, every call and retry is made, and the day goes on', () => {
    const { ej, sesiones } = adjudicacionConCoste('0.9');
    const { salida } = diario('--reanudar', sellar());
    expect(salida).not.toMatch(/FALLO en adjudicacion/);
    // pp's first call failed and its retry was still made, though the reported costs add up to more than 1 dollar.
    expect(readFileSync(sesiones, 'utf8')).toBe('pp\npsoe\nvox\npp\n');
    expect(readFileSync(join(ej, 'etapas.tsv'), 'utf8')).toMatch(/^adjudicacion-completa\tok\t$/m);
    // Session, call, reported cost and seconds, for information.
    expect(readFileSync(join(ej, 'gasto.tsv'), 'utf8')).toMatch(/^adjudicacion-pp\t1\t0\.9\t\d+\nadjudicacion-psoe\t1\t0\.9\t\d+\nadjudicacion-vox\t1\t0\.9\t\d+\nadjudicacion-pp\t1\t0\.9\t\d+\n$/);
    // The per-call guard is at least 100 dollars whatever N29_PRESUPUESTO_USD says.
    expect(readFileSync(join(ej, 'diario.log'), 'utf8')).not.toMatch(/presupuesto/i);
  });

  it('redoes in the second round only the adjudication batches that failed, and keeps the valid ones', () => {
    const { ej } = adjudicacionConCoste('0.1');
    // pp has two documents of 200 000 characters: two batches.
    const docs = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
    const tareas = docs.map((doc_id) => ({ doc_id, partido: 'pp', url: `https://medio.es/${doc_id}`, url_canonica: `https://medio.es/${doc_id}`, via: 'rss', consultado: FECHA, origen: ['alias'], texto: '', meta: '', salida: `clasificacion/${doc_id}.pp.json` }));
    writeFileSync(join(ej, 'tareas-clasificar.json'), `${JSON.stringify(tareas)}\n`);
    mkdirSync(join(ej, 'clasificacion'));
    for (const doc_id of docs) {
      writeFileSync(join(ej, 'clasificacion', `${doc_id}.pp.json`), JSON.stringify({ doc_id, partido: 'pp', relevante: true, seccion: 'temas' }));
      mkdirSync(join(raiz, 'cache', 'docs', doc_id), { recursive: true });
      writeFileSync(join(raiz, 'cache', 'docs', doc_id, 'meta.json'), JSON.stringify({ url: `https://medio.es/${doc_id}`, url_canonica: `https://medio.es/${doc_id}`, consultado: FECHA, via: 'rss' }));
      writeFileSync(join(raiz, 'cache', 'docs', doc_id, 'texto.txt'), `${doc_id} `.repeat(12_000));
    }
    for (const p of ['psoe', 'vox']) writeFileSync(join(ej, 'adjudicado', `${p}.json`), `{"partido": "${p}", "propuestas": [], "decisiones": []}\n`);
    // A stand-in that answers each batch with a decision per document it carries, but fails pp's batch of b… the first time.
    const llamadas = join(raiz, 'llamadas.txt');
    writeFileSync(
      join(raiz, 'bin', 'claude'),
      `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('2.1.322 (Claude Code)'); process.exit(0); }
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
const partido = /^Your party is ([a-z-]+):/m.exec(prompt)[1];
const docs = [...prompt.matchAll(/^DOCUMENTO ([0-9a-f]{16}):$/gm)].map((m) => m[1]);
fs.appendFileSync('${llamadas}', partido + ' ' + docs.join(',') + '\\n');
const vistas = fs.readFileSync('${llamadas}', 'utf8').split('\\n').filter((l) => l === partido + ' ' + docs.join(',')).length;
if (docs.includes('bbbbbbbbbbbbbbbb') && vistas === 1) { console.log(JSON.stringify({ is_error: true, subtype: 'error_during_execution' })); process.exit(1); }
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.1, structured_output: { partido, propuestas: [], decisiones: docs.map((doc_id) => ({ doc_id, decision: 'descartado', motivo: 'x' })), objeciones_hechos: [], hosts_sin_registrar: [], avisos: [] } }));
`,
    );
    chmodSync(join(raiz, 'bin', 'claude'), 0o755);
    diario('--reanudar', sellar());
    // The adjudication completes (this test folder has no site data, so the day stops later, at preparar).
    expect(readFileSync(join(ej, 'etapas.tsv'), 'utf8')).toMatch(/^adjudicacion-completa\tok\t$/m);
    // Round 1: both batches; round 2: only the failed one. The valid batch was kept, not asked again.
    expect(readFileSync(llamadas, 'utf8')).toBe('pp aaaaaaaaaaaaaaaa\npp bbbbbbbbbbbbbbbb\npp bbbbbbbbbbbbbbbb\n');
    expect(readFileSync(join(ej, 'diario.log'), 'utf8')).toMatch(/llamada 1 de 2: lote ya respondido bien en una ronda anterior/);
    const pp = JSON.parse(readFileSync(join(ej, 'adjudicado', 'pp.json'), 'utf8'));
    expect(pp.decisiones.map((d: { doc_id: string }) => d.doc_id)).toEqual(docs);
  });

  it('does not keep for the second round a batch whose answer leaves out a decision: it is asked again, and the day passes', () => {
    const { ej } = adjudicacionConCoste('0.1');
    const doc_id = 'cccccccccccccccc';
    writeFileSync(join(ej, 'tareas-clasificar.json'), `${JSON.stringify([{ doc_id, partido: 'pp', url: 'https://medio.es/c', url_canonica: 'https://medio.es/c', via: 'rss', consultado: FECHA, origen: ['alias'], texto: '', meta: '', salida: `clasificacion/${doc_id}.pp.json` }])}\n`);
    mkdirSync(join(ej, 'clasificacion'));
    writeFileSync(join(ej, 'clasificacion', `${doc_id}.pp.json`), JSON.stringify({ doc_id, partido: 'pp', relevante: true, seccion: 'temas' }));
    mkdirSync(join(raiz, 'cache', 'docs', doc_id), { recursive: true });
    writeFileSync(join(raiz, 'cache', 'docs', doc_id, 'meta.json'), JSON.stringify({ url: 'https://medio.es/c', url_canonica: 'https://medio.es/c', consultado: FECHA, via: 'rss' }));
    writeFileSync(join(raiz, 'cache', 'docs', doc_id, 'texto.txt'), 'Texto.');
    for (const p of ['psoe', 'vox']) writeFileSync(join(ej, 'adjudicado', `${p}.json`), `{"partido": "${p}", "propuestas": [], "decisiones": []}\n`);
    // Round 1: a schema-valid answer with no decision for the document. Round 2: complete.
    const llamadas = join(raiz, 'llamadas.txt');
    writeFileSync(
      join(raiz, 'bin', 'claude'),
      `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('2.1.322 (Claude Code)'); process.exit(0); }
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
const docs = [...prompt.matchAll(/^DOCUMENTO ([0-9a-f]{16}):$/gm)].map((m) => m[1]);
fs.appendFileSync('${llamadas}', 'pp\\n');
const primera = fs.readFileSync('${llamadas}', 'utf8').split('\\n').filter(Boolean).length === 1;
const decisiones = primera ? [] : docs.map((doc_id) => ({ doc_id, decision: 'descartado', motivo: 'x' }));
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.1, structured_output: { partido: 'pp', propuestas: [], decisiones, objeciones_hechos: [], hosts_sin_registrar: [], avisos: [] } }));
`,
    );
    chmodSync(join(raiz, 'bin', 'claude'), 0o755);
    diario('--reanudar', sellar());
    expect(readFileSync(llamadas, 'utf8')).toBe('pp\npp\n');
    expect(readFileSync(join(ej, 'diario.log'), 'utf8')).toContain(`sin decisión para el documento ${doc_id}`);
    expect(readFileSync(join(ej, 'diario.log'), 'utf8')).not.toMatch(/se reutiliza/);
    expect(readFileSync(join(ej, 'etapas.tsv'), 'utf8')).toMatch(/^adjudicacion-completa\tok\t$/m);
  });

  // A day stopped at the site checks after the merge (11 Nov 2026): the merge runs again from the kept adjudication.
  const trasLaFusion = (ej: string) => {
    writeFileSync(join(ej, 'etapas.tsv'), 'traer-busqueda\tok\t\nclasificacion\tok\t\nadjudicacion-completa\tok\t\npreparar\tok\t\nfusionar\tok\t\najustar\tok\t\nalcance\tok\t\ntest\tfallo\tcódigo 1\nresumen\tok\t\ncomprobaciones\tfallo\talguna comprobación falló\n');
    mkdirSync(join(ej, 'fusion'));
    for (const f of ['fusion/pp.json', 'preparar.json', 'fusionar.json', 'ajustar.json', 'citas-nuevas.txt']) writeFileSync(join(ej, f), '{}\n');
  };

  it('resumes a day stopped at the site checks from the merge: the worktree back to its base, the earlier merge set aside', () => {
    const { repo, wt, ej } = preparar('comprobaciones');
    mkdirSync(join(raiz, 'tmp'));
    trasLaFusion(ej);
    // The merge's own output (allowlisted) and an ignored install folder.
    mkdirSync(join(wt, 'apps', '29n', 'src', 'data'), { recursive: true });
    writeFileSync(join(wt, 'apps', '29n', 'src', 'data', 'busquedas.json'), '{"busquedas": []}\n');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'node_modules/\n');
    mkdirSync(join(wt, 'node_modules'));
    writeFileSync(join(wt, 'node_modules', 'x.js'), '');
    const { salida } = diario('--reanudar', sellar());
    expect(salida).toMatch(/se reanuda en preparar/);
    const etapas = readFileSync(join(ej, 'etapas.tsv'), 'utf8').split('reanudar\t')[1]!;
    expect(etapas).toMatch(/^reponer\tok\t\nadjudicacion-completa\t/m);
    expect(etapas).not.toMatch(/^(hechos|adjudicacion|clasificacion)\t/m);
    expect(git(wt, 'status', '--porcelain', '--ignored')).toBe('');
    expect(readdirSync(join(ej, 'anterior', 'fusion-1')).sort()).toEqual(['ajustar.json', 'citas-nuevas.txt', 'fusion', 'fusionar.json', 'preparar.json']);
  });

  it('moves the day to the current origin/master when it leaves the data the run read unchanged, and records the new base', () => {
    const { repo, wt, ej } = preparar('comprobaciones');
    mkdirSync(join(raiz, 'tmp'));
    trasLaFusion(ej);
    const vieja = git(repo, 'rev-parse', 'HEAD');
    // A site fix merged after the day's base: a test and the methodology, no data the run read.
    mkdirSync(join(repo, 'apps', '29n', 'src', 'data'), { recursive: true });
    writeFileSync(join(repo, 'apps', '29n', 'src', 'data', 'metodologia.md'), 'nuevo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'fix del sitio');
    git(repo, 'push', '-q', 'origin', 'master');
    const nueva = git(repo, 'rev-parse', 'HEAD');
    const { salida } = diario('--reanudar', sellar());
    expect(salida).toMatch(/se reanuda en preparar/);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(nueva);
    expect(git(repo, 'rev-parse', RAMA)).toBe(nueva);
    expect(readFileSync(join(ej, 'base.sha'), 'utf8')).toBe(`${nueva}\n`);
    expect(readFileSync(join(ej, 'bases-anteriores.txt'), 'utf8')).toBe(`${vieja}\n`);
    expect(readFileSync(join(ej, 'etapas.tsv'), 'utf8')).toMatch(new RegExp(`^base\tok\t${vieja} → ${nueva} \\(origin/master\\)\nreponer\tok\t$`, 'm'));
  });

  it('keeps the base, and touches nothing, when origin/master changed data the run read', () => {
    const { repo, wt, ej } = preparar('comprobaciones');
    mkdirSync(join(raiz, 'tmp'));
    trasLaFusion(ej);
    const vieja = git(repo, 'rev-parse', 'HEAD');
    mkdirSync(join(repo, 'apps', '29n', 'src', 'data', 'partidos'), { recursive: true });
    writeFileSync(join(repo, 'apps', '29n', 'src', 'data', 'partidos', 'pp.json'), '{}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'datos nuevos');
    git(repo, 'push', '-q', 'origin', 'master');
    mkdirSync(join(wt, 'apps', '29n', 'src', 'data'), { recursive: true });
    writeFileSync(join(wt, 'apps', '29n', 'src', 'data', 'busquedas.json'), '{"busquedas": []}\n');
    const { salida } = diario('--reanudar', sellar());
    expect(salida).toMatch(/FALLO en reponer/);
    expect(readFileSync(join(raiz, 'cache', 'ejecuciones', FECHA, 'diario.log'), 'utf8')).toMatch(/cambió datos que la ejecución leyó/);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(vieja);
    expect(readFileSync(join(wt, 'apps', '29n', 'src', 'data', 'busquedas.json'), 'utf8')).toBe('{"busquedas": []}\n');
    expect(readdirSync(ej)).toContain('fusion');
  });

  it('does not reset a worktree with a change the merge does not make, nor resume from the merge without a passed adjudication', () => {
    const { wt, ej } = preparar('comprobaciones');
    mkdirSync(join(raiz, 'tmp'));
    trasLaFusion(ej);
    writeFileSync(join(wt, 'suelto.txt'), 'x');
    const { salida } = diario('--reanudar', sellar());
    expect(salida).toMatch(/FALLO en reponer/);
    expect(readFileSync(join(wt, 'suelto.txt'), 'utf8')).toBe('x');
    expect(readdirSync(ej)).toContain('fusion');
    rmSync(join(wt, 'suelto.txt'));
    writeFileSync(join(ej, 'etapas.tsv'), 'adjudicacion-completa\tfallo\tcódigo 1\nadjudicacion-completa\tok\t\nadjudicacion-completa\tfallo\tcódigo 1\ncomprobaciones\tfallo\tx\n');
    rmSync(join(ej, 'reanudar.sello'));
    expect(diario('--reanudar', sellar()).salida).toMatch(/la adjudicación de ese día no terminó/);
  });

  it('refuses to resume at the shared facts when the classification did not pass', () => {
    const { ej } = preparar('adjudicacion-completa');
    mkdirSync(join(raiz, 'tmp'));
    writeFileSync(join(ej, 'etapas.tsv'), 'traer-busqueda\tok\t\nclasificacion\tok\t\ntareas-clasificar\tok\t\nadjudicacion-completa\tfallo\tcódigo 1\n');
    expect(diario('--reanudar', sellar()).salida).toMatch(/la clasificación de ese día no terminó/);
  });
});

/** auditar_conf as diario.sh defines it, run on its own with CONF and EJ in temp folders. */
describe('diario.sh auditar_conf', () => {
  const auditar = (conf: string, ej: string, pasada: string) =>
    spawnSync('bash', ['-c', 'set -euo pipefail; eval "$(sed -n "/^auditar_conf() {/,/^}/p" "$1")"; auditar_conf "$2"', '_', SCRIPT, pasada], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CONF: conf, EJ: ej },
    });
  const ARCHIVOS = ['settings.json', 'agentes.json', 'prompt.txt', 'busquedas-web.txt', 'herramientas.txt', 'carpetas.txt'];

  it('keeps an earlier attempt of the same pass as .intento-N, read-only copies included', () => {
    raiz = mkdtempSync(join(tmpdir(), 'n29-auditar-'));
    const conf = join(raiz, 'conf');
    const ej = join(raiz, 'ej');
    const claude = join(ej, 'claude');
    mkdirSync(conf);
    const intento = (n: number) => {
      for (const f of ARCHIVOS) {
        chmodSync(conf, 0o755);
        rmSync(join(conf, f), { force: true });
        writeFileSync(join(conf, f), `${f} ${n}\n`);
        chmodSync(join(conf, f), 0o444);
      }
      const r = auditar(conf, ej, 'adjudicacion');
      expect(r.status, r.stderr).toBe(0);
      // claude_pasada copies the session's answer next to the audit copies, writable.
      writeFileSync(join(claude, 'adjudicacion.salida.json'), `salida ${n}\n`);
    };
    intento(1);
    // Another pass with a name that starts the same way is not part of it.
    writeFileSync(join(claude, 'adjudicacion-otra.prompt.txt'), 'otra\n');
    intento(2);
    intento(3);
    const leer = (f: string) => readFileSync(join(claude, f), 'utf8');
    for (const f of ARCHIVOS) {
      expect(leer(`adjudicacion.intento-1.${f}`)).toBe(`${f} 1\n`);
      expect(leer(`adjudicacion.intento-2.${f}`)).toBe(`${f} 2\n`);
      expect(leer(`adjudicacion.${f}`)).toBe(`${f} 3\n`);
      expect(statSync(join(claude, `adjudicacion.${f}`)).mode & 0o777).toBe(0o444);
      expect(statSync(join(claude, `adjudicacion.intento-1.${f}`)).mode & 0o777).toBe(0o444);
    }
    expect(leer('adjudicacion.intento-1.salida.json')).toBe('salida 1\n');
    expect(leer('adjudicacion.intento-2.salida.json')).toBe('salida 2\n');
    expect(leer('adjudicacion-otra.prompt.txt')).toBe('otra\n');
    expect(readdirSync(claude).filter((f) => f.startsWith('adjudicacion.')).length).toBe(3 * (ARCHIVOS.length + 1));
  });
});
