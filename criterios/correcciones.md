# Criterio común para corregir las fichas de partido (igual para los cinco)

> Texto literal del criterio que leyeron los cinco agentes Opus del workflow [07](../agentes/07-correcciones-por-partido.md) el 10 nov 2026. Solo se han sustituido las rutas locales por `<REPO_SITIO>` y `<DATOS>`. El paso 4 menciona los tests del repositorio del sitio; los validadores equivalentes están en [`../procesado/`](../procesado/).

Datos: `apps/29n/src/data/partidos/<id>.json` (en `<REPO_SITIO>`). Reverificación Haiku de cada contenido publicado: `<DATOS>/reverificacion-publicados.json` (salida del workflow [06](../agentes/06-reverificar-publicados.md)) (campo `partido`, `path` = ruta JSON dentro del archivo, `fuentes[]` con url_actual/url_canonica/es_articulo/respalda/nota, `estado_recomendado`, `neutralidad[]`, `atribucion_falta`, `cita_ok`, `redaccion_propuesta`, `motivo`). Las propuestas Haiku son indicios, no órdenes: a veces son demasiado estrictas o erróneas.

Reglas del sitio (no negociables): publicar solo VERIFICADO / CORREGIDO (redacción corregida) / PARCIAL (con su `matiz`); nunca NO VERIFICABLE ni FALSO (van a `descartados` con `estado` y `motivo`); cada afirmación enlaza al artículo/documento concreto (nunca portada, índice de sección, enlace corto ni página en vivo que cambie); excepción: el lema y frases del propio partido pueden enlazar la portada de su web oficial; citas literales y de menos de 15 palabras; la interpretación de un medio se atribuye al medio («según X»); sin adjetivos ni adverbios valorativos; mismo tratamiento y extensión para los cinco partidos.

Reglas de coherencia añadidas tras la revisión (aplican a los cinco por igual):
- Estado: si el `matiz` enumera partes no comprobadas, el estado es PARCIAL, nunca VERIFICADO. VERIFICADO solo sin partes pendientes.
- Titulares: una frase que solo aparece en el titular es redacción del medio; se atribuye al medio («titula X») y no se presenta como cita del partido. Lo mismo para estilo indirecto: sin comillas si la fuente no las pone.
- Traducciones: las ediciones traducidas (es.ara.cat con «Traducción no verificada», ediciones en inglés de Demócrata u Orain) se sustituyen por el original o por una fuente de agencia; si no hay alternativa, matiz «traducción del propio medio» en todos los casos, no solo en uno.
- Ausencias («no ha publicado programa», «sus notas no mencionan X»): solo con una fuente fechada que lo diga; nunca a partir de comprobar nosotros una portada o una herramienta en vivo.
- Webs de partido bloqueadas: no se elimina contenido solo porque la web bloquee bots; se busca la misma información en medios o agencias fechados y se cita ahí; si no existe, a descartados con motivo. Las notas de proceso («la web rechaza el acceso automatizado») no van en ítems ni pendientes: ya lo dice la línea de acceso común de la ficha.
- Cifras de asistencia u otras del propio partido: «según el partido».
- Hechos compartidos entre fichas (p. ej. debates): misma redacción y atribución en todas.
- Refs de descartados parciales: formato `<ref>-parcial` con motivo que diga qué parte se descarta.

Pasos para tu partido:
1. Seguro (aplicar siempre): sustituir cada url por su `url_canonica` cuando sea el mismo artículo (sigue redirecciones; compruébalo si dudas). Pasar a `descartados` (estado NO VERIFICABLE o FALSO, motivo breve) los ítems con estado_recomendado FALSO o NO_VERIFICABLE, salvo que encuentres y abras una fuente fechada concreta que lo respalde (entonces corrige y cita esa). Sustituir fuentes que son páginas en vivo (herramientas de encuestas/programas, directos) por un artículo fechado que diga lo mismo; si no existe, el ítem va a descartados.
2. Juicio (Opus): para cada ítem PARCIAL o CORREGIDO, abre las fuentes si hace falta y decide: mantener tal cual (si la objeción no se sostiene — anótalo), corregir redacción (mínima, fiel a la fuente, sin información nueva), añadir/ajustar `matiz` y estado PARCIAL, o añadir atribución. Aplica las objeciones de neutralidad solo si son reales. Corrige citas no literales con el texto exacto de la página (<15 palabras) o elimina la cita.
3. No añadas ítems nuevos ni cambies el esquema. Mantén `ref`.
4. Comprueba con `corepack yarn workspace 29n vitest run src/lib/partidos.test.ts src/lib/validate.test.ts` (si el nombre difiere, el test que valida las fichas). NO ejecutes build (otros agentes trabajan en paralelo en otras fichas).
5. Devuelve un registro: por ítem (ref/path) qué hiciste y por qué, URLs cambiadas, ítems descartados, objeciones rechazadas. Y un resumen numérico.

## Decisiones tras la revisión de equidad (10 nov 2026)

Se aplican a los cinco partidos por igual. El detalle de cada regla y de lo que comprueba el sitio al publicar está en [equidad](equidad.md) y en [perfiles](perfiles.md). Los cambios, por fecha, en [CAMBIOS](../CAMBIOS.md).

- **Estado estricto.** Lo que solo se conoce por el relato de la prensa (mitin, entrevista o declaración sin transcripción, vídeo o documento original consultado) es `PARCIAL`, con el matiz «Según el relato de X; no se ha consultado…». `VERIFICADO` exige una fuente primaria: un emisor oficial, un partido o un emisor de datos; una transcripción completa (un extracto no basta); o, en la sección de verificación, el veredicto del propio verificador. `CORREGIDO` sigue significando «redacción corregida»; si además depende solo de prensa, lleva el matiz y pasa a `PARCIAL`.
- **Hechos compartidos** (encuestas, votaciones, debates, decretos): misma redacción, mismas fuentes y mismo estado en las fichas que los incluyen. Lo propio de cada partido va en una línea aparte, una por partido con la misma plantilla o ninguna.
- **Críticos y defensores**: el mismo número N de cada postura por partido, a partir de una búsqueda igual. Los elementos que superan N quedan en espera (`en_espera`).
- **Verificaciones de bulos y causas judiciales**: la misma búsqueda para los cinco, anotada en el registro de búsquedas.
- **Ausencias**: solo con una fuente fechada que lo diga (regla ya recogida arriba).
- **Procedencia de las fuentes**: los campos `consultado`, `via` y `primaria` (ver [equidad](equidad.md#procedencia-de-las-fuentes)).

