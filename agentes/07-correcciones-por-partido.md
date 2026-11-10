# Corrección de las fichas, un agente por partido

| | |
|---|---|
| Fecha de ejecución | 10 nov 2026 |
| Modelo | Opus |
| Agentes | 5 (uno por partido, en paralelo, con el mismo prompt y el mismo criterio escrito) |
| Script | [`workflows/29n-party-corrections.js`](workflows/29n-party-corrections.js) |
| Descripción original | One Opus agent per party applies the safe fixes and adjudicates the re-verification findings on its party file |

**Propósito.** Adjudicar los resultados de la reverificación (06) sobre la ficha de cada partido siguiendo un criterio común escrito ([`criterios/correcciones.md`](../criterios/correcciones.md)): aplica los arreglos seguros (URL canónica, descartar lo FALSO o NO VERIFICABLE) y decide con juicio los casos PARCIAL y CORREGIDO. Cada agente solo puede editar la ficha de su partido.

**Entrada.** `<CRITERIOS>/correcciones.md` (el criterio), la ficha `apps/29n/src/data/partidos/<id>.json` del repositorio del sitio (`<REPO_SITIO>`) y el archivo de reverificación de 06.

**Salida.** Sin esquema: un registro de cambios en texto (por ítem qué se hizo y por qué, URLs cambiadas, ítems descartados, objeciones rechazadas y un resumen numérico), como pide el criterio.

Los prompts están en inglés porque así se ejecutaron; se copian literalmente del script. Lo único cambiado son las rutas locales, sustituidas por `<DATOS>`, `<CRITERIOS>` y `<REPO_SITIO>`. Las expresiones `${...}` se rellenan en cada agente con la fuente, el partido o el número de candidato.

## Constantes que se insertan en el prompt

```js
const C = '<CRITERIOS>/correcciones.md'
```

## Prompt

```text
You correct the published party sheet for ${name} (id "${id}") on the strictly neutral election site 29n.jrquintana.dev. Read the shared criteria first: ${C}. Then follow them exactly for the file apps/29n/src/data/partidos/${id}.json in the worktree <REPO_SITIO> (run commands only there; never cd elsewhere; do not commit). Only edit apps/29n/src/data/partidos/${id}.json — four other agents are editing the other parties' files at the same time, and another agent edits fuentes.json, components and pages; do not touch those. If a URL you need belongs to a host not yet in apps/29n/src/data/fuentes.json, don't add it there: report the host and keep a different source if possible. Use the entries with partido="${id}" in the re-verification file. Apply the same standard you would to any other party. Return the change log described in the criteria.
```

## Esquema de salida

Ninguno: el agente devuelve texto libre (el registro de cambios que pide el criterio).
