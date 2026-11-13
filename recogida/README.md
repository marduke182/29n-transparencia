# Recogida diaria

Herramientas de la actualización diaria de [29n.jrquintana.dev](https://29n.jrquintana.dev). Cada mañana, [`bin/diario.sh`](bin/diario.sh) recoge lo publicado, deja que los agentes de [08-diario](../agentes/08-diario.md) busquen, clasifiquen y propongan, fusiona las propuestas con código determinista, pasa las comprobaciones del sitio y abre un **PR en borrador** para que el autor lo revise. Nunca fusiona, despliega, activa el auto-merge ni sube nada a `master`: solo empuja su propia rama `data/29n-diario-<fecha>`.

| Archivo | Qué es |
|---|---|
| [`bin/29n-recogida.ts`](bin/29n-recogida.ts) | La CLI: `descubrir`, `traer`, `buzon`, `transcribir`, `binarios`, `fusionar`. |
| [`bin/diario.sh`](bin/diario.sh) | La ejecución diaria completa (etapas 1 a 7 de [08](../agentes/08-diario.md#etapas)). |
| [`src/diario.ts`](src/diario.ts) | El código determinista entre etapas: tareas de búsqueda igual, candidatos de búsqueda, tareas de clasificación, comprobación de la adjudicación, preparación de la fusión, ajuste de N y de la fecha de corte, informe, y los ajustes, subagentes y prompts de Claude. |
| [`src/bloqueos.ts`](src/bloqueos.ts) | Las fuentes que bloquean: los dominios que ninguna sesión de Claude puede leer, el campo `bloqueo` de `fuentes.json` que propone la ejecución y su lista blanca. |
| [`src/citas.ts`](src/citas.ts), [`src/resumen.ts`](src/resumen.ts) | Comprobación de citas literales contra la caché y resumen del día. |
| [`claude-settings.diario.template.json`](claude-settings.diario.template.json) | Plantilla de los permisos de la sesión de Claude sin cabeza; `diario.sh` la rellena en cada pasada. |
| [`launchd/dev.29n.diario.plist.template`](launchd/dev.29n.diario.plist.template) | Plantilla opcional del trabajo de launchd (a las 07:00). No está instalada: las ejecuciones se inician a mano. |
| [`fixtures/diario/`](fixtures/diario/) | Datos inventados para el ensayo en seco (`--seco`): un sitio mínimo, una red fija y las salidas de los agentes. |

## Instalación

Requisitos: macOS, Node 24 o posterior (ejecuta TypeScript sin compilar), `corepack`, `git`, [`gh`](https://cli.github.com/) con sesión iniciada (`gh auth status`), `perl` (viene con macOS) y Claude Code (`claude`) **2.1.321 o posterior**, con sesión iniciada. `diario.sh` comprueba `claude --version` y se niega a correr con una versión anterior: las opciones y los permisos que usa se comprobaron con esa.

```sh
cd recogida
npm ci
npx vitest run && npx tsc --noEmit
```

Herramientas externas, solo para `transcribir` (nunca se instalan solas; `node bin/29n-recogida.ts binarios` dice qué falta):

```sh
brew install yt-dlp ffmpeg          # subtítulos y audio
pipx install openai-whisper         # o: brew install whisper-cpp, con un modelo ggml (N29_MODELO_WHISPER)
```

Sin ellas la ejecución sigue: un vídeo sin transcripción oficial ni herramientas queda como aviso en el resumen.

### Variables de entorno

Todas son rutas absolutas. La caché, el buzón, los worktrees y este repositorio deben ser carpetas separadas: ninguna dentro de otra (el script lo comprueba, y la CLI rechaza una caché dentro de un repositorio).

| Variable | Uso |
|---|---|
| `N29_REPO` | Checkout del repositorio del sitio. Cada ejecución crea en él un worktree nuevo. |
| `N29_WORKTREES` | Carpeta de los worktrees del día: `<N29_WORKTREES>/29n-diario-<fecha>`. |
| `N29_CACHE` | Caché de documentos (`docs/`), carpetas de ejecución (`ejecuciones/<fecha>/`) y `launchd.log`. |
| `N29_BUZON` | El buzón manual (abajo). |
| `N29_PRESUPUESTO_USD` | Obligatoria: tope de gasto en dólares de cada pasada de Claude (`--max-budget-usd`). Debe cubrir la pasada entera (ver «Límite de búsquedas web»): un tope que se agota a mitad deja fuentes o partidos sin buscar. |
| `N29_CLAUDE` | El binario de Claude Code (por defecto, `claude` del `PATH`), versión 2.1.321 o posterior. |
| `N29_RAMA_BASE` | Rama de la que sale cada día (por defecto `master`). Hay que subirla antes: se parte de `origin/<rama>`. |
| `N29_REMOTO` | Remoto (por defecto `origin`). |
| `N29_LIMITE_CLAUDE_S` | Opcional: segundos que puede durar cada pasada de Claude (por defecto 10800). Al cumplirse, se corta. |
| `N29_LIMITE_VIDEO_S` | Opcional: segundos por vídeo en `transcribir` (por defecto 18000). Debe superar la suma de los límites internos, 4 h: 30 min por cada llamada a `yt-dlp` (subtítulos y audio) y 3 h de Whisper. Cada binario corre en su propio grupo de procesos, y al vencer cualquier límite muere el grupo entero (también `ffmpeg`). |
| `N29_MODELO_WHISPER` | Opcional: modelo ggml para whisper.cpp. |

`diario.sh` fija `N29_SITIO` al worktree del día; no hace falta definirlo.

### Permisos de Claude

No hay nada que configurar: antes de cada pasada, `diario.sh` genera los ajustes desde [`claude-settings.diario.template.json`](claude-settings.diario.template.json), los subagentes y los prompts desde [08-diario](../agentes/08-diario.md), en una carpeta temporal nueva fuera de la caché, del buzón, de los worktrees y de este repositorio, de solo lectura, y los comprueba por sha256 justo antes de usarlos. Al terminar la pasada la borra; una copia queda en `ejecuciones/<fecha>/claude/` para auditarla, con el nombre de la pasada delante (`busqueda.settings.json`, `busqueda.agentes.json`, `busqueda.prompt.txt`, `busqueda.busquedas-web.txt`, y lo mismo con `clasificacion-<nn>.`, `hechos.` y `adjudicacion-<partido>.`). Las copias son de solo lectura; por eso cada sesión tiene las suyas, y una sesión que se repite en la misma carpeta (un reintento o un día reanudado) conserva las de su intento anterior como `<sesión>.intento-<n>.*`.

Cómo se protege la ejecución:

1. **Nada de lo que lea Claude puede ejecutar código.** La sesión corre con `--restricted` (sin Bash ni otras herramientas que ejecuten código), `--tools Agent,Read,Write,Glob,Grep,WebFetch,WebSearch`, `--permission-mode dontAsk` y `--permission-prompts none` (lo no permitido se deniega sin preguntar), `--strict-mcp-config` (sin servidores MCP), sin ajustes de usuario ni de proyecto, sin hooks, y arranca desde una carpeta vacía en la que no puede escribir.
2. **Cada pasada solo escribe sus respuestas**: la de búsqueda, `busqueda/` y `equidad/`; cada lote de clasificación, sus archivos de `clasificacion/`; la de hechos, `hechos.json`; la de cada partido, solo `adjudicado/<partido>.json` (o su `.error.txt`), siempre en la carpeta de la ejecución. La plantilla no permite ninguna escritura; el generador añade solo las de la pasada, deniega las de la otra y rechaza cualquier regla de escritura o de Bash en la plantilla, y las reglas de denegación cubren `.claude/`, `CLAUDE.md`, `.mcp.json`, `.git/`, `*.ts`, `*.js`, `*.mjs`, `*.cjs`, la caché, este repositorio y la carpeta de ajustes. Tampoco puede leer los ajustes, los registros, `~/.ssh`, `~/.config`, `~/.claude` ni `.env`.
3. **Los archivos de los que depende el script se sellan**: `antes/`, `descubrir.json`, las tareas, la caché y `bloqueados.json` (y antes de la segunda pasada también `busqueda/` y `equidad/`) se resumen por sha256 antes de cada pasada y se comprueban después; si algo cambió, o si tras la primera pasada hay archivos de la segunda, el día falla.
4. **El sitio solo lo escribe el script**, y solo pasa una lista blanca: `partidos/<id>.json`, `perfiles/<id>.json`, `busquedas.json` y `fuentes.json` de `apps/29n/src/data`, modificados o nuevos y JSON válido. En `fuentes.json` solo valen los cambios de la etapa `fuentes-bloqueo` (ver el punto 8), comparados con la copia de `antes/` (`diario.ts alcance-fuentes`): un `bloqueo` nuevo o cambiado de tipo `robots` con `recogida` omitir en un emisor existente, o un emisor nuevo al final con solo `id`, `nombre` (su host), `hosts`, `tipo` medio, `recogida` omitir y `bloqueo`. Un bloqueo nunca se quita solo. Cualquier otro cambio en el worktree (otro archivo, uno borrado, uno que no sea JSON, también entre los ignorados por git) detiene la ejecución antes de instalar nada. El orden es: `ajustar`, lista blanca con los ignorados, `yarn install --immutable`, Prettier, lista blanca otra vez (sin los ignorados, que ya incluyen `node_modules`), tests y build.
5. **Red**: `traer` solo pide https, a hosts con nombre que resuelven a direcciones públicas (nunca IP literales, `localhost`, `.local` ni direcciones privadas, de enlace local, de loopback, de documentación, de pruebas de rendimiento, NAT64 o IPv4 mapeadas a esas), lo comprueba en cada salto de redirección y otra vez **al conectar**: su `fetch` usa `node:https` con un `lookup` propio que descarta las direcciones internas, así que lo que se comprueba es a lo que se conecta. `transcribir` pasa la URL del vídeo por las mismas comprobaciones, más robots.txt y la lista de hosts bloqueados o solo de buzón, antes de llamar a `yt-dlp` (con `--` delante de la URL), y solo admite vídeos https de `rtve.es`, `youtube.com` y `youtu.be`.
6. **Búsquedas bloqueadas para todos**: antes de buscar, el script sondea una vez cada dominio de las búsquedas iguales y marca para los cuatro partidos las consultas cuyo dominio bloquea; nunca se sortea un bloqueo. Detalle en [08](../agentes/08-diario.md#búsquedas-bloqueadas-para-todos).
7. **Sitios que no admiten a los agentes de Claude.** Cada pasada deniega `WebFetch(domain:<host>)` y `WebFetch(domain:*.<host>)` (el host y todos sus subdominios: `www.`, `feeds.`…; según la documentación de permisos de Claude Code, consultada el 13 nov 2026, `domain:x` solo cubre `x` y `domain:*.x` sus subdominios, y una denegación gana a la regla `WebFetch` que permite el resto) para cada emisor de `fuentes.json` con `bloqueo`, para cada robots.txt de ese día que excluye a los agentes de Claude, y siempre para `elpais.com`, `elmundo.es` y `abc.es`, cuyo robots.txt (leído el 13 nov 2026) excluye a Claude-User, ClaudeBot y Claude-SearchBot, aunque el registro no lo diga. Las búsquedas web pueden seguir devolviendo resultados de esos sitios; ningún agente los abre ni la ejecución los trae. `traer` nunca pide nada a un host de un emisor con `bloqueo` ni a los de esa lista fija, venga de un listado, de un resultado de búsqueda o de la lista de enlaces del buzón (`solo-buzon`; los archivos del buzón manual siguen valiendo). Un emisor con `recogida` omitir solo por ámbito (`ine.es`, `ec.europa.eu`…) no se descubre, pero sus páginas se siguen trayendo si llegan por una búsqueda o por el buzón. Las comprobaciones de red del punto 5 van primero, igual que antes.
8. **Fuentes que bloquean.** Al leer robots.txt, `traer` comprueba si prohíbe la raíz a Claude-User o a Claude-SearchBot: cuentan todos los grupos que nombran exactamente a ese agente (sin distinguir mayúsculas, como dice RFC 9309), y `*` solo si ninguno lo nombra; un `User-agent:` vacío no nombra a nadie, y `Disallow: /$` solo cierra la portada. Si es así, no trae nada de ese host y lo anota con la regla (sin caracteres de control ni de HTML, como mucho 300 caracteres). También anota una respuesta antibots: 403 o 429 con la firma de un servicio (DataDome, reto de Cloudflare, Akamai, Imperva) o una página «no eres un robot», con el código y la firma. Todo queda, con la fecha, en `bloqueos-guia.json` de la carpeta de la ejecución. Las etapas siguientes del día leen ese archivo y no piden nada a los hosts cuyo robots.txt excluyó a los agentes de Claude, sin volver a leerlo; un bloqueo antibots de ese día tampoco se reintenta (`bloqueados.json`). El sondeo de las búsquedas iguales marca como bloqueada, para los cuatro partidos y con el motivo, cada consulta que llega a un host que bloquea a la guía. Después de `ajustar`, la etapa `fuentes-bloqueo` escribe los robots.txt nuevos en `fuentes.json` con la forma del sitio (`bloqueo`: `tipo` robots, `evidencia` con la regla y los `Allow` que deja, `consultado`, `robots`, `agentes`; y `recogida` omitir), en el emisor de ese host (el que lo lista tal cual; si no, el del dominio más largo que lo contiene) o, si no hay ninguno, en un emisor nuevo que se llama como el host hasta que una persona le ponga nombre. La web de un partido nunca se escribe sola: su robots.txt se respeta al traer igual que el de cualquier sitio (si excluye a los agentes de Claude, no se trae nada de ella ese día), la misma regla para los cuatro partidos, pero el registro no cambia: el bloqueo va al resumen «para revisar» y una persona decide; la lista blanca rechaza cualquier cambio de su `bloqueo` o su `recogida`. La lista blanca exige además que `fuentes.json` sea exactamente lo que esta etapa escribe a partir de la copia de `antes/` y de `bloqueos-guia.json`. Los bloqueos antibots no se escriben solos (un reto puede deberse solo a la frecuencia de las peticiones): el resumen los lista para revisar, diciendo si es la primera vez. Vuelve a leer el robots.txt de cada bloqueo registrado; si ya no excluye a los agentes de Claude, el resumen lo dice y una persona decide. El resumen y el PR llevan el apartado «Fuentes que bloquean».
9. **Git**: el script empuja con refspec explícito `refs/heads/data/29n-diario-<fecha>`, comprueba el nombre de la rama antes, nunca usa `--force` y crea el PR con `--draft`. Nunca fusiona, despliega ni activa el auto-merge.

### Clasificación por lotes

Antes de clasificar, `tareas-clasificar` aparta las páginas que no son un artículo o documento suelto, con la misma regla para todos los partidos y todos los orígenes, y las anota con el motivo en `clasificar-descartados.json` (`descartados_previos`): portadas, feeds, rutas de índice (etiqueta, categoría, sección, autor, búsqueda, paginación, archivo; solo si esa parte es la última de la ruta o va seguida de una sola) y páginas HTML que no declaran ningún artículo en JSON-LD, tienen cinco o más elementos `<article>` y cuya última parte de la ruta no parece un titular (sin cifras y con menos de cuatro palabras). El 11 de noviembre aparta 13 de las 630 tareas (6 páginas: 5 de etiquetas o secciones de un medio y un listado de notas de prensa).

Las tareas que quedan se ordenan por `doc_id` y partido y se cortan en lotes fijos de 100 (`lotes/clasificar-<nn>.json`): el 11 de noviembre, 617 tareas en 7 lotes. Cada lote es una sesión de Claude propia, con el mismo prompt (`prompt:clasificacion`), los mismos ajustes y su propio límite de gasto. Cada clasificador escribe su respuesta en `clasificacion/<doc>.<partido>.json` con la herramienta Write; la sesión no copia respuestas. La sesión solo tiene permiso de escritura para los archivos de su lote, uno a uno (`Write(<ruta exacta>)`): los subagentes heredan las reglas de permiso y el modo `dontAsk` de la sesión ([subagentes, «Permission modes»](https://code.claude.com/docs/en/sub-agents#permission-modes)), y el sello de la carpeta, que excluye solo esos archivos, comprueba después que nada más cambió. Luego `clasificacion-completa` exige que cada tarea tenga su archivo, JSON válido con su `doc_id` y su partido; lo que falte o no valga se rehace en una sola sesión más (`clasificacion-reintento`), y si sigue faltando, el día falla. Solo entonces se adjudica, sin clasificadores.

### Hechos compartidos y adjudicación

Una sesión, `hechos`, con solo el redactor de hechos compartidos; después una sesión por partido, `adjudicacion-<partido>`, en orden alfabético (frente-amplio, pp, psoe, vox), cada una con solo el adjudicador de ese partido. Las cuatro usan el mismo prompt (`prompt:adjudicacion`, que solo cambia en el id del partido), los mismos subagentes, los mismos criterios y su propio límite de gasto (`N29_PRESUPUESTO_USD`). Cada sesión lanza su subagente en primer plano y no termina hasta que acaba. El subagente escribe su propia respuesta con Write, como los clasificadores, y la sesión solo comprueba que el archivo existe: una respuesta grande vuelve cortada a la sesión (la del adjudicador del PP, el 11 de noviembre, 63 KB) y la sesión no puede guardarla. Antes era una sola sesión con los cinco subagentes: el 11 de noviembre terminó con tres adjudicadores aún en marcha en segundo plano, que se perdieron, y un adjudicador gastó unos 12 de los 30 USD de la sesión. Cada sesión solo puede crear su archivo (`hechos.json` o `adjudicado/<partido>.json`, y su `.error.txt`); el sello comprueba que nada más cambió, tampoco el archivo de otro partido. `hechos-completo` y `adjudicacion-completa --partido` deciden qué hace falta: unos hechos válidos no se rehacen (y si se rehacen, se apartan también todas las adjudicaciones hechas sobre los anteriores, para que los cuatro partidos lean los mismos hechos); un partido completo no se repite; un partido que falte tras su sesión tiene una sesión más, y después `adjudicacion-completa` comprueba los cuatro. Una respuesta anterior que no valía se aparta a `anterior/adjudicacion-<n>/`.

Coste y tiempo estimados para el 11 de noviembre (no medidos: no hubo ejecución real con lotes): cada tarea lee unos 9.400 caracteres de documento y metadatos (unos 1,5 millones de tokens para las 617) más el prompt; por el gasto de Haiku del 11 de noviembre en la búsqueda, unos 3 a 5 USD de clasificadores en total, y de 1 a 3 USD de orquestación en Opus por lote. Con 10 subagentes a la vez, cada lote son 10 tandas, del orden de 10 a 20 minutos; los 7 lotes, de 1,5 a 2,5 horas, cada sesión con su propio límite de `N29_LIMITE_CLAUDE_S`. Las sesiones de hechos y de cada partido (Opus, que leen las clasificaciones de su partido) son las menos predecibles; `N29_PRESUPUESTO_USD=30` vale por sesión.

### Límite de búsquedas web

Claude Code limita las llamadas a WebSearch: 200 por defecto, compartidas por la sesión y todos sus subagentes; con `claude -p` el límite vale para todo el turno, es decir, para la pasada entera, y no se recarga ([Session search limit](https://code.claude.com/docs/en/tools-reference#session-search-limit); variable `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`, [variables de entorno](https://code.claude.com/docs/en/env-vars)). La primera ejecución real (11 de noviembre de 2026) lo agotó con 10 de las 36 fuentes y no llegó a las búsquedas iguales.

Por eso el generador cuenta el peor caso de la pasada de búsqueda (cada consulta de cada fuente más sus dos mitades, como si todas se saturaran, y cada consulta WebSearch no bloqueada de cada búsqueda igual) y escribe en `busquedas-web.txt` el doble (cada subagente puede reintentarse una vez), nunca menos de 200. El archivo se comprueba por sha256 con los demás, y `diario.sh` pasa el valor a Claude como `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`; un valor de tu entorno no lo cambia. Las sesiones de clasificación, hechos y adjudicación no prevén búsquedas y quedan en 200.

Cada tarea de fuente lleva exactamente una consulta por cada uno de los cuatro partidos (si no, la comprobación de la búsqueda falla, y `descubrir` falla si a un partido le faltan sus términos en `partidos-alias.json`): una consulta por partido, `site:<host> ("término 1" OR "término 2" …)`, que construye el código (`consultasFuente` en `src/descubrir.ts`) y el agente ejecuta tal cual. Reglas, iguales para los cuatro partidos:

- **Candidato primero**: cada consulta empieza por el candidato principal del partido, tomado de `tarjeta.candidato` en `apps/29n/src/data/partidos/<id>.json` del worktree del día (no está escrito en el código). Si no es uno de los términos de alias del partido, va primero igualmente (en la consulta, no en la regla de alias). Si un partido no tiene candidato en sus datos, `descubrir` falla con un error que lo dice.
- **Longitud**: como máximo 300 caracteres (`LONGITUD_MAXIMA_CONSULTA`). Tras el candidato, los términos del partido entran en el orden de su lista mientras caben; los demás quedan fuera de la búsqueda web y se anotan en `terminos_omitidos` en `descubrir.json`. Siguen contando para la clasificación: la regla de alias usa todos los términos en cada página traída. El candidato va siempre, aunque no quepa nada más.
- **Saturación**: si una consulta devuelve 10 resultados o más (`RESULTADOS_SATURACION` en `src/diario.ts`), el agente ejecuta también sus dos mitades, calculadas de antemano (la primera con la mitad de los términos redondeada hacia arriba), y las anota en `subconsultas`. La documentación de Claude Code no fija cuántos resultados da una llamada a WebSearch (una llamada puede hacer hasta ocho búsquedas internas), así que 10 es una elección fija, no un máximo de la herramienta.
- **Exclusiones**: las frases `excluir` no van en la consulta; se aplican al texto de cada página traída, como en cualquier otro documento.

Con los datos del 11 de noviembre: 144 consultas de fuentes (36 por partido, una por fuente) y 24 de búsquedas iguales: 168 búsquedas si ninguna consulta se satura, 456 en el peor caso (144 × 3 + 24) y un límite de 912. Antes, con una búsqueda por término, eran 1.536. Los candidatos son Ada Colau, Alberto Núñez Feijóo, Pedro Sánchez y Santiago Abascal, y van primero en todas las consultas de su partido. PP, PSOE y Vox caben enteros. De Frente Amplio entran Ada Colau y sus 9 o 10 primeros términos (de «Frente Amplio» a «IU» o «Movimiento Sumar», según la longitud del host); quedan fuera de la búsqueda web 13 o 14 («Catalunya en Comú», «Más Madrid», …, «Pablo Bustinduy», «Emilio Delgado», «Mónica García», «Ernest Urtasun»), que siguen contando para la clasificación.

El presupuesto debe ir a la par. El 11 de noviembre, 203 búsquedas costaron 2,56 USD en Haiku (unos 0,013 USD cada una) y 1,31 USD de orquestación en Opus para 10 subagentes. Con 168 búsquedas si ninguna se satura y 456 si se saturan todas (más los reintentos), son unos 2 a 6 USD de Haiku y unos 7 USD de orquestación para 52 subagentes. Una consulta agrupada devuelve más resultados que una de un solo término, así que el coste por búsqueda puede subir; `N29_PRESUPUESTO_USD=30` deja margen.

## Buzón manual

Para lo que no se puede traer de forma automática (webs de partido que bloquean a clientes automatizados, PDF repartidos en mano, subtítulos copiados), deja los archivos en:

```text
$N29_BUZON/
  <partido>/<AAAA-MM-DD>/        partido: frente-amplio, pp, psoe o vox; la fecha en que lo guardaste
    nota.html                    página guardada desde el navegador («Guardar como… → Página web, solo HTML»)
    programa.pdf                 un PDF
    programa.url                 obligatorio para cada .pdf y .txt: la URL exacta del documento, en la primera línea
    subtitulos-debate.txt        texto pegado (subtítulos, transcripción); también con su .url
  videos/<AAAA-MM-DD>.txt        vídeos que transcribir ese día, uno por línea: URL_DEL_VÍDEO [URL_DE_LA_TRANSCRIPCIÓN_OFICIAL]
  enlaces/<AAAA-MM-DD>.txt       enlaces que traer ese día, uno por línea: URL [partido]
```

- La URL de un `.html` sale de su `link rel=canonical` u `og:url`; si no tiene, añade un `.url` con el mismo nombre.
- Solo se guarda el texto del artículo: scripts, formularios, metadatos, correos, tokens e identificadores de sesión se eliminan (`src/buzon.ts`). Aun así, guarda las páginas sin haber iniciado sesión en el sitio.
- La ejecución lee la carpeta de su fecha. Un archivo sin URL se rechaza y aparece como aviso en el resumen.
- En `enlaces/<fecha>.txt` va una URL https por línea, y si quieres, tras un espacio, el id de un partido (`frente-amplio`, `pp`, `psoe` o `vox`) como nota; `#` empieza un comentario y las líneas en blanco se ignoran. La ejecución de esa fecha trae cada enlace por el mismo camino que cualquier artículo descubierto (`29n-recogida enlaces`, con las mismas comprobaciones: solo https, dirección pública al conectar, robots.txt, hosts bloqueados y solo de buzón, redirecciones comprobadas, límites de tamaño), sin ventana de fechas. Lo traído pasa por la misma clasificación, la misma adjudicación y las mismas reglas de equidad: los partidos los decide la regla de alias, no la nota, y la fecha del propio artículo sigue contando para el corte. Cada documento lleva `origen: buzon-enlaces` en su `meta.json`, y el resumen (y el PR) lista los enlaces, los partidos que encontró la regla de alias y los elementos añadidos desde cada uno. Una línea no válida o un enlace que no se pudo traer es un aviso en el resumen, nunca un fallo. Un enlace ya guardado en la caché sin cambios un día anterior no es nuevo ese día y no se vuelve a clasificar (aviso). Un enlace que `traer` ya trajo ese mismo día (por un listado o por la búsqueda) sí es nuevo y se clasifica, pero conserva el `meta.json` de esa primera vez, sin `origen: buzon-enlaces`; su origen queda en `enlaces.json` y en el resumen. La nota de partido de cada línea solo se guarda en `enlaces.json`, nunca en `meta.json`, que leen los clasificadores y los adjudicadores. El resumen muestra cada enlace sin parámetros ni fragmento, y los avisos sin el texto de la línea (que queda en `enlaces.json`).
- En `videos/<fecha>.txt`, `#` empieza un comentario. Si hay transcripción oficial, se usa esa; si no, subtítulos con `yt-dlp`; si no hay subtítulos, Whisper local.
- Vídeos y audios admitidos (`FUENTES_VIDEO` en `src/transcripciones.ts`): solo hosts para los que `yt-dlp` tiene un extractor propio, con la forma de URL que ese extractor acepta, y `yt-dlp` solo puede usar ese extractor (`--use-extractors`; nunca el genérico). Hoy: YouTube (`youtube.com/watch`, `youtu.be`), RTVE Play (`rtve.es/play/videos/<programa>/<título>/<id>/`), 3Cat (`3cat.cat/3cat/…/video|audio/<id>/`; subtítulos en catalán o castellano, y Whisper en el idioma que `yt-dlp` lee del vídeo o, si no lo da, el que detecta Whisper) y Atresplayer (`atresplayer.com`). Comprobado con `yt-dlp` 2026.10.26 (`--list-extractors` y el patrón de URL de cada extractor). No hay extractor para Cadena SER (`cadenaser.com`), Onda Cero (`ondacero.es`), esRadio (`esradio.libertaddigital.com`), Mitele (`mitele.es`) ni la antigua `ccma.cat`, y no se encontró un dominio oficial de La Séptima con extractor: esos vídeos no se transcriben (se puede guardar una transcripción a mano en el buzón). Siguen todas las comprobaciones (https, dirección pública al conectar, robots.txt, hosts bloqueados, `--` antes de la URL, sin cookies ni cuenta, grupo de procesos, límites de tiempo, el audio se borra). Si `yt-dlp` dice que hace falta iniciar sesión o una suscripción, que hay un bloqueo geográfico o DRM, queda un aviso y no se intenta nada más (ni el audio).
- RTVE Play: primero los subtítulos de la API de RTVE, sin cargar la página. El id sale de la propia URL; se pide `https://api2.rtve.es/api/videos/<id>/subtitulos.json` y después la pista en español (`lang: es`), las dos por el mismo camino que cualquier petición (https, dirección pública al conectar, redirecciones, tamaño, robots.txt de cada host). Se guarda el texto limpio con la URL de RTVE Play como fuente y la URL de la pista en `meta.json` (`subtitulos_url`), sin calidad primaria (RTVE no dice si la pista se hizo a mano). Si no hay pista en español o alguna comprobación lo impide, queda un aviso, y para RTVE no se prueba nunca `yt-dlp` ni Whisper. A 12 de noviembre de 2026, el robots.txt de `api2.rtve.es` permite solo algunas rutas y deniega el resto (`Disallow: /`), `/api/` incluida, y las pistas se sirven desde `www.rtve.es`: con este robots.txt el camino de la API termina en aviso. No se sortea.

## Instalar el trabajo diario (opcional)

La plantilla no está instalada ahora. Las ejecuciones se inician a mano con `bin/diario.sh --fecha <fecha>`. Antes de instalarla, el trabajo debe definir `TZ=Europe/Madrid` (en `EnvironmentVariables` del plist) para que la fecha sea la de España.

```sh
T="$(cd .. && pwd -P)"     # desde recogida/
mkdir -p ~/Library/LaunchAgents
sed -e "s|__T__|$T|g" \
    -e "s|__N29_REPO__|$N29_REPO|g" -e "s|__N29_WORKTREES__|$N29_WORKTREES|g" \
    -e "s|__N29_CACHE__|$N29_CACHE|g" -e "s|__N29_BUZON__|$N29_BUZON|g" \
    -e "s|__PRESUPUESTO__|$N29_PRESUPUESTO_USD|g" \
    -e "s|__CLAUDE__|$(command -v claude)|g" \
    -e "s|__PATH__|$(dirname "$(command -v claude)"):$(dirname "$(command -v node)"):$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin|g" \
    launchd/dev.29n.diario.plist.template > ~/Library/LaunchAgents/dev.29n.diario.plist
plutil -lint ~/Library/LaunchAgents/dev.29n.diario.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/dev.29n.diario.plist
launchctl print "gui/$(id -u)/dev.29n.diario" | head    # comprobar
```

Para que el Mac esté despierto a las 07:00 (launchd recupera lo que se perdió mientras dormía, no mientras estaba apagado):

```sh
sudo pmset repeat wakeorpoweron MTWRFSU 06:55:00
pmset -g sched
```

Para lanzarlo ahora: `launchctl kickstart "gui/$(id -u)/dev.29n.diario"`. Para quitarlo: `launchctl bootout "gui/$(id -u)/dev.29n.diario"` y `sudo pmset repeat cancel`.

`$HOME/.local/bin` está en el `PATH` para Whisper instalado con `pipx`. launchd no hereda el agente SSH de la terminal: si el remoto usa SSH, guarda la clave en el llavero (`ssh-add --apple-use-keychain`) o usa HTTPS con `gh auth setup-git`.

## Uso

```sh
bin/diario.sh                                  # hoy (la fecha se lee una vez, con date +%F)
bin/diario.sh --fecha 2026-11-12 --sin-git     # todo, Claude incluido, pero sin commit, push ni PR
bin/diario.sh --fecha 2026-11-10 --seco        # ensayo en seco, sin red, sin Claude, sin git
bin/diario.sh --fecha 2026-11-13 \
  --atrasos-desde 2026-10-05 --atrasos-hasta 2026-11-12 \
  --atrasos-emisores la-razon,eldiario-es      # el día, más los atrasos de esas fuentes
```

**Atrasos.** Con las tres opciones `--atrasos-*` (las tres o ninguna), la ejecución normal del día busca además en las fuentes nombradas lo publicado en una ventana anterior. No es [recuperar un día](#recuperar-un-día): no se repite el día entero; solo se añade, en `descubrir`, una tarea de búsqueda más por fuente, construida igual que las del día (`consultasFuente`: el candidato primero, una consulta por partido, las mismas mitades si se satura) pero con su propia ventana (`desde`, `hasta`), la nota fija «Atrasos: devuelve solo lo publicado del <desde> al <hasta>.» y su propia respuesta, `busqueda/<emisor>.atrasos.json`, para no pisar la tarea del día de la misma fuente. El listado normal de esa fuente no cambia, y las búsquedas iguales siguen con la ventana del día. Lo encontrado se trae, se clasifica y se adjudica como todo lo demás; `busqueda-completa` exige también estas respuestas. `descubrir` se niega con un id que no está en `fuentes.json`, con una fuente de `recogida` omitir, con `bloqueo` o solo de buzón, con fechas que no son AAAA-MM-DD, con `desde` posterior a `hasta` o con `hasta` posterior a `--fecha`; `diario.sh` comprueba además la forma de las fechas y de los ids y no las admite con `--reanudar` ni `--sellar` (sí con `--seco`, para ensayarlas: las respuestas de sus tareas salen de `fixtures/diario/juicio-atrasos`, que tiene la de `medio-b`). La línea `atrasos` de `etapas.tsv`, `descubrir.json` (`atrasos`) y el apartado «Atrasos» del resumen dicen qué se pidió.

Solo corre una ejecución a la vez, de cualquier fecha (`$N29_CACHE/ejecuciones/.bloqueo`). Al empezar y al terminar se borra `$N29_CACHE/tmp/tr-*`, para que ningún audio sobreviva a una ejecución.

El resultado de cada día está en `$N29_CACHE/ejecuciones/<fecha>/`: `resumen.md` (el cuerpo del PR, o el fallo), `etapas.tsv`, `diario.log` y las salidas de cada agente (ver [08](../agentes/08-diario.md#carpeta-de-la-ejecución)).

### Si falla

No hay commit. `resumen.md` dice en qué etapa y por qué, con las últimas líneas del registro, y el worktree queda en `$N29_WORKTREES/29n-diario-<fecha>` para revisarlo. Un cambio fuera de la lista blanca detiene la ejecución en el acto, antes de instalar nada. Las demás comprobaciones (citas nuevas no literales, `test`, `build`) se ejecutan todas antes de declarar el fallo, para que el resumen las muestre juntas. Si la adjudicación de un partido falta o está incompleta, si falta una clasificación tras su sesión de reintento, o si un archivo sellado cambió durante una sesión de Claude, no se publica nada ese día para ninguno. Si la búsqueda dejó algo sin hacer (la respuesta de una fuente, una consulta de un partido o una búsqueda igual), se hace **una** sesión más de Claude, `busqueda-reintento`, solo con esas tareas: las mismas definiciones, copiadas tal cual (`reintento-fuentes.json`, `reintento-equidad.json`), el mismo prompt, los mismos subagentes, los mismos permisos y un límite de búsquedas calculado solo para ellas. Las respuestas anteriores de esas tareas se apartan a `reintento-anterior/`, y todo lo demás de la carpeta queda sellado: la sesión solo puede crear las respuestas de las tareas que se reintentan (`reintento-rutas.txt`). Una búsqueda igual se rehace siempre para los cuatro partidos de su tipo a la vez, aunque solo haya fallado uno; la regla es la misma para cualquier partido. Después se vuelve a comprobar; si sigue faltando algo, el día falla antes de la adjudicación y `resumen.md` lista lo reintentado y lo que falta (`busqueda-reintentadas.txt`, `busqueda-faltan.txt`). No se reintenta lo que otra sesión no puede arreglar (una tarea sin sus cuatro consultas, un tipo sin sus cuatro partidos o sin las mismas consultas bloqueadas para los cuatro, más búsquedas declaradas que registradas; las respuestas reintentadas se comparan con lo que registró la sesión de reintento, y las demás con lo de la pasada). Una respuesta guardada como `.error.txt` que es JSON válido con solo espacios alrededor se acepta tal cual (`busqueda-aceptadas.txt`); cualquier otro carácter de más la deja como error.

### Reanudar un día

Un día que se detuvo en la comprobación de la búsqueda (`busqueda-completa`), en la clasificación (`tareas-clasificar`, `clasificacion`) o en la adjudicación (`hechos`, `adjudicacion`, `adjudicacion-completa`) se puede reanudar sin repetir lo anterior: desde `busqueda-completa`, desde `tareas-clasificar` o desde `hechos`, respectivamente. Desde `hechos` no se repite la clasificación, y se conservan los hechos y las adjudicaciones de partido que ya estén completos. Un día que se detuvo en la preparación, la fusión o el ajuste (`preparar`, `fusionar`, `ajustar`) o en las comprobaciones del sitio (`comprobaciones`: citas, `test` o `build`) se reanuda desde `preparar`, con la adjudicación guardada, sin repetir nada de Claude: el script lleva el worktree a la `origin/<rama base>` de ahora (etapa `reponer`), para que entren los arreglos del sitio publicados desde entonces, y vuelve a fusionar. La lista blanca y git no se reanudan.

Al fallar en una de esas etapas, el script escribe `reanudar.sello` (sha256 de cada archivo de la carpeta de la ejecución, salvo el registro, la tabla de etapas y los resúmenes; de cada documento de la caché; y de `bloqueados.json`) y pone su sha256 en `resumen.md` y en el registro, con la orden exacta. No lo hace si la búsqueda ya empezó su sesión de reintento o si sus faltas no las puede arreglar otra sesión. Para un día anterior a este cambio, sin sello, se crea a mano tras revisar la carpeta:

```sh
bin/diario.sh --fecha 2026-11-11 --sellar                 # escribe el sello e imprime su sha256
bin/diario.sh --fecha 2026-11-11 --reanudar <sha256>      # comprueba y reanuda
```

`--reanudar` solo empieza si: la última etapa de `etapas.tsv` es una de las de arriba, con fallo; el sha256 de `reanudar.sello` es el que se da y el sello coincide con la carpeta, la caché y `bloqueados.json` de ahora (si otro día corrió entre medias y cambió la caché, no se reanuda); para la búsqueda, no empezó su sesión de reintento (`busqueda-reintento.iniciado`) ni hay archivos de etapas posteriores; para la clasificación y la adjudicación, `traer-busqueda` terminó y no hay archivos de la preparación ni de la fusión, y para la adjudicación, además, la última clasificación terminó bien; el worktree existe, pertenece a `N29_REPO`, está en la rama del día, sin cambios ni archivos sin seguir (también ignorados; desde `preparar`, ver más abajo), y su HEAD es la base del día (`base.sha`, escrito al crear el worktree; en ejecuciones anteriores a este cambio, el HEAD), que está en `origin/<rama base>`; y la rama no existe en el remoto. Desde `tareas-clasificar`, una adjudicación anterior se aparta entera a `anterior/adjudicacion-<n>/`; desde `hechos`, solo lo que no está completo; los lotes de clasificación ya completos no se repiten, y la clasificación tiene una sola sesión de reintento por día. Desde `preparar`, la última `adjudicacion-completa` de la tabla de etapas tiene que haber terminado bien, y la etapa `reponer` solo mueve el worktree si está en la rama `data/29n-diario-<fecha>`, sin commits (su HEAD y la rama son la base del día) y con cambios que solo pueden ser de la fusión (la misma lista blanca, sin contar los archivos ignorados), y si `origin/<rama base>` desciende de la base del día sin cambiar los datos que leyó la ejecución (`partidos/`, `perfiles/`, `busquedas.json`, `fuentes.json` y `partidos-alias.json`; si cambiaron, la adjudicación guardada no vale y hay que repetir el día entero). Entonces hace `git reset --hard` a `origin/<rama base>` y `git clean -ffdx` (también `node_modules` y lo construido, que la instalación y el build vuelven a crear), comprueba que queda limpio y aparta la fusión anterior de la carpeta de la ejecución (`fusion/`, `preparar.json`, `fusionar.json`, `ajustar.json` y los informes de citas) a `anterior/fusion-<n>/`. Si la base cambió, la nueva queda en `base.sha`, la anterior en `bases-anteriores.txt` y el cambio en la tabla de etapas (línea `base`), y con ella en el resumen y el PR. Si hay cualquier otro cambio, o si no se cumple alguna condición, no borra nada y el día falla en `reponer`. Un fallo en las comprobaciones queda también en la tabla de etapas (`comprobaciones`). La tabla de etapas, y con ella el PR, anota la reanudación y el sha256 del sello. No vale con `--seco`.

Un día que falló en las comprobaciones antes de este cambio no tiene la línea `comprobaciones` en `etapas.tsv` ni sello. Se prepara a mano una vez, tras revisar la carpeta: si queda un `reanudar.sello` de una reanudación anterior, se renombra (por ejemplo a `reanudar.sello.<8 primeros caracteres de su sha256>`); se añade al final de `etapas.tsv` la línea `comprobaciones<TAB>fallo<TAB>alguna comprobación falló`; y después `--sellar` y `--reanudar` como arriba.

### Recuperar un día

Siempre por fecha, nunca por reloj. Si una ejecución anterior de ese día dejó restos, bórralos a mano antes (el script se niega a empezar si existen):

```sh
git -C "$N29_REPO" worktree remove --force "$N29_WORKTREES/29n-diario-2026-11-12"   # si quedó el worktree
git -C "$N29_REPO" branch -D data/29n-diario-2026-11-12                              # si quedó la rama local
git -C "$N29_REPO" push origin --delete data/29n-diario-2026-11-12                   # si quedó la rama remota (cierra antes su PR)
bin/diario.sh --fecha 2026-11-12
```

El script comprueba con `git ls-remote` que la rama remota no existe antes de crear nada. La carpeta de ejecución anterior de ese día se conserva renombrada (`<fecha>.intento-1`, …). La ventana de `descubrir` es la fecha y los dos días anteriores; los feeds y sitemaps solo muestran lo reciente, así que conviene recuperar pronto. Una fecha futura se rechaza.

Si un día no tiene cambios en los datos, el script borra el worktree y la rama local, pero solo si la rama sigue apuntando a la base de la que salió.

### Ensayo en seco

`--seco` copia `fixtures/diario` a una carpeta temporal (o a `--salida`, que debe estar vacía) y ejecuta las etapas deterministas sobre ella: la CLI con una red fija (`fixtures/diario/red-fija.mjs`: solo responde a las URL de `red/rutas.json`, contesta al DNS con una dirección pública fija sin consultar a nadie y no contacta con ningún host), el sondeo de los dominios de las búsquedas iguales (con un dominio de ejemplo que responde 403, para que se vea la regla de bloqueadas para todos), la generación y comprobación de los ajustes de Claude de las dos pasadas (sin ejecutarlo), la lista blanca (comparando con el sitio de ejemplo), las salidas de los agentes de `fixtures/diario/juicio` en lugar de Claude, `preparar`, `fusionar`, `ajustar`, citas y resumen. No ejecuta Claude, Prettier, los tests ni el build del sitio, ni git. Al final sustituye la ruta temporal por `<RAIZ>` y escribe `huella.txt` (un sha256 por archivo). Dos ensayos con la misma fecha deben dar la misma huella:

```sh
bin/diario.sh --fecha 2026-11-10 --seco --salida /tmp/29n-a
bin/diario.sh --fecha 2026-11-10 --seco --salida /tmp/29n-b
diff -r /tmp/29n-a /tmp/29n-b && echo iguales
```
