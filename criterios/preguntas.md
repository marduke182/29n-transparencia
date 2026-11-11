# Criterio de clasificación por preguntas

Las fichas de partido se organizan alrededor de las preguntas que se hace un votante. Este documento es la definición canónica de esas preguntas, de las secciones que las responden y de lo que hace falta para que un elemento entre en cada una. Se aplica igual a los cuatro partidos. Si algo de aquí difiere del código, manda el código: [`recogida/src/preguntas.ts`](../recogida/src/preguntas.ts) (la correspondencia pregunta → sección) y los validadores del sitio.

## Clasificar primero por pregunta

El clasificador y el adjudicador de la recogida diaria ([08](../agentes/08-diario.md)) deciden primero **a qué pregunta responde** el material (`pregunta`, de `Q1` a `Q8`) y solo después la sección. Lo que no responde a ninguna pregunta, o responde a dos por igual, no se fuerza en una sección: el clasificador lo deja con `pregunta` y `seccion` nulas y el adjudicador lo descarta con ese motivo.

- `seccion` sigue siendo el campo que se guarda: el sitio y sus validadores se basan en él.
- `pregunta` va en la propuesta, junto a `seccion`, y **no se guarda** en la ficha. El código rechaza una propuesta cuya `pregunta` no corresponde a su `seccion`, una `pregunta` nula y un elemento que lleve `pregunta` dentro.

## Las preguntas y sus secciones

| # | Pregunta | Secciones | Entra cuando el elemento… |
|---|---|---|---|
| Q1 | ¿Quién se presenta? | `candidatura` | trata del candidato, la lista, la coalición o las alianzas, o de quién se presenta dónde. |
| Q2 | ¿Qué dicen que harán? | `lema-y-frases`, `temas`, `por-escrito` | es el lema o las frases del propio partido (`lema-y-frases`), un tema que el partido impulsa o evita, o lo que dicen de palabra (`temas`), o una propuesta escrita en un documento del propio partido (`por-escrito`). |
| Q3 | ¿Lo que dicen es cierto? | `verificacion` con `afirmacion` y sin `bulo` | comprueba una afirmación hecha por el partido o por su candidato. |
| Q4 | ¿Han cumplido antes? | `historial` | compara lo que se prometió o anunció con lo que se hizo (se votó, se gobernó, se ejecutó). |
| Q5 | ¿Han cambiado de opinión? | `cambios` | documenta un cambio de posición del mismo actor (`antes` → `ahora`). |
| Q6 | ¿Qué dicen de ellos? | `criticos-defensores`, `verificacion` con `bulo` | es lo que otros dicen del partido: críticos, defensores, o la verificación de un bulo sobre el partido. |
| Q7 | ¿Cómo van en las encuestas? | `encuestas` | es una encuesta, una estimación o un escenario electoral. |
| Q8 | ¿Tienen causas abiertas? | `historial`, solo desde la búsqueda igual de `causas` | es una causa judicial, una querella, una investigación o una resolución que afecta al partido o a sus candidatos. |

Dos secciones responden a dos preguntas, y lo que las separa ya está en los datos guardados:

- `verificacion`: sin `bulo` es Q3; con `bulo: true` es Q6.
- `historial`: un elemento cuya `busqueda` es de tipo `causas` es Q8; el resto es Q4.

## Criterios de admisión

- **Q2, `por-escrito`**: solo una propuesta respaldada por un documento escrito del propio partido (programa, programa sectorial, documento oficial del partido), citado como fuente. Lo dicho en un mitin, una entrevista o un discurso, o conocido solo por el relato de la prensa, va en `temas`.
- **Q2, `lema-y-frases`**: las palabras del propio partido. Un titular del medio no es una frase del partido.
- **Q3 y Q6, `verificacion`**: decide quién habla. Una afirmación del partido, de su candidato o de sus dirigentes es Q3 (`afirmacion`), aunque la verificación la declare falsa: **nunca es un bulo**. Un bulo es lo que otros dicen o hacen circular sobre el partido (Q6, `bulo: true`) y sale solo de la búsqueda igual de bulos.
- **Q4, `historial`**: hacen falta pruebas de **los dos lados**, la promesa o el anuncio y el resultado. Con uno solo, no es historial. Una causa judicial nunca es Q4.
- **Q5, `cambios`**: `antes` y `ahora` son del **mismo actor**, sobre el mismo asunto, y muestran un cambio real, cada uno con su fuente. Dos actores distintos, o la misma posición dicha dos veces, no son un cambio.
- **Q6, `criticos-defensores`**: personas u organizaciones con nombre, solo desde la búsqueda igual; la `postura` (`critico` o `defensor`) corresponde a lo que dicen. Análisis de medios, editoriales y columnas no cuentan.
- **Q7, `encuestas`**: la fuente es la empresa demoscópica o el medio que encargó la encuesta, no un medio que la reproduce. Desde el 24 nov 2026 no se añaden encuestas (veda electoral).
- **Q8, causas**: se guardan en `historial` y salen solo de la búsqueda igual de `causas`, con su `busqueda`, como hasta ahora (ver [equidad](equidad.md)).

## Notas de contexto

Un dato de fondo relevante para una pregunta (una cifra oficial, una resolución, un dato del INE) pero sin declaración ni acción del partido es una **nota de contexto**:

- Lleva `contexto: true` en el elemento y va en la sección de la pregunta con la que se relaciona.
- **Nunca lleva veredicto**, así que nunca va en `verificacion`.
- El campo es opcional; sin él, el elemento no es una nota de contexto.

## Reglas que no cambian

La clasificación por preguntas no sustituye ninguna regla anterior: búsquedas iguales para los cuatro partidos; críticos, defensores, bulos y causas solo desde esas búsquedas; veda de encuestas desde el 24 nov; hechos compartidos escritos una vez y copiados igual a cada ficha ([equidad](equidad.md)); estados y fuentes ([verificación](verificacion.md), [enlaces](enlaces.md)); redacción ([neutralidad](neutralidad.md)).
