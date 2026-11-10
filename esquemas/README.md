# Esquemas de los datos

Estructura de los cuatro archivos de datos del sitio, en JSON Schema (draft 2020-12). Solo estructura: los datos no se publican en este repositorio.

| Esquema | Archivo del sitio | Validador que manda |
|---|---|---|
| [partido.schema.json](partido.schema.json) | `src/data/partidos/<id>.json` (una ficha por partido) | `validatePartido` ([validate.ts](../procesado/src/lib/validate.ts)) |
| [fuentes.schema.json](fuentes.schema.json) | `src/data/fuentes.json` (registro de emisores) | `validateFuentes` ([fuentes.ts](../procesado/src/lib/fuentes.ts)) |
| [temas-items.schema.json](temas-items.schema.json) | `src/data/temas-items.json` (teletipos clasificados) | `validateTemas` ([temas.ts](../procesado/src/lib/temas.ts)) |
| [partidos-alias.schema.json](partidos-alias.schema.json) | `src/data/partidos-alias.json` (nombres para las búsquedas) | `validatePartidosAlias` ([partidos-alias.ts](../procesado/src/lib/partidos-alias.ts)) |

Los esquemas se han escrito a partir de los tipos TypeScript y de los validadores. **Mandan los validadores**: son los que detienen la publicación, y comprueban reglas que JSON Schema no expresa bien (palabras de las citas, regla de enlaces, unicidad entre partidos, bandas de MBFC, eventos de un solo día). Si un esquema y un validador no coinciden, el error está en el esquema.

Las salidas de cada agente tienen su propio esquema, en el documento de cada workflow ([`../agentes/`](../agentes/)).
