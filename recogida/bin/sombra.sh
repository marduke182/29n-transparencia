#!/usr/bin/env bash
# Shadow run: this checkout's diario.sh for one day, next to the live run and without touching it.
#
#   sombra.sh --fecha D --vivo-cache DIR --vivo-repo DIR --sombra DIR
#
# Everything the shadow writes is under --sombra (an empty or new folder outside both live folders):
#   <sombra>/origen.git      a mirror of the live site repository, read once (git clone --mirror), with master at
#                            the live day's base and without the day's branch: the shadow's only remote
#   <sombra>/repo            a clone of that mirror (N29_REPO), and <sombra>/worktrees its worktree (N29_WORKTREES)
#   <sombra>/cache           N29_CACHE: the live day's search results and cached documents, copied, never fetched
#   <sombra>/buzon           an empty inbox (N29_BUZON): the live day already read its inbox and links list
# The live cache and repository are only read (cp, git clone). The shadow starts from the live day's search: it
# resumes at the classification (diario.sh --sellar, then --reanudar … --sin-git), so it fetches nothing new and
# makes no commit, push or PR. Its Claude passes, merge, checks and summary are this checkout's.
# Then compare the two days: node bin/comparar.ts <vivo-cache>/ejecuciones/D <sombra>/cache/ejecuciones/D
# N29_PRESUPUESTO_USD (required) and N29_PRESUPUESTO_DIA_USD (default 200) apply as in a live run.
set -euo pipefail

die() {
  printf 'sombra.sh: %s\n' "$*" >&2
  exit 2
}
FECHA="" VIVO_CACHE="" VIVO_REPO="" SOMBRA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fecha) FECHA="${2:-}"; shift 2 ;;
    --vivo-cache) VIVO_CACHE="${2:-}"; shift 2 ;;
    --vivo-repo) VIVO_REPO="${2:-}"; shift 2 ;;
    --sombra) SOMBRA="${2:-}"; shift 2 ;;
    *) die "opción desconocida: $1" ;;
  esac
done
case "$FECHA" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) die "--fecha AAAA-MM-DD" ;; esac
[ -n "$VIVO_CACHE" ] && [ -n "$VIVO_REPO" ] && [ -n "$SOMBRA" ] || die "faltan --vivo-cache, --vivo-repo o --sombra"
[ -n "${N29_PRESUPUESTO_USD:-}" ] || die "falta N29_PRESUPUESTO_USD"

real() { (cd "$1" && pwd -P); }
dentro() { case "$1/" in "$2"/*) return 0 ;; *) return 1 ;; esac; }
RECOGIDA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
VIVO_CACHE="$(real "$VIVO_CACHE")"
VIVO_REPO="$(real "$VIVO_REPO")"
VIVO_EJ="$VIVO_CACHE/ejecuciones/$FECHA"
[ -d "$VIVO_EJ" ] || die "no existe $VIVO_EJ"
grep -q "$(printf '^traer-busqueda\tok')" "$VIVO_EJ/etapas.tsv" || die "la búsqueda del $FECHA en vivo no terminó: no hay nada que comparar"
[ -f "$VIVO_EJ/base.sha" ] || die "falta $VIVO_EJ/base.sha"
mkdir -p "$SOMBRA"
SOMBRA="$(real "$SOMBRA")"
[ -z "$(ls -A "$SOMBRA")" ] || die "--sombra debe ser una carpeta vacía"
for vivo in "$VIVO_CACHE" "$VIVO_REPO"; do
  if dentro "$SOMBRA" "$vivo" || dentro "$vivo" "$SOMBRA"; then die "$SOMBRA y $vivo no pueden estar uno dentro del otro"; fi
done
dentro "$SOMBRA" "$(real "$RECOGIDA/..")" && die "--sombra no puede estar dentro de este repositorio"

BASE_SHA="$(cat "$VIVO_EJ/base.sha")"
RAMA="data/29n-diario-$FECHA"
EJ="$SOMBRA/cache/ejecuciones/$FECHA"
mkdir -p "$EJ" "$SOMBRA/cache/docs" "$SOMBRA/buzon" "$SOMBRA/worktrees"

# 1. The site repository: read once into a mirror; master at the live base, the day's branch gone.
git clone --quiet --mirror "$VIVO_REPO" "$SOMBRA/origen.git"
git -C "$SOMBRA/origen.git" cat-file -e "$BASE_SHA^{commit}" || die "la base $BASE_SHA no está en $VIVO_REPO"
git -C "$SOMBRA/origen.git" update-ref refs/heads/master "$BASE_SHA"
git -C "$SOMBRA/origen.git" for-each-ref --format='%(refname)' | grep -F "/$RAMA" | while IFS= read -r ref; do git -C "$SOMBRA/origen.git" update-ref -d "$ref"; done
git clone --quiet "$SOMBRA/origen.git" "$SOMBRA/repo"
git -C "$SOMBRA/repo" worktree add --quiet --no-track -b "$RAMA" "$SOMBRA/worktrees/29n-diario-$FECHA" "$BASE_SHA"

# 2. The live day up to its search, copied: never the classification, the facts, the adjudication or later files.
for f in antes base.sha descubrir.json descubrir.busqueda.json descubrir.listados.json traer.json traer.busqueda.json traer.listados.json \
  enlaces.json videos.tsv equidad-tareas.json sondeo.json bloqueos-guia.json busqueda equidad reintento-fuentes.json reintento-equidad.json \
  reintento-rutas.txt reintento-anterior busqueda-reintentadas.txt busqueda-aceptadas.txt busqueda-reintento.iniciado; do
  [ ! -e "$VIVO_EJ/$f" ] || cp -R "$VIVO_EJ/$f" "$EJ/$f"
done
chmod -R u+w "$EJ"
[ ! -f "$VIVO_CACHE/bloqueados.json" ] || cp "$VIVO_CACHE/bloqueados.json" "$SOMBRA/cache/bloqueados.json"
# The cached documents the day's classification reads: those consulted that day, and those its equal searches found.
node --input-type=module -e '
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [recogida, origen, destino, ej, fecha] = process.argv.slice(1);
const { idDocumento, urlCanonica } = await import(join(recogida, "src", "cache.ts"));
const ids = new Set();
for (const id of readdirSync(join(origen, "docs"))) {
  try { if (JSON.parse(readFileSync(join(origen, "docs", id, "meta.json"), "utf8")).consultado === fecha) ids.add(id); } catch {}
}
if (existsSync(join(ej, "equidad"))) for (const f of readdirSync(join(ej, "equidad")).filter((f) => f.endsWith(".json"))) {
  try { for (const r of JSON.parse(readFileSync(join(ej, "equidad", f), "utf8")).resultados ?? []) ids.add(idDocumento(urlCanonica(r.url))); } catch {}
}
let n = 0;
for (const id of [...ids].sort()) if (existsSync(join(origen, "docs", id))) { cpSync(join(origen, "docs", id), join(destino, "docs", id), { recursive: true }); n++; }
console.log(`${n} documentos copiados a la sombra`);
' "$RECOGIDA" "$VIVO_CACHE" "$SOMBRA/cache" "$EJ" "$FECHA"
printf 'busqueda\tok\t\nbusqueda-completa\tok\t\ntraer-busqueda\tok\t\ntareas-clasificar\tfallo\tsombra: desde la búsqueda del día en vivo\n' >"$EJ/etapas.tsv"

# 3. This checkout's run, from the classification, in the shadow folders only.
export N29_REPO="$SOMBRA/repo" N29_WORKTREES="$SOMBRA/worktrees" N29_CACHE="$SOMBRA/cache" N29_BUZON="$SOMBRA/buzon" N29_REMOTO=origin N29_RAMA_BASE=master
unset N29_GH_TOKEN
sello="$("$RECOGIDA/bin/diario.sh" --fecha "$FECHA" --sellar | sed -n 's/^Sello de .*: \([0-9a-f]\{64\}\)$/\1/p')"
[ -n "$sello" ] || die "no se pudo sellar la carpeta de la sombra"
"$RECOGIDA/bin/diario.sh" --fecha "$FECHA" --reanudar "$sello" --sin-git || true
printf '\nSombra del %s en %s.\nComparar: node %s/bin/comparar.ts %s %s\n' "$FECHA" "$SOMBRA" "$RECOGIDA" "$VIVO_EJ" "$EJ"
