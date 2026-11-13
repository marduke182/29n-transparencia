#!/usr/bin/env bash
# Daily run of 29n.jrquintana.dev (agentes/08-diario.md). Ends in a draft PR
# for the owner's review; it never merges, deploys, enables auto-merge or
# pushes anything but its own data/29n-diario-<fecha> branch.
#
#   diario.sh                          today's run (the date is read once, here)
#   diario.sh --fecha 2026-11-12       a missed day, by argument, never by clock
#   diario.sh --fecha D --sin-git      every stage, Claude included, but no commit, push or PR
#   diario.sh --fecha D --reanudar SHA a day that failed at the search check, at classification or
#                                      adjudication, or at the merge or the site checks: resumes there
#                                      (the merge from the kept adjudication, on the worktree moved to
#                                      the current base branch), after checking the seal SHA it printed
#   diario.sh --fecha D --sellar       writes that seal for a failed day that has none (older runs)
#                                      (see "Reanudar un día" in recogida/README.md)
#   diario.sh --fecha D --seco [--salida DIR]
#                                      dry run: the CLI stages against the fixture
#                                      in fixtures/diario, offline, without Claude,
#                                      the site checks or git; prints a digest
#   diario.sh --fecha D --atrasos-desde D1 --atrasos-hasta D2 --atrasos-emisores a,b
#                                      atrasos: the day's run plus one more search task per named
#                                      source for D1..D2 (not with --reanudar or --sellar)
#
# Environment (live runs; see recogida/README.md):
#   N29_REPO             checkout of the site repository (the worktree is created from it)
#   N29_WORKTREES        folder for the run worktrees (<N29_WORKTREES>/29n-diario-<fecha>)
#   N29_CACHE            cache and run folders, outside any repository
#   N29_BUZON            the owner's manual inbox
#   N29_PRESUPUESTO_USD  runaway guard of each Claude call (--max-budget-usd, at least 100; required). Never a reason
#                        to skip a call: what each call costs is only recorded, in gasto.tsv
#   N29_CLAUDE           claude binary (default: claude), version 2.1.322 exactly (N29_CLAUDE_VERSION_OK=1 for a newer one)
#   N29_RAMA_BASE        base branch (default: master), N29_REMOTO (default: origin)
#   N29_LIMITE_CLAUDE_S, N29_LIMITE_VIDEO_S (above 14400), N29_MODELO_WHISPER   optional
#   N29_GH_TOKEN         optional: the dedicated token for the push and the PR, used only there
#   N29_EXIGIR_TOKEN     1: refuse to start without N29_GH_TOKEN (default 0: the machine's git and gh credentials)
#
# Security model: no Claude call reads or writes a file. The script puts each pass's material
# into its prompt (diario.ts, juicio.ts), the answer comes back on stdout as structured output
# (--json-schema), and the script checks it and writes the answer files. The classification,
# facts and adjudication calls have no tools at all; only the search passes have Agent for their
# two subagents, WebSearch and WebFetch for the hosts of fuentes.json and the day's equal searches.
# Its settings, agents and prompts are built from this repository right before
# each pass into a fresh folder outside every folder it can write to, checked
# by sha256, and it starts from an empty folder there. Files the script relies
# on are sealed by sha256 before each pass and checked after it. Only the
# script writes the site, and only the allowlisted JSON files.
# Bash 3.2 compatible (macOS /bin/bash).
set -euo pipefail

uso() {
  sed -n '6,21p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
die() {
  printf 'diario.sh: %s\n' "$*" >&2
  exit 2
}
valor() { [ $# -ge 2 ] && [ -n "$2" ] || die "falta el valor de $1"; }

FECHA=""
SECO=0
SIN_GIT=0
REANUDAR=0
SELLO_ESPERADO=""
SELLAR=0
SALIDA=""
ATRASOS_DESDE=""
ATRASOS_HASTA=""
ATRASOS_EMISORES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fecha) valor "$@"; FECHA="$2"; shift 2 ;;
    --salida) valor "$@"; SALIDA="$2"; shift 2 ;;
    --seco) SECO=1; shift ;;
    --sin-git) SIN_GIT=1; shift ;;
    --reanudar) valor "$@"; REANUDAR=1; SELLO_ESPERADO="$2"; shift 2 ;;
    --sellar) SELLAR=1; shift ;;
    --atrasos-desde) valor "$@"; ATRASOS_DESDE="$2"; shift 2 ;;
    --atrasos-hasta) valor "$@"; ATRASOS_HASTA="$2"; shift 2 ;;
    --atrasos-emisores) valor "$@"; ATRASOS_EMISORES="$2"; shift 2 ;;
    -h | --help) uso ;;
    *) die "opción desconocida: $1" ;;
  esac
done

HOY="$(date +%F)" # the only clock read of the run
FECHA="${FECHA:-$HOY}"
# fecha_valida <opción> <valor>: AAAA-MM-DD and a real calendar date (parsed, not read from the clock): 2026-02-30 is refused.
fecha_valida() {
  case "$2" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) die "$1 debe ser AAAA-MM-DD" ;;
  esac
  [ "$(date -j -f %F "$2" +%F 2>/dev/null || date -d "$2" +%F 2>/dev/null)" = "$2" ] || die "$1 $2 no es una fecha"
}
fecha_valida --fecha "$FECHA"
# Atrasos: the three options together or none; descubrir checks the ids against fuentes.json and the window against --fecha.
ATRASOS=()
if [ -n "$ATRASOS_DESDE$ATRASOS_HASTA$ATRASOS_EMISORES" ]; then
  [ -n "$ATRASOS_DESDE" ] && [ -n "$ATRASOS_HASTA" ] && [ -n "$ATRASOS_EMISORES" ] || die "--atrasos-desde, --atrasos-hasta y --atrasos-emisores van juntas"
  fecha_valida --atrasos-desde "$ATRASOS_DESDE"
  fecha_valida --atrasos-hasta "$ATRASOS_HASTA"
  [ ! "$ATRASOS_DESDE" \> "$ATRASOS_HASTA" ] || die "--atrasos-desde $ATRASOS_DESDE es posterior a --atrasos-hasta $ATRASOS_HASTA"
  [ ! "$ATRASOS_HASTA" \> "$FECHA" ] || die "--atrasos-hasta $ATRASOS_HASTA es posterior a --fecha $FECHA"
  printf '%s\n' "$ATRASOS_EMISORES" | grep -E -q -x '[a-z0-9-]+(,[a-z0-9-]+)*' || die "--atrasos-emisores debe ser una lista de ids separados por comas (a-z, 0-9, -)"
  [ "$REANUDAR" = 0 ] && [ "$SELLAR" = 0 ] || die "--atrasos-* no valen con --reanudar ni con --sellar"
  ATRASOS=(--atrasos-desde "$ATRASOS_DESDE" --atrasos-hasta "$ATRASOS_HASTA" --atrasos-emisores "$ATRASOS_EMISORES")
fi
[ "$SECO" = 1 ] || [ ! "$FECHA" \> "$HOY" ] || die "--fecha $FECHA es posterior a hoy ($HOY)"
[ -z "$SALIDA" ] || [ "$SECO" = 1 ] || die "--salida solo vale con --seco"
[ "$REANUDAR" = 0 ] && [ "$SELLAR" = 0 ] || [ "$SECO" = 0 ] || die "--reanudar y --sellar no valen con --seco"
[ "$REANUDAR" = 0 ] && [ "$SELLAR" = 0 ] || [ -n "$FECHA" ] || die "--reanudar y --sellar necesitan --fecha"
[ "$REANUDAR" = 0 ] || [ "$SELLAR" = 0 ] || die "--reanudar y --sellar no van juntos"
case "$SELLO_ESPERADO" in '' | [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;; *) die "--reanudar necesita el sha256 del sello" ;; esac

RECOGIDA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
T="$(cd "$RECOGIDA/.." && pwd -P)"
FIJOS="$RECOGIDA/fixtures/diario"
PARTIDOS="frente-amplio pp psoe vox"
command -v node >/dev/null || die "falta node"
command -v perl >/dev/null || die "falta perl"
command -v shasum >/dev/null || die "falta shasum"

# In --seco every node process loads the fixed network; passed as a file URL, so a path with spaces is fine.
IMPORTAR=""
nodo() {
  if [ -n "$IMPORTAR" ]; then node --import "$IMPORTAR" "$@"; else node "$@"; fi
}
cli() { nodo "$RECOGIDA/bin/29n-recogida.ts" "$@"; }
glue() {
  local paso="$1"
  shift
  nodo "$RECOGIDA/src/diario.ts" "$paso" --fecha "$FECHA" "$@"
}
# con_limite <segundos> <comando…>: a watchdog; SIGALRM ends the command when time is up.
con_limite() {
  local segundos="$1"
  shift
  perl -e 'alarm shift @ARGV; exec { $ARGV[0] } @ARGV or die "exec: $!\n"' "$segundos" "$@"
}
real() { (cd "$1" && pwd -P); }
CLAUDE_MINIMA="2.1.322"
# The version the permissions were checked against, and Claude Code's preapproved WebFetch domains read from
# (diario.ts, WEBFETCH_PREAPROBADOS and CLAUDE_VERIFICADA): a newer one could preapprove more domains, so it
# runs only with N29_CLAUDE_VERSION_OK=1, after the list is checked again.
CLAUDE_VERIFICADA="2.1.322"
# version_minima <versión> <mínima>: true when x.y.z >= the minimum.
version_minima() {
  local v="$1" m="$2" a b i
  case "$v" in [0-9]*.[0-9]*.[0-9]*) ;; *) return 1 ;; esac
  for i in 1 2 3; do
    a="$(printf '%s' "$v" | cut -d. -f"$i" | tr -cd '0-9')"
    b="$(printf '%s' "$m" | cut -d. -f"$i")"
    [ "${a:-0}" -gt "$b" ] && return 0
    [ "${a:-0}" -lt "$b" ] && return 1
  done
  return 0
}
# dentro <a> <b>: a is b or inside it (both real paths).
dentro() { case "$1/" in "$2"/*) return 0 ;; *) return 1 ;; esac; }

# ------------------------------------------------------------------ setup

if [ "$SECO" = 1 ]; then
  if [ -n "$SALIDA" ]; then
    mkdir -p "$SALIDA"
    [ -z "$(ls -A "$SALIDA")" ] || die "--salida debe ser una carpeta vacía"
    RAIZ="$(real "$SALIDA")"
  else
    RAIZ="$(real "$(mktemp -d "${TMPDIR:-/tmp}/29n-seco.XXXXXX")")"
  fi
  cp -R "$FIJOS/sitio" "$RAIZ/sitio"
  cp -R "$FIJOS/buzon" "$RAIZ/buzon"
  mkdir -p "$RAIZ/cache" "$RAIZ/worktrees"
  N29_CACHE="$RAIZ/cache"
  N29_BUZON="$RAIZ/buzon"
  N29_WORKTREES="$RAIZ/worktrees"
  # Offline: fetch and DNS answer only from fixtures/diario/red (see red-fija.mjs).
  export N29_RED_FIJA="$FIJOS/red"
  IMPORTAR="$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$FIJOS/red-fija.mjs")"
  WT="$RAIZ/sitio"
else
  for variable in N29_REPO N29_WORKTREES N29_CACHE N29_BUZON N29_PRESUPUESTO_USD; do
    eval "[ -n \"\${$variable:-}\" ]" || die "falta la variable de entorno $variable"
  done
  case "$N29_PRESUPUESTO_USD" in
    *[!0-9.]* | .* | *. | *.*.*) die "N29_PRESUPUESTO_USD debe ser un número (dólares)" ;;
  esac
  N29_CLAUDE="${N29_CLAUDE:-claude}"
  BASE="${N29_RAMA_BASE:-master}"
  REMOTO="${N29_REMOTO:-origin}"
  RAMA="data/29n-diario-$FECHA"
  # The push and the PR: with N29_GH_TOKEN, that token only (a fine-grained PAT for the site repository, see
  # recogida/README.md); without it, the machine's own git and gh credentials, unless N29_EXIGIR_TOKEN=1.
  # Kept in an unexported variable: no stage, Claude included, inherits it.
  TOKEN_GH="${N29_GH_TOKEN:-}"
  unset N29_GH_TOKEN
  case "${N29_EXIGIR_TOKEN:-0}" in
    1) [ -n "$TOKEN_GH" ] || [ "$SIN_GIT" = 1 ] || die "N29_EXIGIR_TOKEN=1 y falta N29_GH_TOKEN: no se hace push sin el token dedicado" ;;
    0) ;;
    *) die "N29_EXIGIR_TOKEN debe ser 0 o 1" ;;
  esac
  command -v "$N29_CLAUDE" >/dev/null || die "no se encuentra claude ($N29_CLAUDE)"
  VERSION_CLAUDE="$("$N29_CLAUDE" --version 2>/dev/null | awk '{print $1}')"
  version_minima "$VERSION_CLAUDE" "$CLAUDE_MINIMA" ||
    die "claude debe ser la versión $CLAUDE_MINIMA o posterior (las opciones y permisos de esta ejecución se comprobaron con ella)"
  if [ "$VERSION_CLAUDE" != "$CLAUDE_VERIFICADA" ] && [ "${N29_CLAUDE_VERSION_OK:-0}" != 1 ]; then
    die "claude es la versión $VERSION_CLAUDE y los permisos (los dominios que WebFetch aprueba de serie) se comprobaron con la $CLAUDE_VERIFICADA: revísalos (WEBFETCH_PREAPROBADOS en diario.ts) o ejecuta con N29_CLAUDE_VERSION_OK=1"
  fi
  command -v git >/dev/null || die "falta git"
  command -v gh >/dev/null || [ "$SIN_GIT" = 1 ] || die "falta gh"
  [ -d "$N29_REPO" ] || die "N29_REPO no es una carpeta"
  [ -d "$N29_BUZON" ] || die "N29_BUZON no es una carpeta"
  mkdir -p "$N29_CACHE" "$N29_WORKTREES"
  N29_REPO="$(real "$N29_REPO")"
  N29_CACHE="$(real "$N29_CACHE")"
  N29_BUZON="$(real "$N29_BUZON")"
  N29_WORKTREES="$(real "$N29_WORKTREES")"
  WT="$N29_WORKTREES/29n-diario-$FECHA"
fi
LIMITE_CLAUDE="${N29_LIMITE_CLAUDE_S:-10800}"
# The outer limit per video exceeds the sum of the inner ones (2 × 30 min of yt-dlp + 3 h of Whisper = 4 h).
LIMITE_VIDEO="${N29_LIMITE_VIDEO_S:-18000}"
export N29_SITIO="$WT" N29_CACHE N29_BUZON

# The cache, the inbox, the worktrees and this repository never contain each other.
comprobar_separadas() {
  local a b
  for a in "$@"; do
    for b in "$@"; do
      [ "$a" = "$b" ] && continue
      if dentro "$a" "$b"; then
        echo "diario.sh: $a está dentro de $b: las carpetas de la recogida deben estar separadas" >&2
        return 1
      fi
    done
  done
}
comprobar_separadas "$N29_CACHE" "$N29_BUZON" "$N29_WORKTREES" "$T" || exit 2

DATOS="$WT/apps/29n/src/data"
EJECUCIONES="$N29_CACHE/ejecuciones"
EJ="$EJECUCIONES/$FECHA"
mkdir -p "$EJECUCIONES" "$N29_CACHE/docs"
# Script-private folder (sealed hashes, Claude's raw output): outside every folder Claude can write to.
PRIV="$(real "$(mktemp -d "${TMPDIR:-/tmp}/29n-priv.XXXXXX")")"
chmod 700 "$PRIV"
CONF=""
comprobar_separadas "$PRIV" "$N29_CACHE" "$N29_BUZON" "$N29_WORKTREES" "$T" || { rm -rf "$PRIV"; exit 2; }

# One run at a time (any date): runs share the cache, bloqueados.json and the transcription folder.
BLOQUEO="$EJECUCIONES/.bloqueo"
mkdir "$BLOQUEO" 2>/dev/null || die "ya hay una ejecución en marcha ($BLOQUEO)"
# No audio or partial transcription survives a run (transcripciones.ts works in $N29_CACHE/tmp/tr-*).
barrer_tmp() { find "$N29_CACHE/tmp" -mindepth 1 -maxdepth 1 -name 'tr-*' -exec rm -rf {} + 2>/dev/null || true; }
barrer_tmp
limpiar() {
  barrer_tmp
  rmdir "$BLOQUEO" 2>/dev/null || true
  if [ -n "${CONF:-}" ]; then chmod -R u+w "$CONF" 2>/dev/null || true; rm -rf "$CONF"; fi
  chmod -R u+w "$PRIV" 2>/dev/null || true
  rm -rf "$PRIV"
}
trap limpiar EXIT

# Stages a failed day can be resumed from, and where it resumes:
# busqueda-completa → busqueda-completa; tareas-clasificar, clasificacion →
# tareas-clasificar; hechos, adjudicacion, adjudicacion-completa → hechos
# (the checked classifications are kept); preparar, fusionar, ajustar and the
# site checks (comprobaciones) → preparar: the kept adjudication is merged
# again on the worktree moved to the current base branch (reponer_para_fusion). The allowlist
# and git stages are not resumed.
punto_de_reanudacion() {
  case "$1" in
    busqueda-completa) echo busqueda-completa ;;
    tareas-clasificar | clasificacion) echo tareas-clasificar ;;
    hechos | adjudicacion | adjudicacion-completa) echo hechos ;;
    preparar | fusionar | ajustar | comprobaciones) echo preparar ;;
    *) return 1 ;;
  esac
}
# sello_ejecucion: sha256 of every file of the run folder (but the log, the
# stage table, the summaries and the seal itself), every cached document and
# bloqueados.json. Written when a resumable stage fails; checked on --reanudar.
sello_ejecucion() {
  (cd "$EJ" && find . -type f ! -name diario.log ! -name etapas.tsv ! -name gasto.tsv ! -name 'resumen*.md' ! -name reanudar.sello -print) |
    LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$EJ/$f"; done
  if [ -d "$N29_CACHE/docs" ]; then
    (cd "$N29_CACHE" && find docs -type f -print) | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$N29_CACHE/$f"; done
  fi
  if [ -f "$N29_CACHE/bloqueados.json" ]; then shasum -a 256 "$N29_CACHE/bloqueados.json"; fi
}
sellar_para_reanudar() {
  sello_ejecucion >"$EJ/reanudar.sello" && shasum -a 256 "$EJ/reanudar.sello" | cut -d' ' -f1
}
ultima_etapa_fallida() {
  local linea
  linea="$(tail -n 1 "$EJ/etapas.tsv" 2>/dev/null)"
  [ "$(printf '%s' "$linea" | cut -f2)" = fallo ] && printf '%s' "$linea" | cut -f1
}
# --reanudar: only a day stopped at a resumable stage, sealed, with its worktree
# on its branch at its base: clean, or (from preparar) with only the merge's own
# changes, which reponer_para_fusion undoes.
comprobar_reanudar() {
  local etapa base codigo=0 ahora
  [ -d "$EJ" ] || die "--reanudar: no existe $EJ"
  etapa="$(ultima_etapa_fallida)" && DESDE="$(punto_de_reanudacion "$etapa")" ||
    die "--reanudar: la ejecución del $FECHA no se detuvo en una etapa que se pueda reanudar (ver $EJ/etapas.tsv)"
  [ -f "$EJ/reanudar.sello" ] || die "--reanudar: no hay sello (reanudar.sello); créalo con --sellar tras revisar la carpeta"
  [ "$(shasum -a 256 "$EJ/reanudar.sello" | cut -d' ' -f1)" = "$SELLO_ESPERADO" ] || die "--reanudar: el sha256 del sello no es el que se dio"
  ahora="$(mktemp "${TMPDIR:-/tmp}/29n-sello.XXXXXX")"
  sello_ejecucion >"$ahora"
  if ! cmp -s "$EJ/reanudar.sello" "$ahora"; then
    diff "$EJ/reanudar.sello" "$ahora" | head -n 20 >&2 || true
    rm -f "$ahora"
    die "--reanudar: la carpeta de la ejecución, la caché o bloqueados.json cambiaron desde el sello"
  fi
  rm -f "$ahora"
  if [ "$DESDE" = busqueda-completa ]; then
    # One retry session per day: once started, the day is not resumed.
    [ ! -e "$EJ/busqueda-reintento.iniciado" ] || die "--reanudar: ese día ya empezó su sesión de reintento de la búsqueda"
    [ ! -e "$EJ/busqueda-definitivas.txt" ] || die "--reanudar: la búsqueda tiene faltas que otra sesión no puede arreglar"
    [ -z "$(cd "$EJ" && find . -maxdepth 1 \( -name clasificacion -o -name adjudicado -o -name 'hechos.json*' -o -name 'descubrir.listados.json' \) -print)" ] ||
      die "--reanudar: la carpeta de la ejecución ya tiene archivos de etapas posteriores"
  elif [ "$DESDE" = preparar ]; then
    # From the merge on, nothing before it is redone: the last adjudication check must have passed.
    [ "$(grep -E "$(printf '^adjudicacion-completa\t')" "$EJ/etapas.tsv" | tail -n 1 | cut -f1,2)" = "$(printf 'adjudicacion-completa\tok')" ] ||
      die "--reanudar: la adjudicación de ese día no terminó"
  else
    grep -q "$(printf '^traer-busqueda\tok')" "$EJ/etapas.tsv" || die "--reanudar: la búsqueda de ese día no terminó"
    # From the shared facts on, the classification is not redone: its last run must have passed.
    if [ "$DESDE" = hechos ]; then
      [ "$(grep -E "$(printf '^(tareas-clasificar|clasificacion)\t')" "$EJ/etapas.tsv" | tail -n 1 | cut -f1,2)" = "$(printf 'clasificacion\tok')" ] ||
        die "--reanudar: la clasificación de ese día no terminó"
    fi
    [ -z "$(cd "$EJ" && find . -maxdepth 1 \( -name fusion -o -name preparar.json -o -name fusionar.json \) -print)" ] ||
      die "--reanudar: la carpeta de la ejecución ya tiene archivos de la preparación o la fusión"
  fi
  [ -d "$WT" ] || die "--reanudar: no existe el worktree $WT"
  [ "$(real "$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir)")" = "$(real "$(git -C "$N29_REPO" rev-parse --path-format=absolute --git-common-dir)")" ] ||
    die "--reanudar: el worktree no pertenece a N29_REPO"
  [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "$RAMA" ] || die "--reanudar: el worktree no está en $RAMA"
  # From preparar the worktree holds the earlier merge: reponer_para_fusion checks it and resets it.
  [ "$DESDE" = preparar ] || [ -z "$(git -C "$WT" status --porcelain --ignored)" ] || die "--reanudar: el worktree tiene cambios o archivos sin seguir"
  if [ -f "$EJ/base.sha" ]; then
    base="$(cat "$EJ/base.sha")"
  else
    # Runs before this change did not record the base: nothing was committed, so it is HEAD (checked below against the remote).
    base="$(git -C "$WT" rev-parse HEAD)"
    echo "diario.sh: base.sha no existe (ejecución anterior a este cambio): la base es el HEAD del worktree, $base" >&2
  fi
  [ "$(git -C "$WT" rev-parse HEAD)" = "$base" ] || die "--reanudar: el HEAD del worktree no es la base del día"
  [ "$(git -C "$N29_REPO" rev-parse --verify "refs/heads/$RAMA")" = "$base" ] || die "--reanudar: la rama $RAMA no apunta a la base del día"
  git -C "$N29_REPO" fetch --quiet "$REMOTO" "$BASE" || die "--reanudar: git fetch falló"
  git -C "$N29_REPO" merge-base --is-ancestor "$base" "refs/remotes/$REMOTO/$BASE" || die "--reanudar: la base del día no está en $REMOTO/$BASE"
  git -C "$N29_REPO" ls-remote --exit-code --heads "$REMOTO" "refs/heads/$RAMA" >/dev/null || codigo=$?
  case "$codigo" in
    0) die "--reanudar: la rama $RAMA ya existe en $REMOTO" ;;
    2) ;;
    *) die "--reanudar: git ls-remote falló (código $codigo)" ;;
  esac
  printf '%s\n' "$base" >"$PRIV/base.sha"
}
DESDE=""
if [ "$SELLAR" = 1 ]; then
  [ -d "$EJ" ] || die "--sellar: no existe $EJ"
  etapa="$(ultima_etapa_fallida)" && punto_de_reanudacion "$etapa" >/dev/null || die "--sellar: la ejecución del $FECHA no se detuvo en una etapa que se pueda reanudar"
  [ ! -e "$EJ/reanudar.sello" ] || die "--sellar: ya hay un sello ($EJ/reanudar.sello)"
  sello="$(sellar_para_reanudar)"
  printf 'Sello de %s: %s\nPara reanudar: bin/diario.sh --fecha %s --reanudar %s\n' "$EJ" "$sello" "$FECHA" "$sello"
  exit 0
fi
if [ "$REANUDAR" = 1 ]; then
  comprobar_reanudar
  LOG="$EJ/diario.log"
  printf 'reanudar\tok\tdesde %s, sello %s\n' "$DESDE" "$SELLO_ESPERADO" >>"$EJ/etapas.tsv"
  if [ "$DESDE" = tareas-clasificar ]; then
    # A failed adjudication's answers are kept aside, never mixed with the new ones.
    n=1
    while [ -e "$EJ/anterior/adjudicacion-$n" ]; do n=$((n + 1)); done
    for f in adjudicado hechos.json hechos.json.error.txt; do
      if [ -e "$EJ/$f" ]; then mkdir -p "$EJ/anterior/adjudicacion-$n" && mv "$EJ/$f" "$EJ/anterior/adjudicacion-$n/"; fi
    done
  fi
else
  # A previous attempt of the same day is kept, renamed, never mixed with this one.
  if [ -e "$EJ" ]; then
    n=1
    while [ -e "$EJ.intento-$n" ]; do n=$((n + 1)); done
    mv "$EJ" "$EJ.intento-$n"
  fi
  mkdir -p "$EJ"
  LOG="$EJ/diario.log"
  : >"$EJ/etapas.tsv"
fi
COMPROBACIONES_OK=1
say() { printf '%s\n' "$*" | tee -a "$LOG"; }

# Writes the failure to resumen.md (with the partial summary, if any) and stops. No commit happens.
fallo() {
  local sello=""
  trap - ERR
  # A resumable failure is sealed, unless a search retry already started or its gaps are definitive.
  if [ "$SECO" = 0 ] && punto_de_reanudacion "$1" >/dev/null &&
    { [ "$1" != busqueda-completa ] || { [ ! -e "$EJ/busqueda-reintento.iniciado" ] && [ ! -e "$EJ/busqueda-definitivas.txt" ]; }; }; then
    sello="$(sellar_para_reanudar)" || sello=""
  fi
  {
    printf '# Recogida del %s: fallo\n\n' "$FECHA"
    printf -- '- Etapa: %s\n- Motivo: %s\n' "$1" "$2"
    if [ "$SECO" = 0 ]; then
      printf -- '- Sin commit, push ni PR. El worktree, si se creó, queda en `%s` (rama `%s`) para revisarlo.\n' "$WT" "$RAMA"
      printf -- '- Para repetir el día, ver «Recuperar un día» en recogida/README.md.\n'
      if [ -n "$sello" ]; then
        printf -- '- Sello de la carpeta de la ejecución, la caché y bloqueados.json: `%s`. Para reanudar desde aquí tras revisarla: `bin/diario.sh --fecha %s --reanudar %s` (ver «Reanudar un día» en recogida/README.md).\n' "$sello" "$FECHA" "$sello"
      fi
    fi
    printf '\n## Últimas líneas del registro\n\n```text\n'
    tail -n 60 "$LOG" 2>/dev/null || true
    printf '```\n'
    if [ "$1" = busqueda-completa ] && [ -s "$EJ/busqueda-reintentadas.txt" ]; then
      printf '\n## Reintentado en una sesión más (busqueda-reintento)\n\n'
      cat "$EJ/busqueda-reintentadas.txt"
    fi
    if [ "$1" = busqueda-completa ] && [ -s "$EJ/busqueda-faltan.txt" ]; then
      printf '\n## Lo que falta de la búsqueda\n\nNo se adjudica nada: la búsqueda no fue la misma para los cuatro partidos.\n\n'
      cat "$EJ/busqueda-faltan.txt"
    fi
    if [ -f "$EJ/resumen.parcial.md" ]; then
      printf '\n'
      cat "$EJ/resumen.parcial.md"
    fi
  } >"$EJ/resumen.md"
  say "FALLO en $1: $2 (detalle en $EJ/resumen.md)"
  [ -z "$sello" ] || say "Sello para reanudar: $sello"
  exit 1
}
trap 'fallo "diario.sh, línea $LINENO" "error inesperado"' ERR

# etapa <nombre> <fatal|aviso|comprobacion> <comando…>: runs a stage, logs it, records it in etapas.tsv.
etapa() {
  local nombre="$1" modo="$2" codigo=0
  shift 2
  say "== $nombre"
  "$@" >>"$LOG" 2>&1 || codigo=$?
  if [ "$codigo" = 0 ]; then
    printf '%s\tok\t\n' "$nombre" >>"$EJ/etapas.tsv"
    return 0
  fi
  case "$modo" in
    fatal)
      printf '%s\tfallo\tcódigo %s\n' "$nombre" "$codigo" >>"$EJ/etapas.tsv"
      fallo "$nombre" "terminó con código $codigo"
      ;;
    comprobacion)
      printf '%s\tfallo\tcódigo %s\n' "$nombre" "$codigo" >>"$EJ/etapas.tsv"
      COMPROBACIONES_OK=0
      ;;
    *) printf '%s\taviso\tcódigo %s\n' "$nombre" "$codigo" >>"$EJ/etapas.tsv" ;;
  esac
  return 0
}
omitida() { printf '%s\tomitida\t%s\n' "$1" "$2" >>"$EJ/etapas.tsv"; }

# ------------------------------------------------------------------ seals

# sha256 of every file the script relies on and Claude must not change: the
# run folder except Claude's answers and the script's own log, the cache
# documents and bloqueados.json.
# Before pass 2, busqueda/ and equidad/ (pass 1's answers) are sealed too.
# Before a retry, classification batch, facts or party session, everything but
# that session's own answer files (rutas_sesion).
# rutas_sesion <nombre>: the file listing the only files a retry, batch, facts or
# party session may create, as `find` prints them (an absolute path).
rutas_sesion() {
  local partido
  case "$1" in
    busqueda-reintento) echo "$EJ/reintento-rutas.txt" ;;
    clasificacion-*) echo "$EJ/lotes/clasificar-${1#clasificacion-}.rutas.txt" ;;
    hechos) printf './hechos.json\n./hechos.json.error.txt\n' >"$PRIV/rutas.$1.txt" && echo "$PRIV/rutas.$1.txt" ;;
    adjudicacion-*)
      partido="${1#adjudicacion-}"
      case " $PARTIDOS " in *" $partido "*) ;; *) return 1 ;; esac
      printf './adjudicado/%s.json\n./adjudicado/%s.json.error.txt\n' "$partido" "$partido" >"$PRIV/rutas.$1.txt" && echo "$PRIV/rutas.$1.txt"
      ;;
    *) return 1 ;;
  esac
}
huellas_protegidas() {
  local pasada="$1" rutas
  (
    cd "$EJ" || exit 1
    if rutas="$(rutas_sesion "$pasada")"; then
      # Only this session's own answers may appear or change; every other file, earlier answers
      # (another party's adjudication, the shared facts) included, is sealed.
      find . -type f ! -path './claude/*' ! -name diario.log ! -name etapas.tsv ! -name gasto.tsv -print | { grep -v -x -F -f "$rutas" || true; }
    elif [ "$pasada" = busqueda ]; then
      find . -type f ! -path './busqueda/*' ! -path './equidad/*' ! -path './clasificacion/*' ! -path './adjudicado/*' \
        ! -name 'hechos.json*' ! -path './claude/*' ! -name diario.log ! -name etapas.tsv ! -name gasto.tsv -print
    else
      echo "sesión desconocida: $pasada" >&2
      exit 1
    fi
  ) | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$EJ/$f"; done
  if [ -d "$N29_CACHE/docs" ]; then
    (cd "$N29_CACHE" && find docs -type f -print) | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$N29_CACHE/$f"; done
  fi
  if [ -f "$N29_CACHE/bloqueados.json" ]; then shasum -a 256 "$N29_CACHE/bloqueados.json"; fi
}
sellar() { huellas_protegidas "$1" >"$PRIV/sello.txt"; }
verificar_sello() {
  huellas_protegidas "$1" >"$PRIV/sello.ahora.txt"
  if ! cmp -s "$PRIV/sello.txt" "$PRIV/sello.ahora.txt"; then
    echo "archivos protegidos cambiados durante la pasada de Claude:"
    diff "$PRIV/sello.txt" "$PRIV/sello.ahora.txt" || true
    return 1
  fi
}

# ------------------------------------------------------------------ stages

crear_worktree() {
  local codigo=0
  [ ! -e "$WT" ] || { echo "ya existe $WT: revísalo y bórralo antes de repetir el día"; return 1; }
  git -C "$N29_REPO" ls-remote --exit-code --heads "$REMOTO" "refs/heads/$RAMA" >/dev/null || codigo=$?
  case "$codigo" in
    0) echo "la rama $RAMA ya existe en $REMOTO: bórrala a mano antes de repetir el día"; return 1 ;;
    2) ;;
    *) echo "git ls-remote falló (código $codigo)"; return 1 ;;
  esac
  if git -C "$N29_REPO" show-ref --verify --quiet "refs/heads/$RAMA"; then echo "la rama local $RAMA ya existe"; return 1; fi
  git -C "$N29_REPO" fetch --quiet "$REMOTO" "$BASE" || return $?
  BASE_SHA="$(git -C "$N29_REPO" rev-parse --verify "refs/remotes/$REMOTO/$BASE^{commit}")" || return $?
  git -C "$N29_REPO" worktree add --quiet --no-track -b "$RAMA" "$WT" "$BASE_SHA" || return $?
  printf '%s\n' "$BASE_SHA" >"$PRIV/base.sha"
  # Also in the run folder (sealed with it), so a resumed day can check its base.
  printf '%s\n' "$BASE_SHA" >"$EJ/base.sha"
}

# Read-only inputs for the agents and the baseline of the day: the site data before anything changes.
instantanea() {
  mkdir -p "$EJ/antes" || return $?
  cp -R "$DATOS/partidos" "$EJ/antes/partidos" || return $?
  if [ -d "$DATOS/perfiles" ]; then cp -R "$DATOS/perfiles" "$EJ/antes/perfiles" || return $?; fi
  cp "$DATOS/busquedas.json" "$DATOS/fuentes.json" "$EJ/antes/"
}

paso_transcribir() {
  local video oficial buzon codigo=0 origen
  glue videos >"$EJ/videos.tsv" || return $?
  while IFS="$(printf '\t')" read -r video oficial buzon; do
    [ -n "$video" ] || continue
    # A video the owner listed: its transcript is marked origen buzon-videos (citas.ts, citableEn).
    origen=""
    [ "$buzon" != buzon ] || origen=buzon-videos
    if [ -n "$oficial" ]; then
      con_limite "$LIMITE_VIDEO" node ${IMPORTAR:+--import "$IMPORTAR"} "$RECOGIDA/bin/29n-recogida.ts" transcribir --fecha "$FECHA" --video "$video" --oficial "$oficial" ${origen:+--origen "$origen"} ${N29_MODELO_WHISPER:+--modelo-whisper "$N29_MODELO_WHISPER"} || codigo=1
    else
      con_limite "$LIMITE_VIDEO" node ${IMPORTAR:+--import "$IMPORTAR"} "$RECOGIDA/bin/29n-recogida.ts" transcribir --fecha "$FECHA" --video "$video" ${origen:+--origen "$origen"} ${N29_MODELO_WHISPER:+--modelo-whisper "$N29_MODELO_WHISPER"} || codigo=1
    fi
  done <"$EJ/videos.tsv"
  return $codigo
}

# Fetches what the search agents found: `traer` reads descubrir.json, so the
# listings' files are set aside and restored around it.
paso_traer_busqueda() {
  local codigo=0
  glue candidatos-busqueda || return $?
  mv "$EJ/descubrir.json" "$EJ/descubrir.listados.json" && mv "$EJ/traer.json" "$EJ/traer.listados.json" || return $?
  cp "$EJ/descubrir.busqueda.json" "$EJ/descubrir.json" || return $?
  cli traer --fecha "$FECHA" || codigo=$?
  [ ! -f "$EJ/traer.json" ] || mv "$EJ/traer.json" "$EJ/traer.busqueda.json"
  mv "$EJ/descubrir.listados.json" "$EJ/descubrir.json" && mv "$EJ/traer.listados.json" "$EJ/traer.json" || return $?
  return $codigo
}

# Builds settings, agents and prompts from this repository into a fresh
# folder outside every writable one, read-only, with an empty start folder.
# preparar_conf <nombre>: a session name is a pass, clasificacion-<lote> for one classification batch,
# or adjudicacion-<partido> for one party's adjudication.
# SESION: the diario.ts options of a session name (--pasada, and --lote or --partido).
opciones_sesion() {
  case "$1" in
    clasificacion-*) SESION=(--pasada clasificacion --lote "${1#clasificacion-}") ;;
    adjudicacion-*) SESION=(--pasada adjudicacion --partido "${1#adjudicacion-}") ;;
    *) SESION=(--pasada "$1") ;;
  esac
}
preparar_conf() {
  local nombre="$1"
  CONF="$(real "$(mktemp -d "${TMPDIR:-/tmp}/29n-claude.XXXXXX")")" || return $?
  comprobar_separadas "$CONF" "$N29_CACHE" "$N29_BUZON" "$N29_WORKTREES" "$T" "$PRIV" || return 1
  opciones_sesion "$nombre"
  glue claude --dir "$CONF" "${SESION[@]}" || return $?
  mkdir "$CONF/vacio" || return $?
  chmod 444 "$CONF"/*.json "$CONF"/*.txt && chmod 555 "$CONF/vacio" "$CONF" || return $?
  (cd "$CONF" && find . -maxdepth 1 -type f -print | LC_ALL=C sort | xargs shasum -a 256) >"$PRIV/conf.sha"
}
borrar_conf() {
  [ -n "${CONF:-}" ] || return 0
  chmod -R u+w "$CONF" && rm -rf "$CONF"
  CONF=""
}

# Copies the pass's configuration to the run folder for the audit, one file
# name per pass: the copies keep the read-only mode of the originals, so a
# shared name would make the second pass fail to copy over the first. A pass
# that runs again in the same run folder (a resumed day) keeps the files of its
# earlier attempt, renamed to <pasada>.intento-<n>.*, never overwritten.
auditar_conf() {
  local pasada="$1" n=1 f previo=0
  mkdir -p "$EJ/claude" || return $?
  for f in "$EJ/claude/$pasada".*; do
    case "${f##*/}" in "$pasada".intento-*) ;; *) [ ! -e "$f" ] || previo=1 ;; esac
  done
  if [ "$previo" = 1 ]; then
    while compgen -G "$EJ/claude/$pasada.intento-$n.*" >/dev/null; do n=$((n + 1)); done
    for f in "$EJ/claude/$pasada".*; do
      case "${f##*/}" in "$pasada".intento-*) continue ;; esac
      mv "$f" "$EJ/claude/$pasada.intento-$n.${f##*/"$pasada".}" || return $?
    done
  fi
  for f in "$CONF"/*; do
    [ -f "$f" ] || continue
    cp "$f" "$EJ/claude/$pasada.${f##*/}" || return $?
  done
}

# herramientas_pasada: the pass's `--tools` (herramientas.txt), checked: a search pass (busqueda,
# busqueda-reintento) only Agent, WebFetch and WebSearch; any other pass none at all (empty).
herramientas_pasada() {
  local pasada="$1" herramientas h
  herramientas="$(cat "$CONF/herramientas.txt")" || return 1
  case "$pasada" in
    busqueda | busqueda-reintento) ;;
    *) [ -z "$herramientas" ] || { echo "la pasada $pasada no puede tener herramientas: $herramientas" >&2; return 1; }; return 0 ;;
  esac
  printf '%s\n' "$herramientas" | grep -E -q -x '[A-Za-z]+(,[A-Za-z]+)*' || { echo "herramientas no válidas: $herramientas" >&2; return 1; }
  for h in $(printf '%s' "$herramientas" | tr ',' ' '); do
    case "$h" in
      Agent | WebFetch | WebSearch) ;;
      *) echo "herramienta no admitida: $h" >&2; return 1 ;;
    esac
  done
  printf '%s' "$herramientas"
}
# modelo_pasada: the pass's model (modelo.txt), haiku or opus.
modelo_pasada() {
  local m
  m="$(cat "$CONF/modelo.txt")" || return 1
  case "$m" in haiku | opus) printf '%s' "$m" ;; *) echo "modelo no admitido: $m" >&2; return 1 ;; esac
}
# ADD_DIRS: one --add-dir per folder of carpetas.txt, each the run folder, the cached documents or criterios/.
carpetas_pasada() {
  local c
  ADD_DIRS=()
  while IFS= read -r c; do
    case "$c" in
      "$EJ" | "$N29_CACHE/docs" | "$T/criterios") ADD_DIRS+=(--add-dir "$c") ;;
      *) echo "carpeta no admitida para Claude: $c" >&2; return 1 ;;
    esac
  done <"$CONF/carpetas.txt"
}
# prompts_pasada: how many calls the pass makes (prompt-1.txt … prompt-<n>.txt, all present).
prompts_pasada() {
  local n=0
  while [ -f "$CONF/prompt-$((n + 1)).txt" ]; do n=$((n + 1)); done
  [ "$n" -gt 0 ] && [ -z "$(cd "$CONF" && find . -maxdepth 1 -name 'prompt-*.txt' ! -name "prompt-[0-9]*.txt" -print)" ] || { echo "la pasada no tiene prompts" >&2; return 1; }
  printf '%s' "$n"
}

claude_pasada() {
  local pasada="$1" codigo=0 resto busquedas herramientas modelo sin_web="" n i salidas=() segundos coste salida
  preparar_conf "$pasada" || return $?
  (cd "$CONF" && shasum -a 256 -c --status "$PRIV/conf.sha") || { echo "la configuración de Claude cambió antes de usarla"; return 1; }
  herramientas="$(herramientas_pasada "$pasada")" || return 1
  carpetas_pasada || return 1
  modelo="$(modelo_pasada)" || return 1
  n="$(prompts_pasada)" || return 1
  # A pass without WebFetch also has it switched off in Claude Code itself (on top of --tools and the deny rule).
  case ",$herramientas," in *,WebFetch,*) ;; *) sin_web=1 ;; esac
  # One WebSearch cap per call, sized for its tasks (diario.ts, limiteBusquedasWeb).
  busquedas="$(cat "$CONF/busquedas-web.txt")" || return 1
  case "$busquedas" in '' | *[!0-9]* | 0*) echo "límite de búsquedas no válido: $busquedas"; return 1 ;; esac
  sellar "$pasada" || return $?
  # One call per prompt (a batch). --restricted ignores user, project and local settings files: only --settings
  # applies. The answer comes back on stdout as structured output (--json-schema); the pass writes nothing.
  # Money never decides whether a call is made: --max-budget-usd (N29_PRESUPUESTO_USD, at least 100) only guards
  # each call against a runaway, far above what the largest one costs. N29_LIMITE_CLAUDE_S is for the whole
  # session; each call gets the time left. What Claude Code reports each call cost (total_cost_usd) is recorded in
  # gasto.tsv (session, call, reported cost, seconds), for information only. A call that fails, or is not made, leaves its answers missing: the gate after
  # the pass retries them or stops the day.
  local inicio=$SECONDS entrada tope huella guardado t0
  tope="$(awk -v p="$N29_PRESUPUESTO_USD" 'BEGIN { printf "%.2f", (p > 100 ? p : 100) }')"
  : >"$PRIV/gasto.nuevo"
  : >"$PRIV/validos.tsv"
  i=1
  while [ "$i" -le "$n" ]; do
    salida="$PRIV/$pasada.salida-$i.json"
    segundos=$((LIMITE_CLAUDE - (SECONDS - inicio)))
    # A facts batch after the first also gets the facts the earlier batches wrote (reuse their keys).
    entrada="$CONF/prompt-$i.txt"
    if [ "$pasada" = hechos ] && [ "$i" -gt 1 ]; then
      entrada="$PRIV/hechos.entrada-$i.txt"
      { cat "$CONF/prompt-$i.txt"; glue juicio-previos --pasada hechos --salidas ${salidas[@]+"${salidas[@]}"}; } >"$entrada" || return 1
      cp "$entrada" "$PRIV/hechos.previos-$i.txt"
    fi
    # An adjudication batch already answered validly in an earlier round (same prompt) is kept, not asked again:
    # the second round redoes only the batches that failed, so a party with more batches is not likelier to fail.
    guardado=""
    case "$pasada" in
      adjudicacion-*)
        # The key: the prompt, the model and the schema; a batch is kept only when its answer is complete (juicio-valida).
        huella="$( { cat "$entrada" "$CONF/modelo.txt" "$CONF/esquema.json"; } | shasum -a 256 | cut -c1-24)"
        guardado="$EJ/adjudicado-lotes/${pasada#adjudicacion-}/$huella.json"
        ;;
    esac
    if [ -n "$guardado" ] && [ -f "$guardado" ]; then
      echo "llamada $i de $n: lote ya respondido bien en una ronda anterior (adjudicado-lotes/${pasada#adjudicacion-}/$huella.json), se reutiliza"
      cp "$guardado" "$salida"
    elif grep -q -x -F "prompt-$i.txt" "$CONF/saltar.txt"; then
      echo "llamada $i de $n: no se envía (prompt demasiado largo)"
      salida=""
    elif [ "$segundos" -lt 60 ]; then
      echo "llamada $i de $n: no se hace, tiempo de la sesión agotado"
      salida=""
    else
      echo "llamada $i de $n ($(wc -c <"$entrada" | tr -d ' ') bytes, quedan $segundos s)"
      t0=$SECONDS
      (
        cd "$CONF/vacio" &&
          con_limite "$segundos" env CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION="$busquedas" ${sin_web:+CLAUDE_CODE_DISABLE_WEB_FETCH=1} "$N29_CLAUDE" -p \
            --model "$modelo" \
            --restricted \
            --settings "$CONF/settings.json" \
            --strict-mcp-config \
            --agents "$CONF/agentes.json" \
            --tools "$herramientas" \
            --permission-mode dontAsk \
            --permission-prompts none \
            ${ADD_DIRS[@]+"${ADD_DIRS[@]}"} \
            --no-session-persistence \
            --output-format json \
            --json-schema "$(cat "$CONF/esquema.json")" \
            --max-budget-usd "$tope" \
            <"$entrada" >"$salida"
      ) || echo "llamada $i de $n terminó con código $? (sus respuestas faltarán; la comprobación de después decide)"
      coste="$(node -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const c = Number(r.total_cost_usd); console.log(r.total_cost_usd !== undefined && Number.isFinite(c) && c >= 0 ? c : ""); } catch { console.log(""); }' "$salida")"
      printf '%s\t%s\t%s\t%s\n' "$pasada" "$i" "${coste:-sin dato}" "$((SECONDS - t0))" >>"$PRIV/gasto.nuevo"
      if [ -n "$guardado" ] && opciones_sesion "$pasada" && glue juicio-valida "${SESION[@]}" --salida "$salida" --lotes "$CONF/lotes.json" --indice "$i"; then
        printf '%s\t%s\n' "$salida" "$guardado" >>"$PRIV/validos.tsv"
      fi
    fi
    salidas+=("$salida")
    i=$((i + 1))
  done
  verificar_sello "$pasada" || codigo=1
  # What the session's calls reported they cost, kept with the day for information (outside the seals).
  cat "$PRIV/gasto.nuevo" >>"$EJ/gasto.tsv" && rm -f "$PRIV/gasto.nuevo"
  # The valid adjudication batches, kept for a second round (after the seal: they are the script's own files).
  while IFS="$(printf '\t')" read -r salida guardado; do
    [ -n "$salida" ] || continue
    mkdir -p "$(dirname "$guardado")" && cp "$salida" "$guardado" || codigo=1
  done <"$PRIV/validos.tsv"
  # The script, not Claude, checks the answers and writes the pass's own files.
  opciones_sesion "$pasada"
  # An answer that is missing or does not match its schema is not written: the gate after the pass (busqueda-completa,
  # clasificacion-completa, hechos-completo, adjudicacion-completa) finds it missing and retries or fails, as before.
  glue juicio-guardar "${SESION[@]}" --salidas "${salidas[@]}" || echo "la sesión $pasada dejó respuestas que no valen: las comprobaciones siguientes deciden"
  # Search and classification sessions run before the adjudication: its answers must not exist yet.
  if [ "$pasada" = busqueda ] || [ "$pasada" = busqueda-reintento ] || [ "${pasada#clasificacion-}" != "$pasada" ]; then
    resto="$(cd "$EJ" && find . -maxdepth 1 \( -name adjudicado -o -name 'hechos.json*' \) -print)"
    [ -z "$resto" ] || { printf 'la sesión %s dejó archivos de la adjudicación:\n%s\n' "$pasada" "$resto"; codigo=1; }
  fi
  # Before the classification, no session may leave classifications.
  if [ "$pasada" = busqueda ] || [ "$pasada" = busqueda-reintento ]; then
    [ ! -e "$EJ/clasificacion" ] || { echo "la sesión $pasada dejó clasificacion/"; codigo=1; }
  fi
  # Audit copy of what ran, made after the check so the pass cannot have touched it.
  auditar_conf "$pasada" || codigo=1
  for i in "${salidas[@]}"; do [ -z "$i" ] || [ ! -f "$i" ] || cp "$i" "$EJ/claude/" || codigo=1; done
  for i in "$PRIV"/hechos.previos-*.txt; do [ ! -f "$i" ] || mv "$i" "$EJ/claude/" || codigo=1; done
  rm -f "$PRIV"/hechos.entrada-*.txt
  borrar_conf
  # Only a broken seal or configuration ends the day here.
  return $codigo
}

# The search gate. Exit 3 from the first check means it prepared a retry: one
# more session ("busqueda-reintento") for just the missing tasks, with the same
# task definitions, prompts and subagents, then the check again, final.
paso_busqueda_completa() {
  local codigo=0
  glue busqueda-completa --preparar-reintento || codigo=$?
  [ "$codigo" = 3 ] || return $codigo
  echo "== busqueda-reintento"
  # Marked before it starts: a day whose retry started is never resumed into another one.
  : >"$EJ/busqueda-reintento.iniciado"
  if [ "$SECO" = 1 ]; then
    ensayar_sesion busqueda-reintento "$FIJOS/juicio-reintento" || return $?
  else
    claude_pasada busqueda-reintento || return $?
  fi
  glue busqueda-completa
}

# ensayar_sesion <nombre> <carpeta…>: in --seco, one session rehearsed. The
# configuration and the prompts are built and checked as for Claude; the
# fixture answers in <carpeta…> become the structured output Claude would
# return (diario.ts juicio-ensayo), and the same check and write as a live run
# (juicio-guardar) apply, under the same seal.
ensayar_sesion() {
  local nombre="$1" f fijos=()
  shift
  for f in "$@"; do fijos+=(--fijos "$f"); done
  preparar_conf "$nombre" || return $?
  (cd "$CONF" && shasum -a 256 -c --status "$PRIV/conf.sha") || return 1
  local n i salidas=()
  herramientas_pasada "$nombre" >/dev/null && carpetas_pasada && modelo_pasada >/dev/null || return 1
  n="$(prompts_pasada)" || return 1
  auditar_conf "$nombre" || return $?
  CONF="$CONF" perl -pi -e 's{\Q$ENV{CONF}\E}{<CONF>}g' "$EJ/claude/$nombre".* || return $?
  borrar_conf
  opciones_sesion "$nombre"
  glue juicio-ensayo "${SESION[@]}" "${fijos[@]}" --salida "$PRIV/$nombre.salida" --llamadas "$n" || return 1
  for i in $(seq 1 "$n"); do salidas+=("$PRIV/$nombre.salida-$i.json"); done
  sellar "$nombre" || return $?
  glue juicio-guardar "${SESION[@]}" --salidas "${salidas[@]}" || echo "la sesión $nombre dejó respuestas que no valen: las comprobaciones siguientes deciden"
  verificar_sello "$nombre" || return 1
}

# LOTES: the classification batches of a round, in order: <nn> or <nnn> (prefix ""), or reintento-<nn> (prefix
# "reintento-"); any other file in lotes/ named clasificar-*.json stops the stage.
lotes_clasificacion() {
  local prefijo="$1" f nombre
  LOTES=()
  for f in "$EJ"/lotes/clasificar-*.json; do
    [ -e "$f" ] || continue
    nombre="$(basename "$f" .json)"
    nombre="${nombre#clasificar-}"
    case "$nombre" in
      reintento-[0-9][0-9] | reintento-[0-9][0-9][0-9]) [ "$prefijo" = reintento- ] && LOTES+=("$nombre") ;;
      [0-9][0-9] | [0-9][0-9][0-9]) [ -z "$prefijo" ] && LOTES+=("$nombre") ;;
      *) echo "lote de clasificación con un nombre no admitido: $f"; return 1 ;;
    esac
  done
  # Numeric order (01…99, then 100…).
  [ ${#LOTES[@]} -eq 0 ] || LOTES=($(printf '%s\n' "${LOTES[@]}" | awk '{ n = $0; sub(/^reintento-/, "", n); print length(n), $0 }' | LC_ALL=C sort -k1,1n -k2,2 | cut -d' ' -f2))
}

# The classification: one Claude session per batch (lotes/clasificar-<nn>.json),
# then the check; missing or invalid answers get one more session
# (clasificacion-reintento), and the check again, final.
paso_clasificacion() {
  local lote nombre codigo=0
  lotes_clasificacion "" || return 1
  for lote in ${LOTES[@]+"${LOTES[@]}"}; do
    nombre="clasificacion-$lote"
    # A resumed day does not redo a batch whose answers are all there and valid.
    if glue clasificacion-completa --lote "${nombre#clasificacion-}" >/dev/null; then echo "== $nombre: completo"; continue; fi
    echo "== $nombre"
    if [ "$SECO" = 1 ]; then ensayar_sesion "$nombre" "$FIJOS/juicio" || return $?; else claude_pasada "$nombre" || return $?; fi
  done
  # One retry session per day, even across a resume.
  if [ -e "$EJ/clasificacion-reintento.iniciado" ]; then glue clasificacion-completa; return $?; fi
  glue clasificacion-completa --preparar-reintento || codigo=$?
  [ "$codigo" = 3 ] || return $codigo
  echo "== clasificacion-reintento"
  : >"$EJ/clasificacion-reintento.iniciado"
  # The retry is batched like the first round (lotes/clasificar-reintento-<nn>.json).
  lotes_clasificacion reintento- || return 1
  for lote in ${LOTES[@]+"${LOTES[@]}"}; do
    echo "== clasificacion-$lote"
    if [ "$SECO" = 1 ]; then ensayar_sesion "clasificacion-$lote" "$FIJOS/juicio-reintento" || return $?; else claude_pasada "clasificacion-$lote" || return $?; fi
  done
  glue clasificacion-completa
}

# One Claude session, or in --seco its rehearsal with the fixture's answers.
sesion_juicio() {
  if [ "$SECO" = 1 ]; then ensayar_sesion "$1" "$FIJOS/juicio"; else claude_pasada "$1"; fi
}
# apartar_adjudicacion <ruta…>: earlier answers of the adjudication, moved to
# anterior/adjudicacion-<n>/ (the smallest free n), never mixed with new ones.
apartar_adjudicacion() {
  local n=1 f hay=0
  for f in "$@"; do [ ! -e "$EJ/$f" ] || hay=1; done
  [ "$hay" = 1 ] || return 0
  while [ -e "$EJ/anterior/adjudicacion-$n" ]; do n=$((n + 1)); done
  for f in "$@"; do
    [ -e "$EJ/$f" ] || continue
    mkdir -p "$(dirname "$EJ/anterior/adjudicacion-$n/$f")" && mv "$EJ/$f" "$EJ/anterior/adjudicacion-$n/$f" || return $?
  done
}
# The shared facts: one session (hechos), skipped when hechos.json is already valid.
paso_hechos() {
  if glue hechos-completo; then return 0; fi
  # New facts: no adjudication made on other facts is kept, so the four parties read the same hechos.json.
  apartar_adjudicacion hechos.json hechos.json.error.txt adjudicado || return $?
  echo "== hechos"
  sesion_juicio hechos || return $?
  if glue hechos-completo; then return 0; fi
  # One more session when the facts are missing or did not merge (two batches, one key, different items).
  apartar_adjudicacion hechos.json hechos.json.error.txt || return $?
  echo "== hechos (reintento)"
  sesion_juicio hechos || return $?
  glue hechos-completo
}
# The adjudication: one session per party (adjudicacion-<partido>), in
# alphabetical order, each with the same prompt and its own budget. A party
# whose answer is complete is not redone; one still missing after its session
# gets one more. adjudicacion-completa, the next stage, is the final check.
paso_adjudicacion() {
  local p ronda faltan
  for ronda in 1 2; do
    faltan=0
    for p in $PARTIDOS; do
      if glue adjudicacion-completa --partido "$p" >/dev/null; then
        [ "$ronda" = 2 ] || echo "== adjudicacion-$p: completo"
        continue
      fi
      faltan=1
      if [ "$ronda" = 1 ]; then echo "== adjudicacion-$p"; else echo "== adjudicacion-$p (reintento)"; fi
      apartar_adjudicacion "adjudicado/$p.json" "adjudicado/$p.json.error.txt" || return $?
      sesion_juicio "adjudicacion-$p" || return $?
    done
    [ "$faltan" = 1 ] || break
  done
}

paso_fusionar() { cli fusionar --fecha "$FECHA" --ejecucion "$EJ/fusion" >"$EJ/fusionar.json"; }

# Quote problems after the merge that were not there before (citas.ts on the four sheets and perfiles).
paso_citas() {
  local p
  set --
  for p in $PARTIDOS; do
    set -- "$@" "partidos/$p.json"
    if [ -f "$DATOS/perfiles/$p.json" ] && [ -f "$EJ/antes/perfiles/$p.json" ]; then set -- "$@" "perfiles/$p.json"; fi
  done
  N29_SITIO="$EJ/antes" nodo "$RECOGIDA/src/citas.ts" "$@" >"$EJ/citas.antes.md" || true
  N29_SITIO="$DATOS" nodo "$RECOGIDA/src/citas.ts" "$@" >"$EJ/citas.despues.md" || true
  [ -s "$EJ/citas.despues.md" ] || { echo "citas.ts no produjo informe"; return 1; }
  problemas() { awk '/^## /{archivo=$2} /^- `/{print archivo " " $0}' "$1" | LC_ALL=C sort -u; }
  LC_ALL=C comm -13 <(problemas "$EJ/citas.antes.md") <(problemas "$EJ/citas.despues.md") >"$EJ/citas-nuevas.txt"
  cat "$EJ/citas-nuevas.txt"
  [ ! -s "$EJ/citas-nuevas.txt" ]
}

# Changed paths of the site, one per line as "<estado> <ruta>": git status in a
# live run (with ignored files when asked), a comparison with the fixture in --seco.
cambios_sitio() {
  if [ "$SECO" = 1 ]; then
    local linea resto carpeta
    while IFS= read -r linea; do
      case "$linea" in
        "Files $FIJOS/sitio/"*" differ")
          resto="${linea#"Files $FIJOS/sitio/"}"
          printf ' M %s\n' "${resto% and "$WT"/*}"
          ;;
        "Only in $WT"*)
          resto="${linea#"Only in $WT"}"
          carpeta="${resto%%: *}"
          carpeta="${carpeta#/}"
          printf '?? %s%s\n' "${carpeta:+$carpeta/}" "${resto#*: }"
          ;;
        "Only in $FIJOS/sitio"*)
          resto="${linea#"Only in $FIJOS/sitio"}"
          carpeta="${resto%%: *}"
          carpeta="${carpeta#/}"
          printf ' D %s%s\n' "${carpeta:+$carpeta/}" "${resto#*: }"
          ;;
        *) printf '?? %s\n' "$linea" ;;
      esac
    done < <(diff -rq "$FIJOS/sitio" "$WT")
    return 0
  fi
  if [ "${1:-}" = ignorados ]; then
    git -C "$WT" status --porcelain --untracked-files=all --ignored
  else
    git -C "$WT" status --porcelain --untracked-files=all
  fi
}

# Allowlist: only the four party files, the four perfiles, busquedas.json and
# fuentes.json, modified or added, each valid JSON; fuentes.json only with the
# changes fuentes-bloqueo makes (`diario.ts alcance-fuentes`). Anything else (a
# deletion, a rename, any other file, any non-JSON file) stops the run before
# install, test and build.
paso_alcance() {
  local linea estado ruta malos=""
  while IFS= read -r linea; do
    [ -n "$linea" ] || continue
    estado="${linea:0:2}"
    ruta="${linea:3}"
    case "$estado" in
      " M" | "M " | "MM" | "??" | "A ") ;;
      *) malos="$malos$linea (estado no admitido)"$'\n'; continue ;;
    esac
    case "$ruta" in
      apps/29n/src/data/busquedas.json) ;;
      apps/29n/src/data/fuentes.json)
        glue alcance-fuentes </dev/null >"$PRIV/alcance-fuentes.txt" || { malos="$malos$linea (cambios que fuentes-bloqueo no hace: $(tr '\n' ';' <"$PRIV/alcance-fuentes.txt"))"$'\n'; continue; }
        ;;
      apps/29n/src/data/partidos/frente-amplio.json | apps/29n/src/data/partidos/pp.json | apps/29n/src/data/partidos/psoe.json | apps/29n/src/data/partidos/vox.json) ;;
      apps/29n/src/data/perfiles/frente-amplio.json | apps/29n/src/data/perfiles/pp.json | apps/29n/src/data/perfiles/psoe.json | apps/29n/src/data/perfiles/vox.json) ;;
      *) malos="$malos$linea (fuera de la lista)"$'\n'; continue ;;
    esac
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$WT/$ruta" 2>/dev/null || malos="$malos$linea (no es JSON)"$'\n'
  done < <(cambios_sitio "${1:-}")
  [ -z "$malos" ] || { printf 'cambios no admitidos en el sitio:\n%s' "$malos"; return 1; }
}

datos_tocados() { cambios_sitio | sed 's/^...//'; }

# Site data the run read before the adjudication (the snapshot in antes/ and the
# alias rules): a new base may not change it, or the kept adjudication no longer fits.
DATOS_LEIDOS="apps/29n/src/data/partidos apps/29n/src/data/perfiles apps/29n/src/data/busquedas.json apps/29n/src/data/fuentes.json apps/29n/src/data/partidos-alias.json"

# --reanudar from preparar: the worktree moved to the current $REMOTO/$BASE (the
# new base of the day, so site fixes merged since are in), and the earlier
# merge's files of the run folder set aside to anterior/fusion-<n>/. Only on the
# day's own branch (data/29n-diario-<fecha>, created by this script) at its base
# with no commit, only when every change in it is one the merge may make (the
# allowlist), and only when the new base descends from the old one and leaves
# the data the run read unchanged ($DATOS_LEIDOS); its ignored files
# (node_modules, build output) go too, so the allowlist with ignored files
# passes again. A moved base is written to base.sha (the old one to
# bases-anteriores.txt) and to the stage table.
reponer_para_fusion() {
  local base nueva n=1 f
  base="$(cat "$PRIV/base.sha")" || return 1
  case "$RAMA" in
    data/29n-diario-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) echo "rama inesperada: $RAMA"; return 1 ;;
  esac
  [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "$RAMA" ] || { echo "el worktree no está en $RAMA"; return 1; }
  [ "$(git -C "$WT" rev-parse HEAD)" = "$base" ] && [ "$(git -C "$N29_REPO" rev-parse --verify "refs/heads/$RAMA")" = "$base" ] ||
    { echo "el worktree o la rama $RAMA no están en la base del día"; return 1; }
  paso_alcance || { echo "el worktree tiene cambios que la fusión no hace: no se borra nada, revísalo a mano"; return 1; }
  # comprobar_reanudar fetched $REMOTO/$BASE.
  nueva="$(git -C "$N29_REPO" rev-parse --verify "refs/remotes/$REMOTO/$BASE^{commit}")" || return 1
  git -C "$N29_REPO" merge-base --is-ancestor "$base" "$nueva" || { echo "$REMOTO/$BASE no desciende de la base del día"; return 1; }
  # shellcheck disable=SC2086 # fixed paths without spaces
  git -C "$N29_REPO" diff --quiet "$base" "$nueva" -- $DATOS_LEIDOS ||
    { echo "$REMOTO/$BASE cambió datos que la ejecución leyó ($DATOS_LEIDOS): la adjudicación guardada no vale, repite el día entero"; return 1; }
  git -C "$WT" reset --quiet --hard "$nueva" && git -C "$WT" clean -q -ffdx || return 1
  [ "$(git -C "$WT" rev-parse HEAD)" = "$nueva" ] && [ "$(git -C "$N29_REPO" rev-parse --verify "refs/heads/$RAMA")" = "$nueva" ] || { echo "la rama $RAMA no quedó en $nueva"; return 1; }
  [ -z "$(git -C "$WT" status --porcelain --ignored)" ] || { echo "el worktree no quedó limpio"; return 1; }
  if [ "$nueva" != "$base" ]; then
    printf '%s\n' "$base" >>"$EJ/bases-anteriores.txt" && printf '%s\n' "$nueva" >"$EJ/base.sha" && printf '%s\n' "$nueva" >"$PRIV/base.sha" || return 1
    printf 'base\tok\t%s → %s (%s/%s)\n' "$base" "$nueva" "$REMOTO" "$BASE" >>"$EJ/etapas.tsv"
    echo "base del día: $base → $nueva ($REMOTO/$BASE)"
  fi
  while [ -e "$EJ/anterior/fusion-$n" ]; do n=$((n + 1)); done
  for f in fusion preparar.json fusionar.json ajustar.json citas.antes.md citas.despues.md citas-nuevas.txt; do
    [ -e "$EJ/$f" ] || continue
    mkdir -p "$EJ/anterior/fusion-$n" && mv "$EJ/$f" "$EJ/anterior/fusion-$n/" || return 1
  done
}

paso_prettier() {
  local archivos
  archivos="$(datos_tocados)"
  [ -n "$archivos" ] || return 0
  # shellcheck disable=SC2086 # allowlisted data file names have no spaces
  (cd "$WT" && corepack yarn prettier --write -- $archivos)
}

paso_resumen() {
  N29_SITIO="$WT/apps/29n" nodo "$RECOGIDA/src/resumen.ts" --fecha "$FECHA" --antes "ejecuciones/$FECHA/antes" >"$EJ/resumen.parcial.md" || return $?
  glue informe >>"$EJ/resumen.parcial.md"
}

# REPO_GH: owner/repo of $REMOTO on github.com (ssh or https URL), for the push with the dedicated token.
repo_github() {
  local url
  url="$(git -C "$N29_REPO" remote get-url "$REMOTO")" || return 1
  REPO_GH="$(printf '%s\n' "$url" | sed -E -n 's#^(git@github\.com:|ssh://git@github\.com/|https://github\.com/)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$#\2#p' | sed 's/\.git$//')"
  [ -n "$REPO_GH" ] || { echo "$REMOTO no es un repositorio de github.com: $url"; return 1; }
}

paso_git() {
  case "$RAMA" in
    data/29n-diario-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) echo "rama inesperada: $RAMA"; return 1 ;;
  esac
  [ "$(git -C "$WT" rev-parse --abbrev-ref HEAD)" = "$RAMA" ] || { echo "el worktree no está en $RAMA"; return 1; }
  paso_alcance || return $?
  git -C "$WT" add -- apps/29n/src/data || return $?
  printf 'chore(29n): datos de la recogida del %s\n\nGenerado por recogida/bin/diario.sh (29n-transparencia) con las propuestas\nadjudicadas del día; el resumen está en el PR.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' "$FECHA" >"$EJ/commit.txt"
  git -C "$WT" commit --quiet -F "$EJ/commit.txt" || return $?
  # Only this branch, by explicit refspec: never master, never --force (checked again here, and by diario.test.ts).
  local refspec="refs/heads/$RAMA:refs/heads/$RAMA"
  [ "$refspec" = "refs/heads/data/29n-diario-$FECHA:refs/heads/data/29n-diario-$FECHA" ] || { echo "refspec inesperado: $refspec"; return 1; }
  if [ -n "$TOKEN_GH" ]; then
    repo_github || return 1
    # The dedicated token, over HTTPS, for this push only: no global or system git config (no insteadOf, no other
    # credential helper); the helper reads the token from the environment of this one command, never an argument.
    (
      export N29_TOKEN_PUSH="$TOKEN_GH" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
      git -C "$WT" -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$N29_TOKEN_PUSH"; }; f' \
        push "https://github.com/$REPO_GH.git" "$refspec"
    ) || return $?
  else
    echo "aviso: sin N29_GH_TOKEN, el push y el PR usan las credenciales de git y gh de esta máquina (N29_EXIGIR_TOKEN=1 lo impide)"
    git -C "$WT" push "$REMOTO" "$refspec" || return $?
  fi
  {
    # No GitHub notifications from quoted handles in the summary.
    head -c 60000 "$EJ/resumen.md" | perl -CSD -pe 's/\@(?=\w)/\@\x{200B}/g'
    [ "$(wc -c <"$EJ/resumen.md")" -le 60000 ] || printf '\n\n_Resumen recortado; completo en la carpeta de la ejecución._\n'
    printf '\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'
  } >"$EJ/pr.md"
  if [ -n "$TOKEN_GH" ]; then
    (cd "$WT" && export GH_TOKEN="$TOKEN_GH" GH_PROMPT_DISABLED=1 && gh pr create --repo "$REPO_GH" --draft --base "$BASE" --head "$RAMA" --title "chore(29n): datos de la recogida del $FECHA" --body-file "$EJ/pr.md") >"$EJ/pr.txt" || return $?
  else
    (cd "$WT" && gh pr create --draft --base "$BASE" --head "$RAMA" --title "chore(29n): datos de la recogida del $FECHA" --body-file "$EJ/pr.md") >"$EJ/pr.txt" || return $?
  fi
  cat "$EJ/pr.txt"
}

# No changes: the worktree and the branch go, but the branch is deleted only if it still points at the base.
sin_cambios() {
  local base
  base="$(cat "$PRIV/base.sha")"
  [ "$(git -C "$WT" rev-parse HEAD)" = "$base" ] || { echo "HEAD del worktree no es la base: no se borra nada"; return 1; }
  git -C "$N29_REPO" worktree remove --force "$WT" || return $?
  if [ "$(git -C "$N29_REPO" rev-parse --verify "refs/heads/$RAMA")" = "$base" ]; then
    git -C "$N29_REPO" branch -D "$RAMA"
  else
    echo "la rama $RAMA ya no apunta a la base: se deja"
  fi
}

# ------------------------------------------------------------------ run

say "Recogida del $FECHA$([ "$SECO" = 1 ] && echo ' (seco)')$([ "$REANUDAR" = 1 ] && echo ": se reanuda en $DESDE")"
if [ "$REANUDAR" = 0 ]; then
if [ "$SECO" = 0 ]; then etapa worktree fatal crear_worktree; else omitida worktree seco; fi
etapa instantanea fatal instantanea

# 1. Collection
if [ ${#ATRASOS[@]} -gt 0 ]; then
  printf 'atrasos\tok\t%s a %s: %s\n' "$ATRASOS_DESDE" "$ATRASOS_HASTA" "$ATRASOS_EMISORES" >>"$EJ/etapas.tsv"
  etapa descubrir fatal cli descubrir --fecha "$FECHA" "${ATRASOS[@]}"
else
  etapa descubrir fatal cli descubrir --fecha "$FECHA"
fi
etapa traer fatal cli traer --fecha "$FECHA"
etapa buzon aviso cli buzon --fecha "$FECHA"
# The owner's links list ($N29_BUZON/enlaces/<fecha>.txt), fetched like any article; bad lines are avisos.
etapa enlaces aviso cli enlaces --fecha "$FECHA"
etapa transcribir aviso paso_transcribir
etapa tareas-equidad fatal glue tareas-equidad
# The script, not the agents, probes each equal-search domain once and marks blocked queries for all four.
etapa sondeo fatal glue sondear

# 2a. Search (Claude), then fetch what it found
if [ "$SECO" = 1 ]; then
  # With --atrasos-*, the fixture answers of the atrasos tasks too (fixtures/diario/juicio-atrasos).
  if [ ${#ATRASOS[@]} -gt 0 ]; then
    etapa busqueda fatal ensayar_sesion busqueda "$FIJOS/juicio" "$FIJOS/juicio-atrasos"
  else
    etapa busqueda fatal ensayar_sesion busqueda "$FIJOS/juicio"
  fi
else
  etapa busqueda fatal claude_pasada busqueda
fi
fi # REANUDAR
if [ "$DESDE" != tareas-clasificar ] && [ "$DESDE" != hechos ] && [ "$DESDE" != preparar ]; then
# Every planned query and every unblocked equal search must have run, or nothing is adjudicated (busqueda-faltan.txt).
# Retryable gaps get one more session for just those tasks, then the same check again.
etapa busqueda-completa fatal paso_busqueda_completa
etapa traer-busqueda fatal paso_traer_busqueda
fi # DESDE
if [ "$DESDE" != hechos ] && [ "$DESDE" != preparar ]; then
etapa tareas-clasificar fatal glue tareas-clasificar
# 2b. Classification: one session per batch of 100 tasks; every answer must exist and be valid.
etapa clasificacion fatal paso_clasificacion
fi # DESDE

# 3. Shared facts (one session), then one adjudication session per party, on the checked classifications
if [ "$DESDE" != preparar ]; then
etapa hechos fatal paso_hechos
etapa adjudicacion fatal paso_adjudicacion
else
etapa reponer fatal reponer_para_fusion
fi # DESDE
etapa adjudicacion-completa fatal glue adjudicacion-completa
etapa preparar fatal glue preparar

# 4. Merge (the script, not Claude, writes the site)
etapa fusionar fatal paso_fusionar
etapa ajustar fatal glue ajustar
# Sources found blocking today (robots.txt against Claude's agents) go into fuentes.json; recorded ones are reread, never removed.
etapa fuentes-bloqueo aviso glue fuentes-bloqueo
# Allowlist of the site, git-ignored files included, before anything is installed.
etapa alcance fatal paso_alcance ignorados
etapa citas comprobacion paso_citas

# 5. Site checks
if [ "$SECO" = 0 ]; then
  etapa instalar fatal sh -c 'cd "$1" && corepack yarn install --immutable' sh "$WT"
  etapa prettier fatal paso_prettier
  etapa alcance-prettier fatal paso_alcance
  etapa test comprobacion sh -c 'cd "$1" && corepack yarn workspace 29n test' sh "$WT"
  etapa build comprobacion sh -c 'cd "$1" && corepack yarn workspace 29n build' sh "$WT"
else
  for nombre in instalar prettier alcance-prettier test build; do omitida "$nombre" seco; done
fi

# 6. Summary
etapa resumen fatal paso_resumen
if [ "$COMPROBACIONES_OK" = 0 ]; then
  # In the stage table too, so the day can be resumed from the merge (punto_de_reanudacion).
  printf 'comprobaciones\tfallo\talguna comprobación falló\n' >>"$EJ/etapas.tsv"
  fallo comprobaciones "alguna comprobación falló (ver la tabla de etapas)"
fi
cp "$EJ/resumen.parcial.md" "$EJ/resumen.md"

# 7. Git
if [ "$SECO" = 1 ]; then
  trap - ERR
  # Same input, same output: paths of this dry run become <RAIZ>, then one digest of the tree.
  find "$RAIZ" -type f \( -name '*.json' -o -name '*.md' -o -name '*.txt' -o -name '*.tsv' -o -name '*.log' \) -print0 |
    RAIZ="$RAIZ" xargs -0 perl -pi -e 's{\Q$ENV{RAIZ}\E}{<RAIZ>}g'
  (cd "$RAIZ" && find . -type f ! -name huella.txt -print | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$f"; done) >"$RAIZ/huella.txt"
  # Printed only, not logged: the log is part of the digest.
  printf 'Seco terminado: %s\nHuella: %s\n' "$RAIZ" "$(shasum -a 256 "$RAIZ/huella.txt" | cut -d' ' -f1)"
  exit 0
fi
if [ "$SIN_GIT" = 1 ]; then
  say "Sin git: resumen en $EJ/resumen.md; worktree en $WT"
  exit 0
fi
if [ -z "$(datos_tocados)" ]; then
  printf '\n_Sin cambios en los datos: no hay commit ni PR._\n' >>"$EJ/resumen.md"
  etapa sin-cambios aviso sin_cambios
  say "Sin cambios: no hay PR"
  exit 0
fi
etapa git fatal paso_git
say "PR en borrador: $(cat "$EJ/pr.txt")"
