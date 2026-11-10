# Criterio de verificación

Este criterio reúne lo que piden los prompts de verificación ([04](../agentes/04-verificar-y-diagnosticar.md), [05](../agentes/05-verificar-candidatos-2.md), [06](../agentes/06-reverificar-publicados.md)) y lo que comprueban los validadores ([`procesado/`](../procesado/)). Si algo de aquí difiere de un prompt, manda el prompt, porque es lo que se ejecutó.

## Dos momentos de verificación

1. **Antes de entrar en los datos** (workflows 04 y 05): cada artículo candidato que devuelve una búsqueda lo abre un agente distinto. Los datos de la búsqueda (fecha, título, resumen) se tratan como posiblemente erróneos: el agente lee **en la propia página** la fecha real, el titular, la firma o agencia y el protagonista.
2. **Después de publicar** (workflow 06): cada afirmación ya publicada la vuelve a comprobar un agente distinto, enlace por enlace. Lo que propone lo adjudica después un agente Opus por partido con el [criterio de correcciones](correcciones.md).

## Estados de un candidato (antes de entrar)

| Estado | Cuándo |
|---|---|
| `VERIFICADO` | La página existe, está fechada dentro del periodo (5 oct – 10 nov 2026) y su tema principal es uno o varios de los cinco partidos o sus líderes. |
| `PARCIAL` | Encaja, pero algo del candidato estaba mal (se dice qué) o el partido es secundario. |
| `NO_VERIFICABLE` | La página no se pudo abrir tras un reintento. |
| `DESCARTADO` | Fuera de periodo; no trata de estos partidos (por ejemplo, el Frente Amplio de Uruguay o Chile, política solo local, mención de pasada); contenido duplicado; o no es una noticia ni un documento. |

## Estados de una afirmación publicada

| Estado | Significado | ¿Se publica? |
|---|---|---|
| **VERIFICADO** | Las fuentes respaldan la afirmación tal como está escrita. | Sí |
| **CORREGIDO** | Se sostiene solo con un cambio de redacción; se publica la versión corregida. | Sí |
| **PARCIAL** | Solo una parte se puede comprobar; se publica con su `matiz`, que explica qué falta. | Sí, con matiz obligatorio |
| **NO VERIFICABLE** | Las fuentes no se pueden abrir o no contienen lo que se afirma. | No: va a `descartados` con motivo |
| **FALSO** | Las fuentes lo contradicen. | No: va a `descartados` con motivo |

El validador (`validatePartido`) solo admite `VERIFICADO`, `CORREGIDO` y `PARCIAL`, y exige `matiz` en `PARCIAL`; la publicación se detiene si no se cumple. Lo descartado se guarda como rastro de auditoría y nunca se muestra en la web.

## Qué comprueba cada agente en cada enlace (workflow 06)

- **Accesible**: se abre la página (un reintento).
- **URL canónica**: la URL completa y exacta del artículo, siguiendo redirecciones y enlaces cortos y prefiriendo `<link rel="canonical">` u `og:url`. Nunca una portada, un índice de sección ni un enlace corto. Si la URL actual es una portada, se busca el artículo concreto que respalda la afirmación y solo se propone si se ha abierto y lo respalda. Ver la [regla de enlaces](enlaces.md).
- **Es artículo**: si la página es un artículo o documento concreto.
- **Fecha y medio o agencia**, leídos en la página.
- **Respalda**: `si`, `parcial` (diciendo qué falta), `no` o `no_comprobable`.
- **Cita**: tiene que aparecer literalmente en la página citada y tener menos de 15 palabras.
- **Neutralidad**: ver [neutralidad](neutralidad.md).

## Veredictos de la sección «Verificación de afirmaciones»

El veredicto valora **lo que dijo el partido**, no al partido: **Respaldado**, **Matizable**, **Engañoso**, **Sin datos** (no se han encontrado datos; no significa que sea falso). Cuando un verificador externo lo ha calificado, se atribuye a ese verificador. Las verificaciones de bulos **sobre** un partido van en un apartado aparte, con el mismo formato en las cinco fichas.

## Clasificación (workflows 04 y 05)

Cada candidato verificado recibe: partidos (solo los que son tema principal), protagonista, género (`noticia`, `opinion`, `entrevista`, `verificacion`, `documento_oficial`, `programa_o_propuesta`, `nota_de_prensa`, `encuesta`, `otro`), un tema principal de la taxonomía común y la sección de la ficha a la que alimentaría. Si la pieza es interpretación u opinión del medio y no un hecho, se marca `atribucion_necesaria`.

Taxonomía de temas (la misma para todo): TRA Transporte, VIV Vivienda, COR Corrupción, SEG Seguridad, INM Inmigración, PEN Pensiones, ECO Economía e impuestos, EMP Empleo y salarios, SOC Servicios sociales, TER Modelo territorial, EDU Educación, EXT Exterior y defensa, MED Energía y clima, SAN Sanidad, IGU Igualdad y derechos, POL Política, partidos y campaña, OTR Otros.
