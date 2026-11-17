# LIVEPLAYER — Estado del desarrollo

| | |
|---|---|
| **Fase actual** | **FASE 3 — MEZCLADOR GUARDADO Y BIBLIOTECA DE CANCIONES** |
| **Estado** | Implementada y probada. ⏳ **Pendiente de aprobación del usuario** |
| **Rama** | `feature/phase-3-mixer-library` (se fusionará en `main` cuando se apruebe) |
| **Fecha** | 2026-11-17 |
| **Fases anteriores** | Fase 1 ✅ · Fase 2 ✅ (informe completo en [`docs/fases/FASE-2.md`](docs/fases/FASE-2.md)) |
| **Próxima fase** | FASE 4 — Enrutamiento y dispositivos (**no iniciada**; requiere aprobación expresa del plan) |

## Objetivo de la fase 3 (acordado con el usuario)
1. Guardar con cada canción el **volumen, mute y solo** de cada pista.
2. Faders hasta **+8,0 dB**.
3. **Escribir el volumen** con doble clic en el número (decimales).
4. **Biblioteca de canciones** en *Songs*.

Fuera de la fase, por decisión del usuario:
- **Sin paneo ni agrupación de pistas**: cada pista es individual.
- **Lectura de la pista de cues** (reconocimiento de voz): pospuesta. Las partes de la canción las definirá el usuario a mano en el **Song Editor** (fase 5), con la detección automática como punto de partida.

## Funcionalidades

Leyenda: ✅ Implementado y probado

| Funcionalidad | Estado | Evidencia |
|---|---|---|
| Volumen, mute y solo de cada pista **se guardan con la canción** y se restauran al abrirla | ✅ | Prueba de base de datos + E2E (−6,5 dB y mute guardados; vuelven al reabrir desde la biblioteca) |
| Faders de pista, PA y banda hasta **+8,0 dB** (el motor admite hasta +12 dB de margen; el limitador protege la salida) | ✅ | E2E: escribir +12 queda en +8,0 |
| **Curva de fader tipo consola**: el 0 dB está a la mitad de la tira (mitad superior 0…+8 dB, inferior −60…0 dB, con más recorrido en −20…0), escala de dB junto al fader, retén en 0 dB; rueda y flechas mueven 0,5 dB, Re Pág/Av Pág 3 dB | ✅ | Prueba de UI (curva ida y vuelta, monótona) + E2E (0 dB en 500/1000) |
| **Doble clic en el número de dB para escribirlo**: acepta coma o punto, signo, «-inf»; Enter aplica, Esc cancela | ✅ | 11 casos en prueba de UI + E2E |
| Volumen del PA guardado (ya no vuelve a 0 dB al reiniciar) | ✅ | |
| **Biblioteca** en *Songs*: título, BPM (de reproducción y original), compás, duración, pistas, partes, última apertura | ✅ | Captura E2E `07-library.png` |
| Buscar (sin importar tildes ni mayúsculas) y ordenar (título, recientes, agregadas, BPM, duración) | ✅ | Pruebas de UI + E2E |
| Abrir (botón o doble clic en la fila) → Multitrack Studio con la canción | ✅ | E2E |
| Renombrar desde la biblioteca | ✅ | E2E |
| **Quitar** de la biblioteca: borra los archivos que LIVEPLAYER extrajo de un zip; **nunca** borra archivos que el usuario eligió de sus carpetas ni el zip original | ✅ | E2E comprueba ambas cosas en disco |
| «Importar canción» desde la biblioteca (abre el selector en el Studio) | ✅ | |

## Pruebas realizadas (2026-11-17)

| Suite | Resultado |
|---|---|
| Typecheck | ✅ 0 errores |
| UI (Vitest) | ✅ 31/31 |
| Motor C++ (ABI, audio, sincronía, rendimiento, análisis) | ✅ 3/3 suites |
| Rust (`liveplayer-db` 13, `liveplayer-engine` 2, `liveplayer-desktop` 4) | ✅ |
| E2E sobre la app real | ✅ **58/58** (silenciosa; carpeta de datos aislada) |

### Errores encontrados y corregidos durante la fase
- La prueba E2E intentaba escribir en el mezclador mientras la canción reabierta aún cargaba → ahora espera a que el mezclador esté listo (fallo de la prueba, no de la app).

## Limitaciones conocidas
- Los cambios del mezclador se guardan 0,3 s después del último movimiento (para no escribir en disco con cada paso del fader). Si se cierra la app en ese instante, se pierde solo el último ajuste.
- La biblioteca todavía no tiene tonalidad, notas ni etiquetas: llegan con el **Song Editor** (fase 5).
- Quitar una canción no borra los archivos que el usuario eligió de sus carpetas (a propósito).

## Base de datos
Migración 6: `song_tracks.volume_db`, `muted`, `soloed`; `songs.duration_sec`.

## Próximo paso propuesto (requiere aprobación)
**FASE 4 — Enrutamiento y dispositivos**: elegir la tarjeta de sonido y su modo (WASAPI compartido/exclusivo, ASIO), frecuencia y tamaño de búfer, y asignar cualquier pista o bus a cualquier salida física de la interfaz.
