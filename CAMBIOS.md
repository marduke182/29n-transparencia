# Cambios

Registro fechado de los cambios en el proceso, los criterios y los validadores. Más reciente primero. Solo reglas y esquemas, no datos.

## 10 de noviembre de 2026

Tras la revisión de equidad, estos cambios se aplican a los cinco partidos por igual. Detalle en [equidad](criterios/equidad.md), [perfiles](criterios/perfiles.md) y [correcciones](criterios/correcciones.md).

1. **Estado estricto.** Lo que solo se conoce por el relato de la prensa es `PARCIAL`, con el matiz «Según el relato de X; no se ha consultado…». `VERIFICADO` exige una fuente primaria (oficial, partido o emisor de datos; transcripción completa; o veredicto del propio verificador). El sitio lo comprueba.
2. **Hechos compartidos.** Encuestas, votaciones, debates y decretos llevan la misma redacción, las mismas fuentes y el mismo estado en las fichas que los incluyen. Las líneas propias de un partido son una por partido con la misma plantilla, o ninguna. El sitio comprueba la coincidencia entre los elementos con la misma clave `hecho`. El sitio comprueba también que cada encuesta (clave `hecho` en encuestas) aparezca en las cinco fichas; una verificación compartida por dos partidos queda fuera de esa regla. La línea del CIS es una frase de plantilla por partido, tomada del PDF del CIS (regla editorial).
3. **Críticos y defensores.** El mismo número N por partido (hoy N = 1), a partir de una búsqueda igual. Los elementos que superan N quedan en `en_espera` hasta que los cinco alcancen N+1. Solo cuentan personas u organizaciones con nombre. El sitio comprueba la igualdad de recuentos.
4. **Verificaciones de bulos y causas judiciales.** La misma búsqueda para los cinco, registrada en `busquedas.json` (consultas y resultados). Cada elemento de bulos y de críticos y defensores nombra la búsqueda que lo encontró; el sitio comprueba que exista y que sea del tipo que corresponde. Cada hallazgo tiene exactamente una disposición (ver la segunda tanda, punto 12). Se publican todos los hallazgos válidos o quedan en espera.
5. **Perfiles de partido.** Solo cuentan los documentos del propio partido fechados entre el 5 de octubre y la fecha de corte, igual para los cinco. El periodo avanza cada día. Cada documento registra cómo se recogió (`web`, `rss` o `buzon`) y cuándo. Una URL ausente se muestra con una nota pública de pendiente.
6. **Ausencias.** Solo se afirman con una fuente fechada.
7. **Procedencia de las fuentes.** Campos opcionales `consultado`, `via` y `primaria`, con la forma comprobada por el sitio.
8. **Encuestas nuevas.** No se añaden desde el 24 de noviembre (LOREG, art. 69.7).
9. **Actualización diaria.** Una recogida diaria abre un borrador para revisión humana y no se publica nada de forma automática. Ver [agentes/08-diario.md](agentes/08-diario.md).
10. **Fechas.** Formato ISO estricto `AAAA-MM-DD` con día real de calendario. El sitio lo comprueba.
11. **Metodología del sitio.** Enlaza a este repositorio como lugar donde están los prompts, los criterios, los validadores y el proceso diario. Copia en [metodologia/metodologia.md](metodologia/metodologia.md).

### Segunda tanda, 10 de noviembre de 2026

11. **Búsqueda de críticos y defensores repetida.** Se repitió con términos de la misma forma para los cinco (nombre del partido y apellido de su candidato principal). Las búsquedas anteriores se conservan, marcadas como sustituidas (`sustituida_por`). El sitio rechaza un término vacío en un partido cuando los demás lo tienen, y rechaza elementos que apunten a una búsqueda sustituida.
12. **Disposición de todos los hallazgos.** Los cuatro tipos de búsqueda (críticos, defensores, bulos, causas) tienen una disposición por hallazgo: `publicado`, `en_espera` o `descartado`. La URL de un hallazgo publicado o en espera tiene que estar entre las fuentes del elemento.
13. **Etiquetas de los verificadores.** Tabla única de etiqueta a veredicto, igual para los cinco, comprobada por el sitio. Los elementos de bulos son `VERIFICADO`.
14. **Hechos compartidos.** Los elementos con la misma clave coinciden además en `matiz`, `cita` y `atribucion`. Las claves que empiezan por `votacion-` aparecen en las cinco fichas, como las encuestas. Una línea propia de un partido en encuestas está en las cinco fichas o en ninguna.
15. **Perfiles.** El periodo termina en el corte de las fichas (comprobado). Los documentos posteriores al corte esperan en `en_espera` sin publicarse. Una medida concreta aparece solo en propuestas, una por punto del documento, y empieza por «Propone» (comprobado); las acciones y las medidas en vigor son mensajes (editorial). Un documento sin dirección muestra «Documento sin dirección pública confirmada».
16. **Defensores de una candidatura conjunta.** Decisión del responsable del sitio (10 nov 2026), con la misma regla para los cinco: un defensor puede ser un político con nombre de un partido que concurre en candidatura conjunta con el partido en cuestión (por ejemplo, IU para el Frente Amplio y ERC para Podemos), y una cita que defiende la candidatura conjunta («el frente») cuenta como defensa del partido. Tras revisarlo, se mantuvo a Gabriel Rufián (ERC) como defensor de Podemos. Es una regla editorial.
17. **Metodología del sitio.** Reescritas varias frases para ajustarlas a estas reglas.

Límites abiertos a esta fecha:

- PSOE: no se han podido recoger las páginas de archivo de octubre (páginas 2 a 4) ni las de noviembre.
- Vox: la URL de un documento está pendiente.
