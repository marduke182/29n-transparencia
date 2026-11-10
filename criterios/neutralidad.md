# Reglas de neutralidad

Estas reglas están repartidas por los prompts, el [criterio de correcciones](correcciones.md), la [metodología publicada](../metodologia/metodologia.md) y los validadores. Aquí se reúnen.

## En el texto

- **Sin adjetivos ni adverbios valorativos.** Los resúmenes son una frase con el hecho verificable.
- **Lo que es interpretación de un medio se atribuye al medio** («según X»). Si falta, el reverificador lo marca (`atribucion_falta`).
- **Citas literales, de menos de 15 palabras** y con su enlace. El validador cuenta las palabras de todo lo que va entre comillas («», “”, "", ‘’) en todos los campos de texto.
- **Nada de información nueva al corregir**: la redacción corregida es mínima y fiel a la fuente, con los números como en la fuente.
- Los reverificadores señalan además: palabras cargadas, encuadre selectivo y redacción que favorece o perjudica al partido más allá de la fuente.
- No se publican datos personales o patrimoniales (sueldos, viviendas, vida privada). Sí los procesos judiciales y los cargos públicos.

## Igual para los cinco partidos

- **Mismo esquema** de ficha (nueve secciones fijas, en el mismo orden; el validador lo exige), **mismo prompt**, **mismo criterio** y **mismo estándar** («Be strict and identical in standard for every party»).
- **Mismo tratamiento y extensión.** No se recorta el número de elementos: se publican todos los válidos.
- Si falta un lado en «Críticos y defensores», todas las fichas muestran la misma nota.
- Cuando una búsqueda se hizo solo para un partido, se repite para los demás con el mismo método (workflows [02](../agentes/02-alias-frente-amplio.md) y [03](../agentes/03-alias-por-partido.md)).
- Los recuentos por partido muestran siempre a los cinco, también con cero, en orden fijo.

## Orden y forma

- Ningún orden favorece a un partido: en la web, tarjetas, navegación y «Otros partidos» se barajan en el navegador en cada visita (Fisher–Yates con `crypto.getRandomValues`); sin JavaScript, orden alfabético.
- Tarjetas idénticas en forma, sin colores ni logotipos de partido, sin encuestas, escaños ni veredictos en la portada.
- Los colores de los gráficos de temas son de tema, iguales en todas las tarjetas; no son colores de partido.

## Orientación de las fuentes

- **No etiquetamos a ningún medio.** Solo se muestran valoraciones externas ya publicadas, cada una con método, fecha y enlace. Si no hay valor publicado, «sin dato». Nada de números derivados.
- **Dos escalas que nunca se mezclan**: Media Bias/Fact Check (análisis de contenido, −10 a +10; evaluador único, estadounidense y discutido; se muestra su marca «Cuestionable» cuando existe) y los estudios de audiencias del CIS (percepción del público, 1 a 10, con estudio, trabajo de campo, n y desviación típica, y la atribución «Fuente de datos: Centro de Investigaciones Sociológicas»). Cada una en su propio eje con su escala.
- Un solo color neutro para el marcador; nada de escala de colores izquierda/derecha.
- Solo los medios, verificadores y agencias pueden llevar valoraciones (el validador lo exige). Organismos oficiales, webs de partido y fuentes de datos muestran «No es un medio».

Detalle en [fuentes.md](fuentes.md).

## Las webs de los partidos

Se comprueba con un cliente automatizado, con fecha, si la web oficial de cada partido se deja leer, y el resultado se muestra igual en las cinco fichas: `abierto` (se verifica en la propia web), `parcial` (páginas bloqueadas pero el feed RSS se puede leer: se verifica con el feed) o `bloqueado` (lo que dice se sigue a través de agencias y medios). El `detalle` dice lo que respondió el sitio como un hecho («Responde 403 a clientes automatizados»). El validador exige este dato en cada web de partido.
