# Procesado: validadores y cálculos

El código TypeScript que, en el sitio, decide **qué se puede publicar** y **cómo se calcula lo que se muestra**. Todo son funciones puras de los datos locales: sin reloj, sin aleatoriedad, con colación y orden fijos. Misma entrada, misma salida. Si un dato incumple una regla, el validador devuelve un mensaje legible por regla y la publicación del sitio se detiene.

## Cómo ejecutarlo

Necesita Node 20 o posterior.

```sh
cd procesado
npm ci          # vitest 5.0.3 y typescript 5.8.3, del registro público de npm
npx vitest run  # o: npm test
npx tsc --noEmit
```

Los tests usan **solo datos de ejemplo** (fixtures escritos en cada test). Este repositorio no publica los datos procesados del sitio.

## Módulos

| Archivo | Qué hace |
|---|---|
| `src/config.ts` | Los ids de los cuatro partidos, en el orden fijo de todos los recuentos. |
| `src/data/fuentes.ts` | Tipos del registro de fuentes (emisor, valoraciones MBFC y CIS, acceso a la web del partido, método de recogida) y las listas cerradas de valores. |
| `src/lib/partidos.ts` | Tipos de la ficha de partido, los estados publicables, los veredictos y las nueve secciones fijas. |
| `src/lib/validate.ts` | `validatePartido`: reglas de publicación de cada ficha (estados, matiz en PARCIAL, fuentes https, citas de menos de 15 palabras en cualquier campo, propuesta de 20 palabras como máximo, campos que solo valen en una sección, refs únicos) y la [regla de enlaces](../criterios/enlaces.md) (`notArticleUrl`). |
| `src/lib/fuentes.ts` | `hostDe`, `emisorDe` (host exacto), `citasPorEmisor` (recuento por emisor y partido, con ceros), `emisoresDe` (orden fijo), y `validateFuentes`: forma y reglas del registro de fuentes. Ver [criterios/fuentes.md](../criterios/fuentes.md). |
| `src/lib/fuentes-chart.ts` | Geometría de los ejes de orientación: MBFC (−10 a +10) y CIS (1 a 10) en ejes separados, nunca fusionados; posición fuera de escala = error. |
| `src/lib/temas.ts` | `validateTemas` y `countTemas`: recuento por eventos únicos (los teletipos duplicados de un mismo acto cuentan una vez; uno conjunto cuenta para cada partido), exclusión de la campaña (`POL`) y `largestRemainder`, el redondeo por mayor resto que hace sumar 100 exactamente. Ver [criterios/temas.md](../criterios/temas.md). |
| `src/lib/focus.ts` | `buildFocus`: el donut de cada tarjeta (umbral del 5 % sobre recuentos exactos, resto en «Otros», colores fijos por tema). |
| `src/lib/partidos-alias.ts` | `validatePartidosAlias`: la lista de nombres, marcas, miembros, personas y exclusiones de cada partido que usan las búsquedas; ningún nombre puede acreditar a dos partidos. |
| `src/lib/format.ts` | Formato español de números y fechas (coma decimal, signo menos U+2212). |

Cada módulo tiene su test al lado (`*.test.ts`).

## Diferencias con el código del sitio

Son copias del código del sitio a fecha 10 nov 2026. Estos archivos son **idénticos**: `validate.ts`, `validate.test.ts`, `fuentes.ts`, `fuentes-chart.ts`, `fuentes-chart.test.ts`, `temas.ts`, `format.ts`, `format.test.ts`.

El resto cambia solo para no depender de los datos, que no se publican aquí:

- **`config.ts`**: solo los ajustes de partido (sin la URL ni las fechas del sitio).
- **`data/fuentes.ts`**: solo tipos y listas de valores. En el sitio, `RAW_FUENTES`, `MBFC`, `CIS_ESTUDIOS` y `EMISORES` se leen de `fuentes.json`; aquí están vacíos. Las funciones que los usan como valor por defecto (`emisorDe`, `validateFuentes`, `validatePartido`, `estudioReciente`, `filaCis`…) reciben los datos como argumento, y los tests siempre los pasan.
- **`lib/partidos.ts`**: sin la importación de las cuatro fichas JSON (`RAW_PARTIDOS`, `getPartido`, `getPartidos`).
- **`lib/partidos-alias.ts`**: `RAW_PARTIDOS_ALIAS` está vacío; hay que pasar los datos a `getPartidosAlias`.
- **`lib/focus.ts`**: en el sitio, el bloque final valida y cuenta `temas-items.json` al cargar el módulo y exporta `getFocus(id)`. Aquí ese mismo bloque está dentro de `crearGetFocus(raw)`, que devuelve la misma función `getFocus`.
- **Tests**: `fuentes.test.ts` pasa un registro de ejemplo (`REGISTRO`) en lugar del `fuentes.json` real; `temas.test.ts`, `focus.test.ts` y `partidos-alias.test.ts` usan datos de ejemplo. Se han quitado las comprobaciones contra los datos reales: «acepta los datos publicados» y las bases por partido de la versión publicada (`temas.test.ts`, `focus.test.ts`). El test `fuentes-data.test.ts` del sitio, que valida el registro real contra las fichas reales, no se incluye.

## Qué no está aquí

- Los componentes y páginas del sitio (Astro), que solo pintan lo que estos módulos devuelven.
- Los datos: fichas de partido, registro de fuentes, teletipos clasificados, alias. Su estructura sí está en [`../esquemas/`](../esquemas/).
