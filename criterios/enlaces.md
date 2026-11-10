# Regla de enlaces

**Cada afirmación enlaza al artículo o documento concreto del que sale.** Nunca a una portada, un índice de sección, un enlace corto ni una página en vivo que cambie (directos, herramientas de encuestas o de programas).

**Excepción:** el lema y las frases del propio partido (la tarjeta `fuente_lema` y los ítems de la sección `lema-y-frases`) pueden enlazar la **portada de la web oficial de ese partido**, porque son afirmaciones del partido sobre sí mismo y su propia web es la fuente. La excepción es solo para la portada del propio partido: un índice de sección o un enlace corto se rechazan también ahí.

## Cómo se comprueba

El validador (`notArticleUrl` y `validatePartido` en [`procesado/src/lib/validate.ts`](../procesado/src/lib/validate.ts)) rechaza una URL cuando:

- no se puede analizar como URL;
- su host es un acortador (`bit.ly`, `t.co`, `goo.gl`, `ow.ly`, `tinyurl.com`, `lnkd.in`) o es un enlace corto de eldiario.es (`/1_<hex>`);
- no tiene ruta (es una portada), salvo la excepción de arriba, comprobada contra los hosts del emisor de tipo `partido` de ese partido en el registro de fuentes;
- su último segmento es un índice de sección: `noticias`, `actualidad`, `news`, `blog`, `category`, `categoria`, `tag`, `etiqueta`, `seccion`, `politica`, `opinion`, `home`, `inicio`, `portada`.

Se aplica a todos los enlaces de la ficha: fuentes de cada ítem, `cita.url`, `fuente_lema`, `fuente_propuesta` y `fuentes_propuesta`. Todos tienen que ser `https`.

Las páginas en vivo no se pueden detectar por la forma de la URL: las señala el reverificador ([06](../agentes/06-reverificar-publicados.md)) y el [criterio de correcciones](correcciones.md) manda sustituirlas por un artículo fechado que diga lo mismo, o descartar el ítem.

## Cómo se llega a la URL correcta

El reverificador da la `url_canonica`: sigue redirecciones y enlaces cortos, y prefiere `<link rel="canonical">` u `og:url`. Si la URL actual es una portada, busca el artículo concreto que respalda la afirmación y solo lo propone si lo ha abierto y lo respalda. El agente de correcciones sustituye la URL por la canónica cuando es el mismo artículo.

## A quién se cuenta un enlace

El emisor de un enlace es **el sitio al que apunta**, por host exacto, en minúsculas y sin `www.`: `diariodeavisos.elespanol.com` no es `elespanol.com`. Si una noticia cita a una agencia (EFE, Europa Press), cuenta para el sitio que la publica. Todo host enlazado tiene que tener exactamente un emisor en el registro de fuentes (`validateFuentes`).
