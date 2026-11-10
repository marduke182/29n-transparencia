// Copia saneada del script original del workflow (29n, 10 nov 2026). Rutas locales sustituidas por <DATOS>, <CRITERIOS> y <REPO_SITIO>; el resto es literal.
export const meta = {
  name: '29n-party-corrections',
  description: 'One Opus agent per party applies the safe fixes and adjudicates the re-verification findings on its party file',
  phases: [{ title: 'Correct party sheets' }],
}
const C = '<CRITERIOS>/correcciones.md'
const parties = [['pp', 'PP'], ['psoe', 'PSOE'], ['vox', 'Vox'], ['frente-amplio', 'Frente Amplio'], ['podemos', 'Podemos']]
phase('Correct party sheets')
const out = await parallel(parties.map(([id, name]) => () =>
  agent(
`You correct the published party sheet for ${name} (id "${id}") on the strictly neutral election site 29n.jrquintana.dev. Read the shared criteria first: ${C}. Then follow them exactly for the file apps/29n/src/data/partidos/${id}.json in the worktree <REPO_SITIO> (run commands only there; never cd elsewhere; do not commit). Only edit apps/29n/src/data/partidos/${id}.json — four other agents are editing the other parties' files at the same time, and another agent edits fuentes.json, components and pages; do not touch those. If a URL you need belongs to a host not yet in apps/29n/src/data/fuentes.json, don't add it there: report the host and keep a different source if possible. Use the entries with partido="${id}" in the re-verification file. Apply the same standard you would to any other party. Return the change log described in the criteria.`,
    { label: `fix:${id}`, phase: 'Correct party sheets', model: 'opus' }
  )
))
return { logs: out }
