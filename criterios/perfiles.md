# Criterio de los perfiles de partido

Reglas de la página de documentos de cada partido (`/documentos/`). Son las mismas para los cinco. Solo están las reglas y el esquema, no el contenido de los perfiles. Si algo de aquí difiere del código del sitio, manda el código.

## Qué cuenta

- Solo cuentan los documentos del propio partido fechados dentro del periodo, del **5 de octubre** a la fecha de corte.
- El periodo avanza cada día. Es el mismo para los cinco: el sitio comprueba que `desde` y `hasta` coincidan en los cinco perfiles.
- El periodo termina en la fecha de corte de las fichas. El sitio comprueba que `periodo.hasta` de cada perfil sea igual al `corte` de la ficha de ese partido.
- Un documento publicado tiene que estar fechado dentro del periodo. El sitio lo comprueba.
- Un documento fechado después del corte espera en `en_espera`, sin publicarse, hasta que el corte avance. El sitio comprueba que esté fechado después de `periodo.hasta` (si no, se publica) y que los elementos publicados no citen documentos en espera.
- Los documentos fuera del periodo no se incluyen. Cada perfil lo indica en sus `limites` (regla editorial).
- El perfil describe el conjunto recogido. No describe lo que un partido no ha publicado (ver [equidad](equidad.md#ausencias)).

## Estructura de un perfil

Un perfil por partido, con estos campos (el sitio rechaza campos desconocidos):

| Campo | Contenido |
|---|---|
| `partido` | Identificador del partido. |
| `periodo` | `desde` y `hasta` (ISO). |
| `limites` | Lista de textos con los límites de la recogida. |
| `documentos[]` | Los documentos del periodo. |
| `propuestas[]` | Propuestas por tema, cada una con una cita y los documentos de los que sale. |
| `mensajes[]` | Mensajes por tipo, con los documentos de los que salen. |
| `en_espera` | Opcional: `documentos`, `propuestas` y `mensajes` que dependen solo de documentos posteriores al corte. Mismas reglas, no se muestran. |

Documento: `id`, `titulo`, `fecha`, `fecha_fuente` (de dónde sale la fecha), `tipo`, `url`, `url_pendiente` y `procedencia`.

## Cómo se recoge cada documento

`procedencia` indica cómo se obtuvo:

- `via`: `web`, `rss` o `buzon` (a mano).
- `consultado`: fecha ISO de la lectura. No puede ser anterior a la `fecha` del documento.

## URL pendiente

- Si no hay URL, `url` es `null` y `url_pendiente` explica por qué. La página muestra «Documento sin dirección pública confirmada» junto con ese texto.
- `url_pendiente` solo se admite cuando `url` es `null`.
- Si hay URL, es https y apunta al documento concreto, no a una portada, un índice ni un enlace corto.

## Propuestas y mensajes

- El texto de toda propuesta empieza por «Propone». El sitio lo comprueba.
- Una medida concreta aparece solo en propuestas, una por cada punto del documento. Las acciones y las medidas ya en vigor son mensajes. Es una regla editorial.

## Citas y referencias

- Las citas tienen menos de 15 palabras. El sitio lo comprueba también en los textos con comillas.
- La cita de una propuesta apunta a un documento que está entre los documentos de esa propuesta; `pagina`, si existe, es un entero positivo.
- Las propuestas usan los temas comunes sin el tema de campaña ([temas](temas.md)).
- Todo `documentos` de una propuesta o un mensaje es una lista no vacía de identificadores que existen en el perfil, sin repeticiones. Los identificadores son únicos.

## Orden

La página es una función de los datos: sin reloj ni aleatoriedad, con colación fija. Los documentos van por fecha e identificador; las propuestas, por tema.

## Límites abiertos

- Vox: la URL de un documento está pendiente.
- PSOE: no se han podido recoger las páginas de archivo de octubre (páginas 2 a 4) ni las de noviembre.
