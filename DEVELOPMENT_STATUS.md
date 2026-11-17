# LIVEPLAYER — Estado del desarrollo

| | |
|---|---|
| **Fase actual** | **FASE 2 — REPRODUCCIÓN REAL, TEMPO Y SECCIONES** |
| **Estado** | Implementada y probada. ⏳ **Pendiente de aprobación del usuario** |
| **Rama** | `feature/phase-2-playback` (se fusionará en `main` cuando se apruebe) |
| **Fecha** | 2026-11-17 |
| **Fase anterior** | Fase 1 — Foundation: ✅ aprobada y fusionada en `main` (2026-11-16) |
| **Próxima fase** | FASE 3 — Mezclador (**no iniciada**; requiere aprobación expresa) |

## Objetivo de la fase 2 (ampliado a petición del usuario)
Reproducción multitrack real y sincronizada con calidad profesional, más:
- lector de **MP3** además de WAV;
- **cambio de BPM** que afecte a todas las pistas, sin cambiar el tono;
- **detección de las partes de la canción** (intro, estrofa, coro, puente, final…) para saltar a cualquiera y tocar desde ahí.

Criterio del usuario: *todo debe sonar profesional*, sin cortes, clics ni artefactos evitables.

### Ampliación 2 (pedida al probar con una canción real, 2026-11-17)
- **Importar un zip**: leer su contenido y preguntar título, BPM y compás.
- **Identificar archivos**: si un nombre no dice qué es (p. ej. «llmmD»), mostrarlo, dejar escucharlo solo y preguntar qué es; tomarlo como tal («Batería»).
- **Dos señales de salida**: instrumentos por un lado (PA) y click + cues por otro (solo la banda). *Se adelanta una parte de la fase 4 a petición del usuario.*

### Ampliación 3 — nuevo diseño (referencias del usuario en `Visualizacion/`, 2026-11-17)
- Navegación principal en una **barra superior**.
- Multitrack Studio con aspecto de estación de trabajo: barra de transporte con reloj digital y compás/tiempo, vista de pistas (cabecera de color por instrumento con M/S y medidor, forma de onda sobre el color de la pista, regla de tiempo + compases, carril de partes con marcadores, cursor rojo) y **mezclador abajo** (fader, medidor, M/S, etiqueta de color por pista; tiras de PA y Banda). Paneles en pestañas: Mezclador, Partes, Tempo, Salidas, Pistas, Motor.
- Se toman las ideas de distribución de las imágenes (REAPER y una grabadora multipista en vivo) sin copiar su aspecto.

## Funcionalidades

Leyenda: ✅ Implementado y probado · 🟡 Implementado, prueba parcial · ⏳ Pendiente

| Funcionalidad | Estado | Evidencia |
|---|---|---|
| Carga de WAV, AIFF, FLAC, OGG en segundo plano (varios archivos en paralelo) | ✅ | Prueba nativa + E2E: 5 pistas de 141 s cargadas en 3,8 s |
| Carga de **MP3** con corrección del retardo del codificador (etiqueta LAME) | ✅ | **Verificado con FFmpeg** (instalado por el usuario): impulsos codificados con LAME a 44,1/48 kHz y 128/192/320 kbps salen en la muestra exacta; las pistas de *Ancient* coinciden con la decodificación de FFmpeg con **0 muestras de desfase** y la misma longitud. |
| Todo el audio en RAM y convertido a la frecuencia del dispositivo (r8brain, linear phase) | ✅ | SNR del conversor: **150,8 dB** (inaudible). La reproducción nunca lee del disco. |
| Reloj común y sincronía exacta entre pistas | ✅ | Dos pistas iguales estiradas dan salida **idéntica muestra a muestra** (diferencia 0,0) |
| Salida de audio real (WASAPI, dispositivo predeterminado) | ✅ | E2E sobre los auriculares del equipo, 48 kHz / 480 muestras |
| Play / Pausa / Stop / Volver al inicio / Saltar, con fundidos sin clics (10 ms) | ✅ | Prueba nativa con dispositivo simulado + E2E |
| Volumen maestro con suavizado (sin escalones) | ✅ | Fader en dB (−∞ a +6 dB) |
| **Cambio de tempo** sin cambiar el tono (Signalsmith Stretch, preset de alta calidad) | ✅ | A 1,20x: frecuencia **440,00 Hz** (original 440) y nivel idéntico (−18,06 dB) |
| Tempo 1,0 = audio original **sin procesar** (bit a bit) | ✅ | Prueba nativa |
| Transiciones de tempo sin clics (deslizamiento ~120 ms + fundido cruzado de 21 ms) | ✅ | Salto máximo entre muestras 0,0102 (límite de la propia onda: 0,0103) |
| Precisión de la posición con tempo cambiado | ✅ | Error máximo **0,37 ms** |
| Render anticipado (~150 ms) repartido en dos hilos | ✅ | 16 pistas estiradas: **~28 % de un núcleo** (3,5x más rápido que el tiempo real). Sin estirar: 0,1 %. |
| Detección de BPM (usa la pista de click si existe) | ✅ | Canción de prueba: 96,00 BPM con y sin click |
| Detección del inicio de compás (4/4) | ✅ | Error < 1 ms en la canción de prueba |
| **Detección de secciones** con nombres en español | 🟡 | Canción de prueba: **8/8 secciones y 8/8 tipos correctos**. **Falta probar con canciones reales** (la canción de prueba es sintética). |
| Edición de secciones: renombrar, cambiar tipo, mover (ajuste al compás), añadir, borrar, volver a detectar | ✅ | Pruebas de UI y de base de datos |
| Saltar a una sección con un clic, o con las teclas 1–9 | ✅ | E2E: clic en «Coro 2» → 70,4 s y sigue sonando |
| Corrección del BPM: ÷2, ×2, escribirlo o Tap tempo | ✅ | Pruebas unitarias |
| Forma de onda de la mezcla (coloreada por sección) y de cada pista; clic para saltar | ✅ | Capturas E2E |
| Abrir pistas: diálogo, arrastrar archivos o **carpeta**, canciones recientes | ✅ | E2E abre la carpeta de la canción |
| Persistencia (canción, pistas, BPM, tempo elegido, secciones) en SQLite | ✅ | Migración 2 + 5 pruebas de base de datos |
| Panel de diagnóstico: carga de audio y de render, cortes, latencia, memoria | ✅ | E2E: **0 cortes** en toda la prueba |
| Atajos: Espacio, Esc, Inicio, 1–9 | ✅ | |
| **Importar zip** (extrae solo audio, ignora basura de macOS, protegido contra *zip-slip* y *zip bombs*) | ✅ | Prueba Rust + E2E con zip de 5 pistas |
| Diálogo de importación: título y BPM sugeridos desde el nombre, compás, «¿qué es?» por archivo | ✅ | E2E: «llmmD.wav» → elegido «Batería» → guardado como batería |
| Escuchar cada archivo solo antes de guardar (rampa de 10 ms, sin clics) | ✅ | Prueba nativa + E2E |
| Reconocimiento automático de pistas por nombre (inglés/español) | ✅ | 26 nombres típicos en la prueba |
| Reimportar el mismo zip abre la canción guardada (sin duplicar) | ✅ | E2E |
| BPM dado por el usuario: se usa tal cual y solo se busca dónde empieza el compás | ✅ | E2E: secciones correctas con BPM 96 introducido |
| Compases 2/4, 3/4, 4/4, 5/4, 6/8, 12/8 (rejilla de compases y secciones) | ✅ | Pruebas de UI y de base de datos |
| **Bus principal (instrumentos) y bus de monitoreo (click + cues)** | ✅ | Prueba nativa: salida exacta por canal en cada modo |
| Modos de salida: ensayo (todo en 1-2), en vivo 2 salidas (instr. → 1, click → 2), en vivo 4 salidas (1-2 / 3-4) | ✅ | Prueba nativa + E2E. El de 4 salidas solo se ofrece si el dispositivo tiene 4+. |
| Volumen de click/cues separado; modo y volumen se guardan | ✅ | |
| Cambiar después qué es una pista (su salida sigue al rol) | ✅ | Prueba de base de datos |
| **Ajuste automático de nivel** por canción (evita saturar al sumar stems) | ✅ | *Ancient*: la suma llegaba a +6,1 dBFS (0,53 % de muestras saturadas); ahora queda a −1 dBFS |
| **Nuevo diseño del Studio** (barra superior de navegación, vista de pistas, mezclador inferior) | ✅ | Capturas E2E `03b-studio-playing.png` |
| **Medidores de nivel** reales por pista y por bus (pico con caída y retención) | ✅ | Prueba nativa (valores exactos) + E2E (se mueven al reproducir) |
| **Arrastrar pistas** desde la agarradera ⠿ de su cabecera para cambiar el orden (el mezclador sigue el mismo orden; se guarda con la canción) | ✅ | Prueba de base de datos + E2E (arrastre real de «Lead» a la primera fila) |
| **Arrastrar canales del mezclador** a izquierda o derecha (mismo orden que las pistas: mover en una vista mueve en la otra) | ✅ | E2E (arrastre real de «Keys» al primer lugar) |
| Orden por defecto: **Click primero, Cues segundo**, luego la banda (también en canciones ya guardadas) | ✅ | Migración 4 + E2E |
| Diseño pulido: barra del Studio en una fila, rejilla de compases y líneas de partes en las pistas, parte actual resaltada, faders de consola | ✅ | Captura E2E |
| Volumen, mute (M) y solo (S) por pista | ✅ | E2E: M silencia solo esa pista. *Aún no se guardan por canción: eso llega con el mezclador completo (fase 3), junto con el paneo.* |
| **Limitador de seguridad** por bus (−0,5 dBFS, 1 ms de anticipación, sin escalones) | ✅ | Con picos de +6 dBFS: salida −0,50 dBFS exactos; por debajo del techo el audio pasa bit a bit |

## Pruebas realizadas (2026-11-17, Windows 10 Home, i5-7200U 2 núcleos / 4 hilos, 24 GB)

| Suite | Comando | Resultado |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ 0 errores |
| UI (Vitest) | `npm test` | ✅ 27/27 |
| Motor C++: ABI pública | `ctest` → `engine_c_api` | ✅ |
| Motor C++: audio, sincronía, rendimiento y análisis | `ctest` → `engine_audio` | ✅ todas (resultados en la tabla de arriba) |
| Rust `liveplayer-engine` | `cargo test -p liveplayer-engine` | ✅ 2/2, incluida una reproducción real en silencio por la tarjeta de sonido |
| Rust `liveplayer-db` | `cargo test -p liveplayer-db` | ✅ 11/11 |
| Rust `liveplayer-desktop` | `cargo test -p liveplayer-desktop` | ✅ 4/4 (zip, reconocimiento de pistas, título/BPM) |
| E2E sobre la app real | `npm run test:e2e -w apps/desktop` | ✅ **47/47** (silenciosa; usa una carpeta de datos aislada, no toca tu biblioteca) |

### Errores encontrados y corregidos durante la fase
- (diseño) Los medidores se reiniciaban al leerlos y con dos lectores (UI + prueba) perdían golpes cortos → ahora mantienen el pico con caída de ~300 ms y la lectura no los borra.
- (ampliación 2) Umbral de secciones inflado por silencios → mediana/MAD. Suma de stems saturando → ajuste de nivel + limitador. `envPrefix` de Vite con «*» nunca coincidía. Prueba E2E desactualizada (ABI v3).
1. La rejilla de compases juntaba los dos primeros compases cuando el compás empezaba casi en 0 → la intro no se separaba. Corregido.
2. El tiempo de los golpes salía ~65 ms adelantado (no se compensaba el centro de la ventana FFT). Ahora se usa una FFT corta para los golpes y se compensa. Error actual < 1 ms.
3. «Metrónomo» no se reconocía como pista de click (por la «ó»). Corregido; además «Cuerdas» ya no se confunde con una pista guía («cue»).
4. Macros `min`/`max` de `windows.h` (incluido por r8brain) rompían la compilación → `NOMINMAX`.

## Prueba con una canción real: *Ancient* (7 MP3, LAME 3.100, 44,1 kHz, 250 s)
Analizada con el motor (`liveplayer_inspect`):
- Las 7 pistas quedan con la duración exacta declarada en su etiqueta LAME (250,000 s / 249,945 s): el recorte del retardo MP3 se aplica. Todas tienen el mismo retardo (576), así que están alineadas entre sí.
- Tempo: **96 BPM** desde la pista de click, confianza 100 %.
- Saturación detectada y corregida: la suma de instrumentos llegaba a +6,1 dBFS.
- Secciones: la primera versión fallaba (una «estrofa» de 172 s) porque el silencio final inflaba el umbral. Corregido con estadística robusta: cortes en 8,75 / 28,75 / 66,25 / 121,25 / 151,25 / 181,25 / 196,25 s (todos en línea de compás). **Falta que confirmes la estructura real** escuchándola; los nombres son lo menos fiable.

## Pendiente de verificar con material real (necesito tu ayuda)
1. **Escucha:** la calidad se midió de forma objetiva (tono exacto, nivel idéntico, sin clics, sin cortes). Falta tu prueba de oído con tus multitracks, sobre todo con el tempo cambiado.
2. **Secciones en canciones reales:** la detección acierta en la canción sintética. En canciones reales los cortes suelen quedar bien y los nombres pueden confundirse (por ejemplo, una estrofa parecida al coro). Por eso se pueden corregir a mano.

## Limitaciones conocidas
- Compases soportados: 2/4, 3/4, 4/4, 5/4, 6/8, 12/8 (en 6/8 y 12/8 el BPM cuenta negras con puntillo). Cambios de compás dentro de una canción: fase 5.
- Un cambio de tempo mientras suena se oye unos ~150 ms después (es el margen de seguridad del render anticipado) y entra con un deslizamiento suave.
- El salto entre secciones es inmediato con fundido de 10 ms. El salto «al siguiente compás» para el modo en vivo es de la fase 5.
- Se usa la salida predeterminada de Windows (modo compartido, hasta 4 canales). Elegir dispositivo, ASIO, modo exclusivo y asignar cualquier canal es de la fase 4.
- WASAPI compartido no informa los fallos del driver («n/d» en el panel). Los cortes del render propio sí se cuentan.
- Todo el audio en RAM: una canción de 16 pistas de 5 min ocupa ~1,8 GB. Con 24 GB no hay problema; en tabletas (fase 6) habrá que leer desde disco.
- La biblioteca completa de canciones es de la fase 3. Por ahora: abrir pistas y lista de recientes.

## Dependencias nuevas (todas gratuitas)
- **Signalsmith Stretch 1.4.0** + **Signalsmith Linear 0.6.4** (MIT): cambio de tempo.
- **r8brain-free-src 6.5** (MIT): conversión de frecuencia. *Sample rate converter designed by Aleksey Vaneev of Voxengo.*
- **tauri-plugin-dialog 2.8.4** (MIT/Apache-2.0): diálogo nativo de abrir archivos.
- **zip 9.6** (MIT, crate de Rust, solo descompresión).
- Decodificador MP3 de JUCE (ya incluido; AGPLv3).
- Herramienta de desarrollo: `tools/generate-test-song.mjs` (Node) genera la canción de prueba (`test-audio/`, ignorada por git).

## Próximo paso propuesto (requiere aprobación)
**FASE 3 — Mezclador**: volumen, mute y solo por pista, paneo, medidores de nivel, agrupación de pistas, biblioteca de canciones.
