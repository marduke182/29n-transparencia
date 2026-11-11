# 29n-transparencia

Todas las herramientas con las que se recogen, verifican y procesan los datos de [29n.jrquintana.dev](https://29n.jrquintana.dev), la guía neutral de las elecciones generales del 29 de noviembre de 2026 en España.

El objetivo es que **cualquiera pueda auditar cómo se obtienen y analizan los datos**: qué se pidió exactamente a cada agente de IA, con qué criterio se decidió, y qué código calcula lo que se muestra. Un sesgo que se puede ver se puede señalar y corregir.

## Qué hay aquí

| Carpeta | Contenido |
|---|---|
| [`agentes/`](agentes/) | Un documento por workflow de agentes, con fecha, modelo, número de agentes, propósito, el **prompt literal** y el esquema de salida. Los scripts originales están en [`agentes/workflows/`](agentes/workflows/). |
| [`criterios/`](criterios/) | Los criterios escritos: [correcciones](criterios/correcciones.md) (el texto literal que usaron los agentes Opus), [verificación](criterios/verificacion.md), [neutralidad](criterios/neutralidad.md), [regla de enlaces](criterios/enlaces.md), [registro de fuentes](criterios/fuentes.md), [temas](criterios/temas.md) y [preguntas](criterios/preguntas.md) (a qué pregunta del votante responde cada sección y qué hace falta para entrar en ella). |
| [`procesado/`](procesado/) | Los validadores y cálculos en TypeScript, con tests sobre datos de ejemplo que se ejecutan solos (`npx vitest run`). |
| [`esquemas/`](esquemas/) | La estructura (JSON Schema) de los cuatro archivos de datos. |
| [`metodologia/`](metodologia/) | La [metodología](metodologia/metodologia.md) tal como está publicada en el sitio. |

## Qué no hay aquí

**Ningún dato ya procesado**: ni el contenido de las fichas de partido, ni los valores del registro de fuentes, ni los teletipos clasificados, ni las listas de candidatos a artículo, ni las salidas de los agentes. Los datos publicados se pueden ver en el propio sitio, cada uno con su enlace a la fuente. Aquí está **cómo** se obtuvieron.

Tampoco está el código de presentación del sitio (componentes y páginas), que solo pinta lo que devuelve `procesado/`.

## Cómo funciona, de principio a fin

```text
 fuentes ──► 1. recogida ──► 2. verificación ──► 3. adjudicación ──► 4. publicación
            (Haiku, un     (Haiku, un agente   (Opus, un agente    (código determinista
             agente por     por artículo)       por partido, con    + validadores: misma
             fuente)                            criterio común)     entrada, misma salida)
```

### 1. Recogida por fuente

Cada emisor del registro de fuentes tiene un **método de recogida** (`recogida.metodo`): su `sitemap`, su feed `rss`, una `api`, una página de `seccion`, `busqueda` web restringida al dominio (el método por defecto) u `omitir` (fuera de ámbito, solo para citar datos, o bloquea a clientes automatizados). El método de cada fuente sale de un diagnóstico hecho por agentes ([04](agentes/04-verificar-y-diagnosticar.md)) que prueba qué canal funciona de verdad.

La búsqueda la hace **un agente Haiku por fuente** ([01](agentes/01-cobertura-por-fuente.md)), con el mismo prompt para todas. Como los medios llaman a los partidos de muchas formas, se repite con todos los alias de cada partido: primero para Frente Amplio, cuyo nombre es nuevo ([02](agentes/02-alias-frente-amplio.md)), y después, con el mismo método, para los otros cuatro ([03](agentes/03-alias-por-partido.md)), para que la cobertura de los cinco sea comparable. Los alias están en un archivo propio con validador (`partidos-alias`).

### 2. Verificación y clasificación por artículo

Cada artículo candidato lo abre **un agente Haiku distinto** ([04](agentes/04-verificar-y-diagnosticar.md), [05](agentes/05-verificar-candidatos-2.md)). Lo que dijo la búsqueda se trata como posiblemente erróneo: el agente lee en la página la fecha, el titular, la firma o agencia y el protagonista, decide si entra (`VERIFICADO`, `PARCIAL`, `NO_VERIFICABLE`, `DESCARTADO`) y lo clasifica: partidos, género y un tema de la taxonomía común.

La sección de la ficha se decide **primero por pregunta**: el agente elige a cuál de las ocho preguntas del votante responde el material (¿quién se presenta?, ¿qué dicen que harán?, ¿lo que dicen es cierto?, ¿han cumplido antes?, ¿han cambiado de opinión?, ¿qué dicen de ellos?, ¿cómo van en las encuestas?, ¿tienen causas abiertas?) o a ninguna, y solo después la sección dentro de esa pregunta, con los criterios de admisión de cada una: `por-escrito` solo con un documento escrito del propio partido; una afirmación del propio candidato nunca es un bulo; un cambio de opinión es del mismo actor y muestra un cambio real; el historial necesita la promesa y el resultado; una encuesta se cita por la empresa o el medio que la encargó. Un dato de fondo sin declaración del partido es una nota de contexto (`contexto: true`), sin veredicto. La correspondencia y los criterios están en [criterios/preguntas.md](criterios/preguntas.md); el código rechaza una propuesta cuya pregunta no corresponde a su sección. La pregunta no se guarda: la ficha sigue organizada por secciones.

Lo ya publicado se **reverifica** igual, una afirmación por agente ([06](agentes/06-reverificar-publicados.md)): cada enlace, su URL canónica, si respalda el texto, si la cita es literal y la neutralidad de la redacción.

### 3. Adjudicación por partido

Las propuestas de Haiku son indicios, no órdenes. Las decide **un agente Opus por partido**, los cinco en paralelo (cinco partidos en esa ejecución), con el mismo prompt y el **mismo criterio escrito** ([07](agentes/07-correcciones-por-partido.md), [criterio](criterios/correcciones.md)). Aplica los arreglos seguros (URL canónica, descartar lo falso o no verificable) y decide con juicio los casos dudosos, anotando las objeciones que rechaza. Cada agente solo puede editar la ficha de su partido.

### 4. Publicación determinista con validadores

Los agentes solo escriben archivos JSON de datos. Todo lo demás es **código determinista** ([`procesado/`](procesado/)): sin reloj, sin aleatoriedad, colación y orden fijos. **Misma entrada, misma salida.** Antes de publicar, los validadores comprueban cada regla de este documento; si algún dato incumple una, la publicación se detiene con un mensaje que dice qué y dónde.

## Reglas de neutralidad

Detalle en [criterios/neutralidad.md](criterios/neutralidad.md). En resumen:

- Mismo esquema, mismo prompt, mismo criterio y mismo estándar para los cuatro partidos; mismo tratamiento y extensión. Se publican todos los elementos válidos, sin recortar.
- Sin adjetivos ni adverbios valorativos; la interpretación de un medio se atribuye al medio; citas literales de menos de 15 palabras con su enlace.
- Ningún orden favorece a un partido: en la web se baraja en cada visita.
- Tarjetas idénticas en forma, sin colores ni logotipos de partido.
- No se publican datos personales o patrimoniales.

## Estados de verificación

| Estado | Significado | ¿Se publica? |
|---|---|---|
| **VERIFICADO** | La fuente dice lo que se afirma. | Sí |
| **CORREGIDO** | La redacción tenía un error; se publica la versión corregida. | Sí |
| **PARCIAL** | Solo una parte se pudo comprobar; el matiz explica qué falta. | Sí, con matiz obligatorio |
| **NO VERIFICABLE** | Las fuentes no se pueden abrir o no lo contienen. | No |
| **FALSO** | Las fuentes lo contradicen. | No |

Lo no publicado queda en la ficha como rastro de auditoría (`descartados`, con estado y motivo) y nunca se muestra. Detalle en [criterios/verificacion.md](criterios/verificacion.md).

## Regla de enlaces

Cada afirmación enlaza al **artículo o documento concreto**: nunca una portada, un índice de sección, un enlace corto ni una página en vivo. La única excepción es la portada de la web oficial **del propio partido**, y solo para su lema y sus frases de campaña, porque son lo que el partido dice de sí mismo. El validador lo comprueba en cada enlace. Detalle en [criterios/enlaces.md](criterios/enlaces.md).

## Cómo se calculan los gráficos de temas

Cada tarjeta muestra de qué políticas habla el partido según los teletipos de EFE y Europa Press:

- La unidad es el **evento** (un acto o una declaración), no el teletipo: varios teletipos del mismo acto comparten evento y cuentan **una vez**; uno conjunto cuenta para cada partido.
- Los eventos sobre la propia campaña (pactos, listas, encuestas, ataques al rival) se cuentan aparte y se excluyen del gráfico.
- Se muestran los temas con al menos un 5 %, comparando recuentos exactos; el resto va a «Otros».
- Los porcentajes se redondean por el **método del mayor resto**, para que cada gráfico sume exactamente 100, con desempates en un orden fijo.

Código en [`procesado/src/lib/temas.ts`](procesado/src/lib/temas.ts) y [`focus.ts`](procesado/src/lib/focus.ts); reglas en [criterios/temas.md](criterios/temas.md).

## Cómo se muestra la orientación de las fuentes

**No clasificamos a ningún medio.** Solo se muestran valoraciones externas ya publicadas, cada una con su método, su fecha y su enlace; si no hay, «sin dato». Hay dos, y **nunca se mezclan**: Media Bias/Fact Check (análisis de contenido, de −10 a +10; un único evaluador, estadounidense y discutido) y los estudios de audiencias del CIS (percepción del público, de 1 a 10). Cada una tiene su propio eje, con un solo color neutro. El emisor de un enlace es el sitio al que apunta, por dominio exacto. Detalle en [criterios/fuentes.md](criterios/fuentes.md).

## Acceso a las webs de los partidos

Se comprueba con un cliente automatizado, con fecha, si la web oficial de cada partido se deja leer, y el resultado aparece igual en las cuatro fichas: **abierta** (se verifica en la propia web), **parcial** (páginas bloqueadas pero feed RSS legible: se verifica con el feed) o **bloqueada** (lo que dice se sigue a través de agencias y medios). El validador exige esta comprobación para cada partido.

## Modelos usados y por qué

| Modelo | Para qué | Por qué |
|---|---|---|
| **Haiku** | Búsqueda por fuente, verificación y clasificación por artículo, reverificación por afirmación, diagnóstico de fuentes. | Son cientos de tareas pequeñas, cerradas y del mismo tipo, con un esquema de salida estricto. Un agente barato por tarea permite que cada artículo y cada afirmación tenga su propia comprobación independiente, en lugar de que un solo agente revise muchos y arrastre sus impresiones de uno a otro. |
| **Opus** | Adjudicación de las correcciones por partido y revisión. | Son pocas decisiones de juicio (¿la objeción se sostiene?, ¿qué redacción es fiel a la fuente?) que piden más criterio. Un agente por partido, con el mismo criterio escrito, para que el estándar sea el mismo para los cinco. |
| **Sonnet** | Trabajo mecánico: rellenar datos ya decididos, cambios de código sin decisiones de diseño. | No requiere juicio sobre el contenido; las reglas ya están fijadas y los validadores lo comprueban. |

Ningún modelo decide solo qué se publica: lo que proponen los agentes pasa por un criterio escrito y por validadores deterministas.

## Licencia

Pendiente de decisión del autor. Mientras no haya un archivo `LICENSE`, se aplican los derechos de autor por defecto.
