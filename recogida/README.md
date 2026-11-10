# Recogida diaria

Herramientas de la actualización diaria de [29n.jrquintana.dev](https://29n.jrquintana.dev). Cada mañana, [`bin/diario.sh`](bin/diario.sh) recoge lo publicado, deja que los agentes de [08-diario](../agentes/08-diario.md) busquen, clasifiquen y propongan, fusiona las propuestas con código determinista, pasa las comprobaciones del sitio y abre un **PR en borrador** para que el autor lo revise. Nunca fusiona, despliega, activa el auto-merge ni sube nada a `master`: solo empuja su propia rama `data/29n-diario-<fecha>`.

| Archivo | Qué es |
|---|---|
| [`bin/29n-recogida.ts`](bin/29n-recogida.ts) | La CLI: `descubrir`, `traer`, `buzon`, `transcribir`, `binarios`, `fusionar`. |
| [`bin/diario.sh`](bin/diario.sh) | La ejecución diaria completa (etapas 1 a 7 de [08](../agentes/08-diario.md#etapas)). |
| [`src/diario.ts`](src/diario.ts) | El código determinista entre etapas: tareas de búsqueda igual, candidatos de búsqueda, tareas de clasificación, comprobación de la adjudicación, preparación de la fusión, ajuste de N y de la fecha de corte, informe, y los ajustes, subagentes y prompts de Claude. |
| [`src/citas.ts`](src/citas.ts), [`src/resumen.ts`](src/resumen.ts) | Comprobación de citas literales contra la caché y resumen del día. |
| [`claude-settings.diario.template.json`](claude-settings.diario.template.json) | Plantilla de los permisos de la sesión de Claude sin cabeza; `diario.sh` la rellena en cada pasada. |
| [`launchd/dev.29n.diario.plist.template`](launchd/dev.29n.diario.plist.template) | El trabajo de launchd, cada día a las 07:00. |
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
| `N29_PRESUPUESTO_USD` | Obligatoria: tope de gasto en dólares de cada pasada de Claude (`--max-budget-usd`). |
| `N29_CLAUDE` | El binario de Claude Code (por defecto, `claude` del `PATH`), versión 2.1.321 o posterior. |
| `N29_RAMA_BASE` | Rama de la que sale cada día (por defecto `feature/29n-fuentes`; `master` cuando esa se fusione). Hay que subirla antes: se parte de `origin/<rama>`. |
| `N29_REMOTO` | Remoto (por defecto `origin`). |
| `N29_LIMITE_CLAUDE_S` | Opcional: segundos que puede durar cada pasada de Claude (por defecto 10800). Al cumplirse, se corta. |
| `N29_LIMITE_VIDEO_S` | Opcional: segundos por vídeo en `transcribir` (por defecto 18000). Debe superar la suma de los límites internos, 4 h: 30 min por cada llamada a `yt-dlp` (subtítulos y audio) y 3 h de Whisper. Cada binario corre en su propio grupo de procesos, y al vencer cualquier límite muere el grupo entero (también `ffmpeg`). |
| `N29_MODELO_WHISPER` | Opcional: modelo ggml para whisper.cpp. |

`diario.sh` fija `N29_SITIO` al worktree del día; no hace falta definirlo.

### Permisos de Claude

No hay nada que configurar: antes de cada pasada, `diario.sh` genera los ajustes desde [`claude-settings.diario.template.json`](claude-settings.diario.template.json), los subagentes y los prompts desde [08-diario](../agentes/08-diario.md), en una carpeta temporal nueva fuera de la caché, del buzón, de los worktrees y de este repositorio, de solo lectura, y los comprueba por sha256 justo antes de usarlos. Al terminar la pasada la borra; una copia queda en `ejecuciones/<fecha>/claude/` para auditarla.

Cómo se protege la ejecución:

1. **Nada de lo que lea Claude puede ejecutar código.** La sesión corre con `--restricted` (sin Bash ni otras herramientas que ejecuten código), `--tools Agent,Read,Write,Glob,Grep,WebFetch,WebSearch`, `--permission-mode dontAsk` y `--permission-prompts none` (lo no permitido se deniega sin preguntar), `--strict-mcp-config` (sin servidores MCP), sin ajustes de usuario ni de proyecto, sin hooks, y arranca desde una carpeta vacía en la que no puede escribir.
2. **Cada pasada solo escribe sus respuestas**: la de búsqueda, `busqueda/` y `equidad/`; la de adjudicación, `clasificacion/`, `adjudicado/` y `hechos.json`, siempre en la carpeta de la ejecución. La plantilla no permite ninguna escritura; el generador añade solo las de la pasada, deniega las de la otra y rechaza cualquier regla de escritura o de Bash en la plantilla, y las reglas de denegación cubren `.claude/`, `CLAUDE.md`, `.mcp.json`, `.git/`, `*.ts`, `*.js`, `*.mjs`, `*.cjs`, la caché, este repositorio y la carpeta de ajustes. Tampoco puede leer los ajustes, los registros, `~/.ssh`, `~/.config`, `~/.claude` ni `.env`.
3. **Los archivos de los que depende el script se sellan**: `antes/`, `descubrir.json`, las tareas, la caché y `bloqueados.json` (y antes de la segunda pasada también `busqueda/` y `equidad/`) se resumen por sha256 antes de cada pasada y se comprueban después; si algo cambió, o si tras la primera pasada hay archivos de la segunda, el día falla.
4. **El sitio solo lo escribe el script**, y solo pasa una lista blanca: `partidos/<id>.json`, `perfiles/<id>.json` y `busquedas.json` de `apps/29n/src/data`, modificados o nuevos y JSON válido. Cualquier otro cambio en el worktree (otro archivo, uno borrado, uno que no sea JSON, también entre los ignorados por git) detiene la ejecución antes de instalar nada. El orden es: `ajustar`, lista blanca con los ignorados, `yarn install --immutable`, Prettier, lista blanca otra vez (sin los ignorados, que ya incluyen `node_modules`), tests y build.
5. **Red**: `traer` solo pide https, a hosts con nombre que resuelven a direcciones públicas (nunca IP literales, `localhost`, `.local` ni direcciones privadas, de enlace local, de loopback, de documentación, de pruebas de rendimiento, NAT64 o IPv4 mapeadas a esas), lo comprueba en cada salto de redirección y otra vez **al conectar**: su `fetch` usa `node:https` con un `lookup` propio que descarta las direcciones internas, así que lo que se comprueba es a lo que se conecta. `transcribir` pasa la URL del vídeo por las mismas comprobaciones, más robots.txt y la lista de hosts bloqueados o solo de buzón, antes de llamar a `yt-dlp` (con `--` delante de la URL), y solo admite vídeos https de `rtve.es`, `youtube.com` y `youtu.be`.
6. **Búsquedas bloqueadas para todos**: antes de buscar, el script sondea una vez cada dominio de las búsquedas iguales y marca para los cinco partidos las consultas cuyo dominio bloquea; nunca se sortea un bloqueo. Detalle en [08](../agentes/08-diario.md#búsquedas-bloqueadas-para-todos).
7. **Git**: el script empuja con refspec explícito `refs/heads/data/29n-diario-<fecha>`, comprueba el nombre de la rama antes, nunca usa `--force` y crea el PR con `--draft`. Nunca fusiona, despliega ni activa el auto-merge.

## Buzón manual

Para lo que no se puede traer de forma automática (webs de partido que bloquean a clientes automatizados, PDF repartidos en mano, subtítulos copiados), deja los archivos en:

```text
$N29_BUZON/
  <partido>/<AAAA-MM-DD>/        partido: frente-amplio, podemos, pp, psoe o vox; la fecha en que lo guardaste
    nota.html                    página guardada desde el navegador («Guardar como… → Página web, solo HTML»)
    programa.pdf                 un PDF
    programa.url                 obligatorio para cada .pdf y .txt: la URL exacta del documento, en la primera línea
    subtitulos-debate.txt        texto pegado (subtítulos, transcripción); también con su .url
  videos/<AAAA-MM-DD>.txt        vídeos que transcribir ese día, uno por línea: URL_DEL_VÍDEO [URL_DE_LA_TRANSCRIPCIÓN_OFICIAL]
```

- La URL de un `.html` sale de su `link rel=canonical` u `og:url`; si no tiene, añade un `.url` con el mismo nombre.
- Solo se guarda el texto del artículo: scripts, formularios, metadatos, correos, tokens e identificadores de sesión se eliminan (`src/buzon.ts`). Aun así, guarda las páginas sin haber iniciado sesión en el sitio.
- La ejecución lee la carpeta de su fecha. Un archivo sin URL se rechaza y aparece como aviso en el resumen.
- En `videos/<fecha>.txt`, `#` empieza un comentario. Si hay transcripción oficial, se usa esa; si no, subtítulos con `yt-dlp`; si no hay subtítulos, Whisper local.

## Instalar el trabajo diario

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
```

Solo corre una ejecución a la vez, de cualquier fecha (`$N29_CACHE/ejecuciones/.bloqueo`). Al empezar y al terminar se borra `$N29_CACHE/tmp/tr-*`, para que ningún audio sobreviva a una ejecución.

El resultado de cada día está en `$N29_CACHE/ejecuciones/<fecha>/`: `resumen.md` (el cuerpo del PR, o el fallo), `etapas.tsv`, `diario.log` y las salidas de cada agente (ver [08](../agentes/08-diario.md#carpeta-de-la-ejecución)).

### Si falla

No hay commit. `resumen.md` dice en qué etapa y por qué, con las últimas líneas del registro, y el worktree queda en `$N29_WORKTREES/29n-diario-<fecha>` para revisarlo. Un cambio fuera de la lista blanca detiene la ejecución en el acto, antes de instalar nada. Las demás comprobaciones (citas nuevas no literales, `test`, `build`) se ejecutan todas antes de declarar el fallo, para que el resumen las muestre juntas. Si la adjudicación de un partido falta o está incompleta, o si un archivo sellado cambió durante una pasada de Claude, no se publica nada ese día para ninguno.

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
