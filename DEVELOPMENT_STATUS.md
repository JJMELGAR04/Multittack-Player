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

## Funcionalidades

Leyenda: ✅ Implementado y probado · 🟡 Implementado, prueba parcial · ⏳ Pendiente

| Funcionalidad | Estado | Evidencia |
|---|---|---|
| Carga de WAV, AIFF, FLAC, OGG en segundo plano (varios archivos en paralelo) | ✅ | Prueba nativa + E2E: 5 pistas de 141 s cargadas en 3,8 s |
| Carga de **MP3** con corrección del retardo del codificador (etiqueta LAME) | 🟡 | El lector de la etiqueta pasa su prueba. **No se probó con un MP3 real**: no hay codificador MP3 en el equipo e instalar FFmpeg fue bloqueado. Ver «Pendiente de verificar». |
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

## Pruebas realizadas (2026-11-17, Windows 10 Home, i5-7200U 2 núcleos / 4 hilos, 24 GB)

| Suite | Comando | Resultado |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ 0 errores |
| UI (Vitest) | `npm test` | ✅ 19/19 |
| Motor C++: ABI pública | `ctest` → `engine_c_api` | ✅ |
| Motor C++: audio, sincronía, rendimiento y análisis | `ctest` → `engine_audio` | ✅ todas (resultados en la tabla de arriba) |
| Rust `liveplayer-engine` | `cargo test -p liveplayer-engine` | ✅ 2/2, incluida una reproducción real en silencio por la tarjeta de sonido |
| Rust `liveplayer-db` | `cargo test -p liveplayer-db` | ✅ 9/9 |
| Rust `liveplayer-desktop` | `cargo test -p liveplayer-desktop` | ✅ 1/1 |
| E2E sobre la app real | `npm run test:e2e -w apps/desktop` | ✅ **26/26** (con el volumen maestro a 0 para no hacer ruido) |

### Errores encontrados y corregidos durante la fase
1. La rejilla de compases juntaba los dos primeros compases cuando el compás empezaba casi en 0 → la intro no se separaba. Corregido.
2. El tiempo de los golpes salía ~65 ms adelantado (no se compensaba el centro de la ventana FFT). Ahora se usa una FFT corta para los golpes y se compensa. Error actual < 1 ms.
3. «Metrónomo» no se reconocía como pista de click (por la «ó»). Corregido; además «Cuerdas» ya no se confunde con una pista guía («cue»).
4. Macros `min`/`max` de `windows.h` (incluido por r8brain) rompían la compilación → `NOMINMAX`.

## Pendiente de verificar con material real (necesito tu ayuda)
1. **Escucha:** la calidad se midió de forma objetiva (tono exacto, nivel idéntico, sin clics, sin cortes). Falta tu prueba de oído con tus multitracks, sobre todo con el tempo cambiado.
2. **MP3 reales:** abrir una canción que tenga pistas MP3 (idealmente mezcladas con WAV) y comprobar que suenan en sincronía.
3. **Secciones en canciones reales:** la detección acierta en la canción sintética. En canciones reales los cortes suelen quedar bien y los nombres pueden confundirse (por ejemplo, una estrofa parecida al coro). Por eso se pueden corregir a mano.

## Limitaciones conocidas
- Se asume compás de 4/4 (la edición de compás llega con el Song Editor, fase 5).
- Un cambio de tempo mientras suena se oye unos ~150 ms después (es el margen de seguridad del render anticipado) y entra con un deslizamiento suave.
- El salto entre secciones es inmediato con fundido de 10 ms. El salto «al siguiente compás» para el modo en vivo es de la fase 5.
- Se usa siempre la salida predeterminada de Windows (modo compartido). Elegir dispositivo, ASIO y modo exclusivo es de la fase 4.
- WASAPI compartido no informa los fallos del driver («n/d» en el panel). Los cortes del render propio sí se cuentan.
- Todo el audio en RAM: una canción de 16 pistas de 5 min ocupa ~1,8 GB. Con 24 GB no hay problema; en tabletas (fase 6) habrá que leer desde disco.
- La biblioteca completa de canciones es de la fase 3. Por ahora: abrir pistas y lista de recientes.

## Dependencias nuevas (todas gratuitas)
- **Signalsmith Stretch 1.4.0** + **Signalsmith Linear 0.6.4** (MIT): cambio de tempo.
- **r8brain-free-src 6.5** (MIT): conversión de frecuencia. *Sample rate converter designed by Aleksey Vaneev of Voxengo.*
- **tauri-plugin-dialog 2.8.4** (MIT/Apache-2.0): diálogo nativo de abrir archivos.
- Decodificador MP3 de JUCE (ya incluido; AGPLv3).
- Herramienta de desarrollo: `tools/generate-test-song.mjs` (Node) genera la canción de prueba (`test-audio/`, ignorada por git).

## Próximo paso propuesto (requiere aprobación)
**FASE 3 — Mezclador**: volumen, mute y solo por pista, paneo, medidores de nivel, agrupación de pistas, biblioteca de canciones.
