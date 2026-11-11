#!/usr/bin/env bash
# Daily run of 29n.jrquintana.dev (agentes/08-diario.md). Ends in a draft PR
# for the owner's review; it never merges, deploys, enables auto-merge or
# pushes anything but its own data/29n-diario-<fecha> branch.
#
#   diario.sh                          today's run (the date is read once, here)
#   diario.sh --fecha 2026-11-12       a missed day, by argument, never by clock
#   diario.sh --fecha D --sin-git      every stage, Claude included, but no commit, push or PR
#   diario.sh --fecha D --seco [--salida DIR]
#                                      dry run: the CLI stages against the fixture
#                                      in fixtures/diario, offline, without Claude,
#                                      the site checks or git; prints a digest
#
# Environment (live runs; see recogida/README.md):
#   N29_REPO             checkout of the site repository (the worktree is created from it)
#   N29_WORKTREES        folder for the run worktrees (<N29_WORKTREES>/29n-diario-<fecha>)
#   N29_CACHE            cache and run folders, outside any repository
#   N29_BUZON            the owner's manual inbox
#   N29_PRESUPUESTO_USD  spending cap of each Claude pass (required)
#   N29_CLAUDE           claude binary (default: claude), version 2.1.321 or later
#   N29_RAMA_BASE        base branch (default: master), N29_REMOTO (default: origin)
#   N29_LIMITE_CLAUDE_S, N29_LIMITE_VIDEO_S (above 14400), N29_MODELO_WHISPER   optional
#
# Security model: Claude never writes outside its answers in the run folder.
# Its settings, agents and prompts are built from this repository right before
# each pass into a fresh folder outside every folder it can write to, checked
# by sha256, and it starts from an empty folder there. Files the script relies
# on are sealed by sha256 before each pass and checked after it. Only the
# script writes the site, and only the allowlisted JSON files.
# Bash 3.2 compatible (macOS /bin/bash).
set -euo pipefail

uso() {
  sed -n '6,12p' "$0" | sed 's/^# \{0,1\}//' >&2
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
SALIDA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fecha) valor "$@"; FECHA="$2"; shift 2 ;;
    --salida) valor "$@"; SALIDA="$2"; shift 2 ;;
    --seco) SECO=1; shift ;;
    --sin-git) SIN_GIT=1; shift ;;
    -h | --help) uso ;;
    *) die "opción desconocida: $1" ;;
  esac
done

HOY="$(date +%F)" # the only clock read of the run
FECHA="${FECHA:-$HOY}"
case "$FECHA" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) die "--fecha debe ser AAAA-MM-DD" ;;
esac
# A real calendar date (parsed, not read from the clock): 2026-02-30 is refused.
[ "$(date -j -f %F "$FECHA" +%F 2>/dev/null || date -d "$FECHA" +%F 2>/dev/null)" = "$FECHA" ] || die "--fecha $FECHA no es una fecha"
[ "$SECO" = 1 ] || [ ! "$FECHA" \> "$HOY" ] || die "--fecha $FECHA es posterior a hoy ($HOY)"
[ -z "$SALIDA" ] || [ "$SECO" = 1 ] || die "--salida solo vale con --seco"

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
CLAUDE_MINIMA="2.1.321"
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
  command -v "$N29_CLAUDE" >/dev/null || die "no se encuentra claude ($N29_CLAUDE)"
  version_minima "$("$N29_CLAUDE" --version 2>/dev/null | awk '{print $1}')" "$CLAUDE_MINIMA" ||
    die "claude debe ser la versión $CLAUDE_MINIMA o posterior (las opciones y permisos de esta ejecución se comprobaron con ella)"
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

# A previous attempt of the same day is kept, renamed, never mixed with this one.
if [ -e "$EJ" ]; then
  n=1
  while [ -e "$EJ.intento-$n" ]; do n=$((n + 1)); done
  mv "$EJ" "$EJ.intento-$n"
fi
mkdir -p "$EJ"
LOG="$EJ/diario.log"
: >"$EJ/etapas.tsv"
COMPROBACIONES_OK=1
say() { printf '%s\n' "$*" | tee -a "$LOG"; }

# Writes the failure to resumen.md (with the partial summary, if any) and stops. No commit happens.
fallo() {
  trap - ERR
  {
    printf '# Recogida del %s: fallo\n\n' "$FECHA"
    printf -- '- Etapa: %s\n- Motivo: %s\n' "$1" "$2"
    if [ "$SECO" = 0 ]; then
      printf -- '- Sin commit, push ni PR. El worktree, si se creó, queda en `%s` (rama `%s`) para revisarlo.\n' "$WT" "$RAMA"
      printf -- '- Para repetir el día, ver «Recuperar un día» en recogida/README.md.\n'
    fi
    printf '\n## Últimas líneas del registro\n\n```text\n'
    tail -n 60 "$LOG" 2>/dev/null || true
    printf '```\n'
    if [ -f "$EJ/resumen.parcial.md" ]; then
      printf '\n'
      cat "$EJ/resumen.parcial.md"
    fi
  } >"$EJ/resumen.md"
  say "FALLO en $1: $2 (detalle en $EJ/resumen.md)"
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
huellas_protegidas() {
  local pasada="$1"
  (
    cd "$EJ" || exit 1
    if [ "$pasada" = busqueda ]; then
      find . -type f ! -path './busqueda/*' ! -path './equidad/*' ! -path './clasificacion/*' ! -path './adjudicado/*' \
        ! -name 'hechos.json*' ! -path './claude/*' ! -name diario.log ! -name etapas.tsv -print
    else
      find . -type f ! -path './clasificacion/*' ! -path './adjudicado/*' \
        ! -name 'hechos.json*' ! -path './claude/*' ! -name diario.log ! -name etapas.tsv -print
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
}

# Read-only inputs for the agents and the baseline of the day: the site data before anything changes.
instantanea() {
  mkdir -p "$EJ/antes" || return $?
  cp -R "$DATOS/partidos" "$EJ/antes/partidos" || return $?
  if [ -d "$DATOS/perfiles" ]; then cp -R "$DATOS/perfiles" "$EJ/antes/perfiles" || return $?; fi
  cp "$DATOS/busquedas.json" "$DATOS/fuentes.json" "$EJ/antes/"
}

paso_transcribir() {
  local video oficial codigo=0
  glue videos >"$EJ/videos.tsv" || return $?
  while IFS="$(printf '\t')" read -r video oficial; do
    [ -n "$video" ] || continue
    if [ -n "$oficial" ]; then
      con_limite "$LIMITE_VIDEO" node ${IMPORTAR:+--import "$IMPORTAR"} "$RECOGIDA/bin/29n-recogida.ts" transcribir --fecha "$FECHA" --video "$video" --oficial "$oficial" ${N29_MODELO_WHISPER:+--modelo-whisper "$N29_MODELO_WHISPER"} || codigo=1
    else
      con_limite "$LIMITE_VIDEO" node ${IMPORTAR:+--import "$IMPORTAR"} "$RECOGIDA/bin/29n-recogida.ts" transcribir --fecha "$FECHA" --video "$video" ${N29_MODELO_WHISPER:+--modelo-whisper "$N29_MODELO_WHISPER"} || codigo=1
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

# Stand-in for the Claude passes in --seco: the fixture's judgment outputs.
copiar_juicio() {
  local cosa
  for cosa in "$@"; do cp -R "$FIJOS/juicio/$cosa" "$EJ/$cosa" || return $?; done
}

# Builds settings, agents and prompts from this repository into a fresh
# folder outside every writable one, read-only, with an empty start folder.
preparar_conf() {
  local pasada="$1"
  CONF="$(real "$(mktemp -d "${TMPDIR:-/tmp}/29n-claude.XXXXXX")")" || return $?
  comprobar_separadas "$CONF" "$N29_CACHE" "$N29_BUZON" "$N29_WORKTREES" "$T" "$PRIV" || return 1
  glue claude --dir "$CONF" --pasada "$pasada" || return $?
  mkdir "$CONF/vacio" || return $?
  chmod 444 "$CONF"/*.json "$CONF"/*.txt && chmod 555 "$CONF/vacio" "$CONF" || return $?
  (cd "$CONF" && shasum -a 256 settings.json agentes.json prompt.txt) >"$PRIV/conf.sha"
}
borrar_conf() {
  [ -n "${CONF:-}" ] || return 0
  chmod -R u+w "$CONF" && rm -rf "$CONF"
  CONF=""
}

claude_pasada() {
  local pasada="$1" codigo=0 resto
  preparar_conf "$pasada" || return $?
  (cd "$CONF" && shasum -a 256 -c --status "$PRIV/conf.sha") || { echo "la configuración de Claude cambió antes de usarla"; return 1; }
  sellar "$pasada" || return $?
  # --restricted ignores user, project and local settings files: only --settings applies.
  (
    cd "$CONF/vacio" &&
      con_limite "$LIMITE_CLAUDE" "$N29_CLAUDE" -p \
        --model opus \
        --restricted \
        --settings "$CONF/settings.json" \
        --strict-mcp-config \
        --agents "$CONF/agentes.json" \
        --tools "Agent,Read,Write,Glob,Grep,WebFetch,WebSearch" \
        --permission-mode dontAsk \
        --permission-prompts none \
        --add-dir "$EJ" \
        --add-dir "$N29_CACHE/docs" \
        --add-dir "$T/criterios" \
        --no-session-persistence \
        --output-format json \
        --max-budget-usd "$N29_PRESUPUESTO_USD" \
        <"$CONF/prompt.txt" >"$PRIV/$pasada.salida.json"
  ) || codigo=$?
  verificar_sello "$pasada" || codigo=1
  # Pass 1 may write only busqueda/ and equidad/: pass 2's answers must not exist yet.
  if [ "$pasada" = busqueda ]; then
    resto="$(cd "$EJ" && find . -maxdepth 1 \( -name clasificacion -o -name adjudicado -o -name 'hechos.json*' \) -print)"
    [ -z "$resto" ] || { printf 'la pasada busqueda dejó archivos de la pasada adjudicacion:\n%s\n' "$resto"; codigo=1; }
  fi
  # Audit copy of what ran, made after the check so the pass cannot have touched it.
  mkdir -p "$EJ/claude" && cp "$CONF/settings.json" "$EJ/claude/$pasada.settings.json" && cp "$CONF/agentes.json" "$EJ/claude/agentes.json" &&
    cp "$CONF/prompt.txt" "$EJ/claude/$pasada.prompt.txt" && cp "$PRIV/$pasada.salida.json" "$EJ/claude/" 2>/dev/null || true
  borrar_conf
  [ "$codigo" = 0 ] || return $codigo
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (r.is_error) { console.error(r.result ?? r.subtype); process.exit(1); } console.log(r.result);' "$EJ/claude/$pasada.salida.json"
}

# --seco builds and checks the Claude configuration too, without running Claude.
ensayar_conf() {
  local pasada
  for pasada in busqueda adjudicacion; do
    preparar_conf "$pasada" || return $?
    (cd "$CONF" && shasum -a 256 -c --status "$PRIV/conf.sha") || return 1
    borrar_conf
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

# Allowlist: only the four party files, the four perfiles and busquedas.json,
# modified or added, each valid JSON. Anything else (a deletion, a rename, any
# other file, any non-JSON file) stops the run before install, test and build.
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
      apps/29n/src/data/partidos/frente-amplio.json | apps/29n/src/data/partidos/pp.json | apps/29n/src/data/partidos/psoe.json | apps/29n/src/data/partidos/vox.json) ;;
      apps/29n/src/data/perfiles/frente-amplio.json | apps/29n/src/data/perfiles/pp.json | apps/29n/src/data/perfiles/psoe.json | apps/29n/src/data/perfiles/vox.json) ;;
      *) malos="$malos$linea (fuera de la lista)"$'\n'; continue ;;
    esac
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$WT/$ruta" 2>/dev/null || malos="$malos$linea (no es JSON)"$'\n'
  done < <(cambios_sitio "${1:-}")
  [ -z "$malos" ] || { printf 'cambios no admitidos en el sitio:\n%s' "$malos"; return 1; }
}

datos_tocados() { cambios_sitio | sed 's/^...//'; }

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
  # Only this branch, by explicit refspec: never master, never --force.
  git -C "$WT" push "$REMOTO" "refs/heads/$RAMA:refs/heads/$RAMA" || return $?
  {
    # No GitHub notifications from quoted handles in the summary.
    head -c 60000 "$EJ/resumen.md" | perl -CSD -pe 's/\@(?=\w)/\@\x{200B}/g'
    [ "$(wc -c <"$EJ/resumen.md")" -le 60000 ] || printf '\n\n_Resumen recortado; completo en la carpeta de la ejecución._\n'
    printf '\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'
  } >"$EJ/pr.md"
  (cd "$WT" && gh pr create --draft --base "$BASE" --head "$RAMA" --title "chore(29n): datos de la recogida del $FECHA" --body-file "$EJ/pr.md") >"$EJ/pr.txt" || return $?
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

say "Recogida del $FECHA$([ "$SECO" = 1 ] && echo ' (seco)')"
if [ "$SECO" = 0 ]; then etapa worktree fatal crear_worktree; else omitida worktree seco; fi
etapa instantanea fatal instantanea

# 1. Collection
etapa descubrir fatal cli descubrir --fecha "$FECHA"
etapa traer fatal cli traer --fecha "$FECHA"
etapa buzon aviso cli buzon --fecha "$FECHA"
etapa transcribir aviso paso_transcribir
etapa tareas-equidad fatal glue tareas-equidad
# The script, not the agents, probes each equal-search domain once and marks blocked queries for all four.
etapa sondeo fatal glue sondear

# 2a. Search (Claude), then fetch what it found
if [ "$SECO" = 1 ]; then
  etapa configuracion-claude fatal ensayar_conf
  etapa busqueda fatal copiar_juicio busqueda equidad
else
  etapa busqueda fatal claude_pasada busqueda
fi
etapa traer-busqueda fatal paso_traer_busqueda
etapa tareas-clasificar fatal glue tareas-clasificar

# 2b + 3. Classification and adjudication (Claude)
if [ "$SECO" = 1 ]; then
  etapa adjudicacion fatal copiar_juicio hechos.json adjudicado
else
  etapa adjudicacion fatal claude_pasada adjudicacion
fi
etapa adjudicacion-completa fatal glue adjudicacion-completa
etapa preparar fatal glue preparar

# 4. Merge (the script, not Claude, writes the site)
etapa fusionar fatal paso_fusionar
etapa ajustar fatal glue ajustar
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
[ "$COMPROBACIONES_OK" = 1 ] || fallo comprobaciones "alguna comprobación falló (ver la tabla de etapas)"
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
