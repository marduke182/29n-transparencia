# Registro de fuentes: reglas

Reglas del registro de emisores (`fuentes.json` en el sitio) y de cómo se muestra su orientación. Proceden del plan aprobado para la página `/fuentes/` (10 nov 2026); aquí solo están las reglas y el método, no los datos ni los pasos de implementación. La estructura del archivo está en [`../esquemas/fuentes.schema.json`](../esquemas/fuentes.schema.json) y el validador en [`../procesado/src/lib/fuentes.ts`](../procesado/src/lib/fuentes.ts).

## Arquitectura

- Los agentes diarios actualizan **solo los JSON de datos**; son la única parte no determinista.
- Todo lo demás es **determinista a partir de los datos locales**: sin reloj (`Date.now`) ni aleatoriedad (`Math.random`) en la lógica de publicación, colación fija (`Intl.Collator('es')`) y orden estable (tipo → nombre → id). Misma entrada, misma salida.
- `validateFuentes` es la puerta: comprueba forma y reglas, devuelve un mensaje legible por regla incumplida y la publicación se detiene si hay alguno.
- Cada valoración guarda dos fechas: la del evaluador (`fecha`) y la de nuestra lectura (`consultado`).

## Qué es un emisor y cómo se cuenta

- El emisor es **el sitio al que apunta el enlace**, por host exacto (`new URL(url).hostname` en minúsculas y sin `www.`). Un subdominio es otro emisor salvo que el registro agrupe varios hosts bajo uno.
- Las agencias (EFE, Europa Press, ACN) no se listan como emisor cuando nunca son el host enlazado: lo que se cita de ellas cuenta para el sitio que lo publica.
- **Recuento por partido**: solo las fuentes de los ítems (`fuentes[]`). Los enlaces de la tarjeta y de las citas se validan contra el registro pero no se cuentan.
- Los cinco partidos aparecen siempre, en el orden fijo de ids, también con cero.
- Orden de tipos: medios, verificadores, agencias, fuentes oficiales, partidos (documentos propios), datos y análisis; dentro de cada tipo, alfabético (colación `es`).

## Reglas del validador

- Todo host enlazado desde una ficha (fuentes, `cita.url`, `fuente_lema`, `fuente_propuesta`, `fuentes_propuesta`) tiene un emisor.
- Ningún host está bajo dos emisores; los hosts van en minúsculas y sin `www.`.
- Ningún emisor sin citar, salvo las webs de partido.
- Cada partido tiene exactamente una web (emisor de tipo `partido`), citada o no, con su comprobación de acceso fechada (`acceso`).
- Valoraciones solo en medios, verificadores y agencias.
- MBFC: la puntuación, si existe, cae dentro de la banda de su etiqueta (Left ≤ −5; Left-Center −4,9 a −2; Least Biased −1,9 a +1,9; Right-Center 2 a 4,9; Right ≥ 5); URL https en mediabiasfactcheck.com.
- CIS: media entre 1 y 10, desviación típica ≥ 0, n entero positivo, estudio conocido y no repetido; las claves de estudio son el número del CIS y su trabajo de campo incluye el año.
- Fechas ISO reales; URLs https; ids en formato slug y únicos; campos desconocidos rechazados.
- `recogida.metodo` es uno de `sitemap`, `rss`, `api`, `seccion`, `busqueda`, `omitir` (sin el campo, búsqueda web).

## Neutralidad al mostrar la orientación

- Nunca etiquetamos a un emisor nosotros: solo valoraciones publicadas, cada una enlazada, con método y fecha; «sin dato» si no hay.
- Sin números derivados; mismo marcado para todos los emisores de un tipo; un único color neutro para el marcador, sin escala de color izquierda/derecha.
- MBFC con su advertencia («Evaluador único, estadounidense y discutido»), enlace a su metodología y la marca «Cuestionable» cuando la hay.
- CIS: «Percepción del público, no análisis de contenido», con estudio, trabajo de campo, n, desviación típica y «Fuente de datos: Centro de Investigaciones Sociológicas» con enlace.
- MBFC (−10 a +10) y CIS (1 a 10) **nunca se fusionan**: cada uno en su propio eje rotulado. Etiquetas MBFC traducidas: Izquierda, Centro-izquierda, Menos sesgado, Centro-derecha, Derecha.
- Los ejes son SVG generados al publicar; todos los valores están también en texto HTML.
- Organismos oficiales, webs de partido y datos: sin gráfico, con la línea «No es un medio: no se muestra orientación».
- Un sitio que publica en el dominio de un medio valorado pero con otra marca no hereda su valoración (se deja «sin dato»).
