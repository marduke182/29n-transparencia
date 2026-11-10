# Criterio de equidad entre fichas

Reglas que se aplican a las cinco fichas de partido por igual desde el 10 nov 2026. Cada regla indica si el sitio la comprueba al publicar (la publicación se detiene) o si es una regla editorial que se aplica al preparar los datos. Solo están las reglas y los esquemas, no los datos. El resumen de los cambios, por fecha, está en [CAMBIOS](../CAMBIOS.md). Si algo de aquí difiere del código del sitio, manda el código.

## Estado estricto

- Lo que solo se conoce por el relato de la prensa es `PARCIAL` y su matiz empieza con «Según el relato de X; no se ha consultado…».
- `VERIFICADO` necesita al menos una fuente primaria. Es primaria la fuente que cumple una de estas condiciones:
  - Su emisor es de tipo `oficial`, `partido` o `datos` en el registro de fuentes.
  - Está marcada `primaria: true` (una transcripción completa o un vídeo alojado en un medio). Un extracto no basta.
  - Está en la sección de verificación y su emisor es un verificador: su página es el registro primario de su propio veredicto.
- El sitio comprueba esta regla: un `VERIFICADO` sin fuente primaria detiene la publicación.
- Estados admitidos: `VERIFICADO`, `CORREGIDO` y `PARCIAL` (este último, con `matiz` obligatorio). Ver [verificación](verificacion.md).

## Hechos compartidos

Un hecho compartido es el que aparece en más de una ficha: encuestas, votaciones, debates, decretos.

- Se marca con la misma clave `hecho` en todos los elementos que lo recogen.
- El sitio comprueba que los elementos con la misma clave tengan el mismo `texto`, `estado`, conjunto de URL de fuentes (sin importar el orden ni las repeticiones), `matiz`, `cita` y `atribucion`.
- El sitio comprueba que un mismo `texto` en varias fichas lleve una clave `hecho` común.
- Encuestas: cada clave `hecho` de la sección de encuestas aparece en las cinco fichas.
- Votaciones: cada clave `hecho` que empieza por `votacion-` aparece en las cinco fichas, en cualquier sección.
- Línea propia de un partido en las encuestas (un elemento de encuestas sin `hecho`): la misma `ref` en las cinco fichas, o en ninguna.
- En los tres casos, si falta en alguna ficha la publicación se detiene. Una verificación compartida por dos partidos queda fuera de estas reglas.
- La línea del CIS de cada partido es una frase de plantilla, una por partido, tomada del PDF del CIS. El texto de la plantilla es una regla editorial; el sitio comprueba que esté en las cinco fichas.
- El sitio comprueba también que la fecha de corte sea la misma en las cinco fichas.
- Regla editorial: las líneas propias de un partido en otras secciones siguen la misma norma (una por partido con la misma plantilla, o ninguna).

## Críticos y defensores

- Cada ficha tiene el mismo número N de críticos y el mismo número N de defensores. Hoy N = 1.
- N sale de una búsqueda igual para los cinco: es el máximo que todos los partidos alcanzan con fuentes válidas.
- Solo cuentan personas u organizaciones con nombre. Los análisis y las columnas de opinión de un medio no cuentan.
- Un defensor puede ser un político con nombre de un partido que concurre en una candidatura conjunta con el partido en cuestión. La regla es la misma para los cinco; por ejemplo, IU para el Frente Amplio y ERC para Podemos. Es una regla editorial.
- Una cita que defiende la candidatura conjunta («el frente») cuenta como defensa del partido.
- Decisión del responsable del sitio, 10 nov 2026: revisó el caso de Gabriel Rufián (ERC) como defensor de Podemos y lo mantuvo con esta regla.
- Los elementos válidos que superan N se guardan en `en_espera`, con la sección a la que irán. Pasan a publicarse cuando los cinco partidos alcanzan N+1. En el registro de búsquedas, un hallazgo en espera lleva la disposición `en_espera: <ref>`.
- El sitio comprueba que el número de críticos y el de defensores sea igual en las cinco fichas. La regla de N+1 y la de personas con nombre son editoriales.

## Búsqueda igual

Las verificaciones de bulos, las causas judiciales, los críticos y los defensores salen de la misma búsqueda para los cinco partidos. Cambia el nombre del partido y, en críticos y defensores, el apellido de su candidato principal. Todos los partidos llevan un término de la misma forma.

### Registro de búsquedas

El registro es `busquedas.json` en el sitio. Cada búsqueda (`busquedas[]`) tiene:

| Campo | Contenido |
|---|---|
| `id` | Identificador en minúsculas con guiones. Único. |
| `tipo` | `criticos`, `defensores`, `bulos` o `causas`. |
| `fecha` | Fecha de la búsqueda (ISO). |
| `periodo` | `desde` y `hasta` (ISO, `desde` no posterior a `hasta`): ventana de publicación buscada. |
| `sustituida_por` | Opcional. `id` de la búsqueda actual del mismo tipo que repite esta con las consultas corregidas. La sustituida se conserva solo como registro. |
| `consultas[]` | `plantilla` con `{partido}` y, si hace falta, `{termino}`; `motor` (herramienta); `dominios` (lista de hosts, vacía si no hay filtro); `terminos` (valor de `{termino}` por partido, obligatorio si la plantilla lo usa). |
| `resultados` | Número de hallazgos por partido antes de seleccionar, para los cinco. |
| `hallazgos` | En los cuatro tipos, obligatorio salvo en una búsqueda sustituida: por partido, una lista con una disposición por hallazgo (ver más abajo). |
| `nota`, `notas` | Límites de la búsqueda (dominios que devolvieron error, páginas ilegibles), general o por partido. |

Reglas que comprueba el sitio:

- Los cinco partidos tienen un recuento de resultados (entero, 0 o más).
- Las plantillas llevan `{partido}` o `{termino}`; `terminos` solo existe si la plantilla usa `{termino}`.
- Un término vacío para un partido mientras los demás tienen uno se rechaza (consulta de forma desigual). No se aplica a las búsquedas sustituidas.
- `periodo.hasta` no es posterior a `fecha`.
- `sustituida_por` nombra una búsqueda actual del mismo tipo.
- Los elementos publicados o en espera no pueden apuntar a una búsqueda sustituida.
- Cada elemento de bulos y de críticos y defensores (publicado o en espera) indica la búsqueda que lo encontró (`busqueda`), y esa búsqueda existe en el registro, no está sustituida y es del tipo que corresponde (`bulos`, `criticos`, `defensores`, y `causas` para los elementos de historial).

### Disposición de los hallazgos

En los cuatro tipos de búsqueda (`criticos`, `defensores`, `bulos`, `causas`), cada partido tiene en `hallazgos` una lista con un registro por hallazgo: la `url` (https, sin repetirse) y exactamente una disposición.

- `publicado`: la `ref` del elemento publicado, o una lista de `ref` si el hallazgo da lugar a varios.
- `en_espera`: la `ref` de un elemento válido guardado en `en_espera` (un extra por encima de N).
- `descartado`: el motivo del descarte.

El sitio comprueba, para las búsquedas actuales, que:

- el número de disposiciones de cada partido sea igual a su recuento en `resultados`;
- cada hallazgo tenga una sola de las tres disposiciones;
- cada `ref` publicada o en espera exista (en la ficha o en `en_espera` de ese partido, según el caso), lleve el `id` de esa búsqueda en `busqueda` y cite la URL del hallazgo entre sus fuentes;
- todo elemento publicado o en espera que lleve el `id` de la búsqueda figure en su lista;
- `hallazgos` tenga la forma descrita en las búsquedas que no están sustituidas.

Todo hallazgo válido se publica o queda en espera; no se recorta el número de elementos.

### Búsqueda repetida

Cuando una búsqueda no usó consultas de la misma forma para los cinco partidos, se repite y la anterior se conserva marcada con `sustituida_por`. En críticos y defensores, la repetición usa el nombre del partido más el apellido de su candidato principal, con un término de la misma forma para los cinco.

## Etiquetas de los verificadores

- Los elementos de verificaciones de bulos son `VERIFICADO`, porque la página del verificador es el registro primario de su propio veredicto. El sitio rechaza un elemento de bulo con otro estado.
- Si el `matiz` de un elemento de bulo declara la etiqueta del verificador con la forma «<Verificador> lo califica de «<Etiqueta>».», el elemento lleva el veredicto que corresponde a esa etiqueta según una tabla única para los cinco partidos (`VEREDICTO_POR_ETIQUETA` en el código). Una etiqueta sin correspondencia o un veredicto distinto detiene la publicación.
- La tabla tiene dos reglas generales: una etiqueta de contexto sin calificación verdadero/falso se corresponde con Matizable, y una alerta de contenido engañoso con Engañoso.
- Antes de usar una etiqueta nueva en un matiz hay que añadirla a la tabla.

## Ausencias

Una afirmación de ausencia («no ha publicado programa», «sus notas no mencionan X») solo se hace con una fuente fechada que lo diga. Comprobar nosotros una portada o una herramienta en vivo no basta. Es una regla editorial.

## Procedencia de las fuentes

Cada fuente de un elemento puede llevar tres campos opcionales. El sitio comprueba su forma:

- `consultado`: fecha ISO en que se leyó la fuente.
- `via`: cómo se leyó. Uno de `web`, `rss`, `api`, `buzon`, `transcripcion`.
- `primaria`: solo puede valer `true`. Marca una fuente primaria alojada en un medio (ver estado estricto).

## Fechas

Las fechas de los datos (`corte`, `consultado`, `fecha` y `periodo` de las búsquedas, fechas de los perfiles) se escriben en formato ISO estricto, `AAAA-MM-DD`, y tienen que ser un día real del calendario: `2026-02-30` y `2026-13-01` se rechazan. El sitio lo comprueba.

## Encuestas nuevas

Desde el 24 de noviembre de 2026 no se añaden encuestas nuevas, porque la ley prohíbe publicarlas en los cinco días anteriores a la votación (LOREG, art. 69.7).

## Actualización diaria

Una recogida diaria abre un borrador para revisión humana y no se publica nada de forma automática. Ver [agentes/08-diario.md](../agentes/08-diario.md).

## Límites abiertos

- Se publica con esta cobertura. No se han podido recoger las páginas de archivo de PSOE de octubre (páginas 2 a 4) ni las de noviembre.
- Vox: la URL de un documento está pendiente.
- Fichas y perfiles muestran estos límites; ver [perfiles](perfiles.md).
