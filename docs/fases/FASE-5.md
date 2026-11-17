# LIVEPLAYER — Informe de la fase 5

| | |
|---|---|
| **Fase actual** | **FASE 5 — SONG EDITOR, SETLISTS Y LIVE MODE** |
| **Estado** | ✅ **Aprobada por el usuario (2026-11-17) y fusionada en `main`** |
| **Rama** | `feature/phase-5-live` (fusionada en `main`) |
| **Fecha** | 2026-11-17 |
| **Fases anteriores** | Fase 1 ✅ · Fase 2 ✅ ([informe](docs/fases/FASE-2.md)) · Fase 3 ✅ ([informe](docs/fases/FASE-3.md)) · Fase 4 ✅ ([informe](docs/fases/FASE-4.md)) |
| **Próxima fase** | FASE 6 — Estabilización y multiplataforma · **no iniciada**; requiere aprobación expresa del plan |

## Objetivo de la fase 5 (acordado con el usuario)
- **Song Editor**: el usuario decide a mano dónde empieza y termina cada parte de la canción. La detección automática es solo el punto de partida.
- **Setlists** para cada servicio o concierto.
- **Live Mode**: «casi el mismo Multitrack Studio» pero para tocar. Eliges el setlist y la canción tú (sin pedales: se usa la computadora). **Nunca pasa sola a la siguiente.**
- **Mezcla en vivo, opción B**: los cambios de volumen en Live son solo para ese momento. Se guardan con «Guardar mezcla» y se deshacen con «Volver a la guardada».
- **General Settings**: atajos de teclado y copia de seguridad.

## Cambios pedidos por el usuario tras probar la fase (incluidos)
- **Cambio de tono en todo el sistema**, lo más profesional posible:
  - medio tono arriba o abajo cada vez (±6), sin cambiar el tempo;
  - solo las pistas de música: **el click y los cues no se tocan**;
  - las voces cantadas conservan sus formantes, así que no suenan "de ardilla";
  - los platos y el ruido conservan su textura (límite de tonalidad a 8 kHz).
- **El tono se usa así en cada pantalla:**
  - al **importar** se pregunta el **tono original**;
  - en **Multitrack Studio** el tono se guarda con la canción;
  - en **Live** se guarda **para esa canción en ese setlist** (y también se puede elegir en Setlists).
- **Importar se hace en *Songs*** (botón o arrastrando el zip o la carpeta a la ventana). El **Multitrack Studio ya no tiene "Abrir pistas"**: tiene un **buscador** de canciones de la biblioteca.
- **Live Mode muestra las pistas** como el Multitrack Studio. Se mantiene la lista de canciones al lado; el mezclador se puede plegar y se recuerda.
- **Canciones duplicadas al importar**: corregido. El botón «Guardar canción» se bloquea mientras guarda, y el sistema nunca crea una segunda copia de los mismos archivos o del mismo zip.
- **Equipos menos potentes**:
  - la decodificación al cargar corre con prioridad baja, para que la interfaz no se trabe;
  - la revisión de la lista de tarjetas de sonido es mucho menos frecuente (cada 5 s; cada 2 s solo si se espera a una interfaz);
  - la barra del Studio cabe en pantallas de 1280 px.

## Funcionalidades

Leyenda: ✅ Implementado y probado

| Funcionalidad | Estado | Evidencia |
|---|---|---|
| **Song Editor**: forma de onda con zoom (hasta 32×), regla de compases y partes de colores | ✅ | E2E + captura `10-song-editor.png` |
| Arrastrar el inicio de una parte, con **ajuste al compás** (o libre) | ✅ | E2E: 10,00 → 20,00 s, cae en línea de compás y se guarda |
| **Marcar una parte con una tecla (M) mientras suena**, eligiendo antes de qué tipo es | ✅ | E2E: «Interludio» marcado en el compás |
| Cambiar tipo y nombre, mover el inicio ±1 tiempo, borrar (se une a la anterior), escuchar desde una parte, **repetirla en bucle** | ✅ | Pruebas de UI + E2E (bucle) |
| **Deshacer y rehacer** (Ctrl+Z / Ctrl+Y) y **guardado automático** | ✅ | E2E |
| Datos de la canción: título, artista, **tonalidad**, compás, notas (se ven en Live) | ✅ | Prueba de base de datos + E2E |
| **Setlists**: nombre, fecha, lugar y notas; agregar canciones de la biblioteca (una canción puede repetirse); **ordenar arrastrando**; notas por canción; duración total; duplicar; borrar; guardado automático | ✅ | Prueba de base de datos + E2E + captura `11-setlists.png` |
| **Live Mode**: elegir setlist; lista de canciones con tono, BPM, duración y notas; canción, parte actual y siguiente en grande; reloj y compás | ✅ | E2E + captura `12-live.png` |
| **Salto a una parte al terminar el compás** (o al terminar la parte, o inmediato), **sin cortes**: el click no pierde el pulso | ✅ | Prueba de audio: el fundido empieza en la muestra exacta del compás y llega en fase al destino; con el tempo cambiado el espaciado del click se mantiene (error 0,06 ms). E2E: salto programado en el compás 2,499 s → 50 s |
| **Repetir una parte (bucle)** sin cortes; Esc cancela salto o bucle | ✅ | Prueba de audio (5 repeticiones) + E2E |
| **Siguiente canción preparada** en segundo plano: al elegirla empieza al instante | ✅ | Prueba de Rust + E2E: lista en 63 ms |
| Cambiar de canción mientras suena **pide confirmación**; detener pide pulsar dos veces | ✅ | E2E |
| **Bloqueo** contra toques accidentales (canciones, detener y mezclador) | ✅ | E2E |
| **Mezcla en vivo solo para el momento** (opción B), con «Guardar mezcla» y «Volver a la guardada» | ✅ | E2E: la mezcla guardada no cambia hasta pulsar «Guardar mezcla» |
| Atajos en Live: Espacio, ← →, L, Esc, ↑ ↓ + Intro | ✅ | E2E + pruebas de UI |
| **General Settings**: cambiar atajos (si eliges una tecla ya usada se intercambian), volver a los de fábrica | ✅ | E2E |
| **Copia de seguridad**: todo en un .zip (audio, mezcla, partes, tempo, datos y setlists); restaurar agrega sin duplicar ni borrar | ✅ | Prueba de Rust (exportar → importar en otra biblioteca) + E2E |
| Biblioteca: artista y tonalidad visibles, búsqueda también por artista, botón «Editar partes» | ✅ | |
| **Cambio de tono** (±6 semitonos): música transpuesta; click y cues intactos; voces con formantes conservados | ✅ | Prueba de audio: la música pasa de 440 a ~494 Hz (+2) y el click sigue en 1000 Hz, con −0,07 dB de cambio de nivel; en el tono original vuelve al audio intacto. E2E: sin cortes al tocar transpuesta |
| Tono en Studio (se guarda con la canción) y en Live (se guarda en el setlist); el control muestra el tono que suena («D → E») | ✅ | E2E |
| Tono original preguntado al importar | ✅ | E2E: se guarda «D» |
| Importar en *Songs*; buscador de canciones en Multitrack Studio | ✅ | E2E |
| Live con las pistas en pantalla | ✅ | E2E + captura `12-live.png` |
| Doble clic en «Guardar canción» → una sola canción | ✅ | Prueba de UI + E2E |

## Pruebas realizadas (2026-11-17)

| Suite | Resultado |
|---|---|
| Typecheck | ✅ 0 errores |
| UI (Vitest) | ✅ 44/44 |
| Motor C++ (ABI v7, cambio de tono, saltos y bucles sin cortes, enrutamiento, tono de prueba, sincronía, rendimiento, análisis) | ✅ 3/3 suites |
| Rust (`liveplayer-db` 15, `liveplayer-engine` 2, `liveplayer-desktop` 5) | ✅ |
| E2E sobre la app real | ✅ **106/106**, tres ejecuciones seguidas (silenciosa; carpeta de datos aislada) |

### Errores encontrados y corregidos durante la fase
- **El Song Editor recargaba la canción al abrirse** porque decidía antes de saber cuál estaba cargada. Eso devolvía la posición a 0 y estropeaba la primera edición. Ahora espera a conocer el estado.
- **El editor podía guardar una lista de partes vacía** encima de la detección automática si se abría antes de que terminara. Ahora espera a la detección.
- **Arrastres** (bordes de partes y filas del setlist) que llegaban muy seguidos se perdían. Ahora se leen de una referencia, no del estado de React.
- **Renombrar en la biblioteca**: Intro ahora guarda directamente, sin depender de que el campo tenga el foco.
- Bucle: si un bloque empezaba justo en el final del bucle, dejaba de repetirse. Corregido y cubierto por la prueba.
- Restaurar la misma copia dos veces duplicaba el setlist. Ahora se salta.

## Limitaciones conocidas
- Las partes se definen por su **inicio**: cada una termina donde empieza la siguiente (la última, al final de la canción).
- El tempo (BPM) se cambia en Multitrack Studio › Tempo; el Song Editor lo muestra.
- La siguiente canción preparada ocupa memoria. Si las dos canciones juntas pasan de la mitad de la RAM no se prepara y al elegirla tarda unos segundos (Live lo indica).
- Los atajos funcionan en Live y en el Song Editor; Multitrack Studio mantiene los suyos (Espacio, Esc, Inicio, 1-9).
- Restaurar una copia agrega canciones; si una canción ya existe (mismo título y mismas pistas) no se toca.
- Cambiar el tono hace que la canción pase por el time-stretch (como al cambiar el tempo): usa más CPU. En equipos muy modestos con muchas pistas conviene probarlo antes del servicio. Un **modo económico** y la **caché de canciones decodificadas** están propuestos para la fase 6 (rendimiento en equipos modestos).
- Las canciones duplicadas que ya existían antes de esta corrección se pueden quitar con la papelera en *Songs*: es seguro, los archivos que usa la otra copia no se borran.

## Base de datos
- Migración 7: `songs.artist`, `songs.song_key`, `songs.notes`; tablas `setlists` y `setlist_items`. Si se borra una canción de la biblioteca, sale de todos los setlists.
- Migración 8: `songs.transpose` (tono de la canción) y `setlist_items.transpose` (tono para ese setlist; vacío = el de la canción).

## Próximo paso propuesto (requiere aprobación)
**FASE 6 — Estabilización y multiplataforma**: pruebas largas de estabilidad (horas de reproducción), rendimiento en equipos modestos, macOS y evaluación de tablets.
