# LIVEPLAYER — Estado del desarrollo

| | |
|---|---|
| **Fase actual** | **FASE 4 — TARJETA DE SONIDO Y SALIDAS** |
| **Estado** | Implementada y probada. ⏳ **Pendiente de aprobación del usuario** |
| **Rama** | `feature/phase-4-audio-devices` (se fusionará en `main` cuando se apruebe) |
| **Fecha** | 2026-11-17 |
| **Fases anteriores** | Fase 1 ✅ · Fase 2 ✅ ([informe](docs/fases/FASE-2.md)) · Fase 3 ✅ ([informe](docs/fases/FASE-3.md)) |
| **Próxima fase** | FASE 5 — Setlists, Live Mode y Song Editor (con edición manual de las partes) · **no iniciada**; requiere aprobación expresa del plan |

## Objetivo de la fase 4 (acordado con el usuario)
El usuario toca con **una interfaz de 2 salidas**: por una va la banda y por la otra el click y los cues, y las dos entran a la consola externa, que reparte a PA e in-ears. Por eso la fase se simplificó: sin matriz de pistas contra salidas; el objetivo es que esas dos señales lleguen perfectas y seguras a la interfaz.

## Funcionalidades

Leyenda: ✅ Implementado y probado

| Funcionalidad | Estado | Evidencia |
|---|---|---|
| Elegir **controlador**: ASIO, Windows compartido, Windows exclusivo, Windows baja latencia | ✅ | E2E: la lista aparece con ASIO primero |
| **ASIO** incluido (SDK 2.3.4 de Steinberg bajo GPLv3, gratuito y compatible con la AGPLv3) | ✅ | Compila con ASIO; aparece como controlador. En este equipo no hay controladores ASIO instalados (lo instala el fabricante de cada interfaz) |
| Elegir **dispositivo**, **frecuencia** y **búfer**, con el retraso en milisegundos | ✅ | Pruebas del motor + E2E |
| Cambiar de frecuencia con una canción abierta: se convierte en segundo plano y **sigue en el mismo punto** | ✅ | E2E: modo exclusivo a 44,1 kHz, canción a 44,1 kHz, posición 30,00 s conservada |
| **Elegir qué salida lleva la banda y cuál el click**; nunca las dos en la misma (elegir la otra las intercambia); botón **Intercambiar** | ✅ | Prueba de audio (salidas cambiadas y en 3/4) + E2E |
| Modo de 4 canales y estéreo con el par de salidas elegido | ✅ | Prueba de audio |
| **Tono de prueba** por salida: 1 kHz, −18 dBFS, 2 s, sin clics, se para solo; funciona sin canción cargada | ✅ | Prueba de audio: −18,0 dBFS a 1000 Hz solo en la salida elegida |
| Cada botón de prueba indica qué suena por esa salida (Banda / Click y cues) | ✅ | E2E |
| **Todo se guarda**: dispositivo, frecuencia, búfer y salidas; se abre al arrancar la app | ✅ | E2E: al reabrir el dispositivo se mantienen las salidas elegidas |
| **Interfaz no conectada**: la recuerda, suena por la salida por defecto y la vuelve a abrir sola al conectarla | ✅ | Prueba del motor, prueba de Rust y E2E |
| **Interfaz desconectada en plena canción**: no se congela; pasa a la salida por defecto y vuelve al reconectarla | ✅ (lógica) | La detección se comprobó con un dispositivo inexistente; **falta probarlo desconectando una interfaz real** |
| Aviso en **todas las páginas** cuando se pierde, falta o vuelve la interfaz | ✅ | E2E: captura `09-device-missing.png` |
| **Estado en vivo**: carga del audio (con veredicto), cortes del motor, cortes del controlador, último aviso | ✅ | Captura `08-audio-settings.png` |
| Panel del controlador ASIO (botón cuando el controlador lo tiene) | ✅ | Sin interfaz ASIO en este equipo para probarlo |
| El Studio muestra por dónde va cada señal y enlaza a Audio Settings | ✅ | E2E |

## Pruebas realizadas (2026-11-17)

| Suite | Resultado |
|---|---|
| Typecheck | ✅ 0 errores |
| UI (Vitest) | ✅ 35/35 |
| Motor C++ (ABI v5, audio, enrutamiento, tono, sincronía, rendimiento, análisis) | ✅ 3/3 suites |
| Rust (`liveplayer-db` 13, `liveplayer-engine` 2, `liveplayer-desktop` 4) | ✅ |
| E2E sobre la app real | ✅ **73/73**, dos ejecuciones seguidas (silenciosa; carpeta de datos aislada) |

### Errores encontrados y corregidos durante la fase
- **Renombrar en la biblioteca** podía no guardar el nombre si Enter llegaba justo después de escribir: ahora lee el valor del campo. Lo destapó la prueba E2E.
- El aviso del modo dividido decía «salida izquierda a la consola, derecha a los in-ears»; ahora indica las salidas elegidas.
- La prueba E2E guarda una captura (`zz-failure.png`) cuando falla un paso.

## Limitaciones conocidas
- **ASIO necesita el controlador del fabricante** de la interfaz (Focusrite, Behringer, etc.). Sin él, la interfaz funciona igual por Windows (compartido o exclusivo).
- En **modo exclusivo** ninguna otra app puede sonar por esa tarjeta mientras LIVEPLAYER la usa (es lo normal de ese modo).
- Al cambiar de frecuencia con una canción abierta hay un silencio de 1 a 3 s mientras se convierte (no se hace en pleno servicio).
- Algunos controladores de Windows no informan sus cortes («no los informa»); los del motor siempre se cuentan.
- DirectSound se retiró de la lista: es antiguo, con más retraso, y duplicaba los dispositivos.

## Base de datos
Sin migraciones nuevas: el dispositivo (`audio.device`) y las salidas (`output.channels`) se guardan en `app_settings`.

## Próximo paso propuesto (requiere aprobación)
**FASE 5 — Setlists, Live Mode y Song Editor**, incluyendo la edición manual del inicio y el final de cada parte de la canción, como pidió el usuario.
