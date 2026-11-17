# LIVEPLAYER — Arquitectura

## Visión general

```
┌──────────────────────────────────────────────────────────────┐
│ apps/desktop/src  (React + TypeScript + Tailwind)            │
│  UI únicamente. Nunca reproduce audio ni accede a SQLite.    │
│  src/lib/ipc/  ← único punto de contacto con el backend      │
└───────────────▲──────────────────────────────────────────────┘
                │ Tauri IPC (invoke / eventos), JSON tipado
┌───────────────┴──────────────────────────────────────────────┐
│ apps/desktop/src-tauri  (Rust, Tauri 2)                      │
│  Capa fina: comandos IPC, estado de la app, errores.         │
├──────────────────────────┬───────────────────────────────────┤
│ crates/liveplayer-engine │ crates/liveplayer-db              │
│  Wrapper Rust seguro     │  SQLite embebido (rusqlite        │
│  sobre la ABI en C       │  "bundled"), migraciones          │
└───────────▲──────────────┴───────────────────────────────────┘
            │ ABI en C  (engine/include/liveplayer_engine.h)
┌───────────┴──────────────────────────────────────────────────┐
│ engine/  (C++20 + JUCE 9) — librería estática                │
│  Motor de audio en tiempo real: carga/decodificación,        │
│  reproducción sincronizada, cambio de tempo, análisis        │
│  (fase 2); mezcla y enrutamiento (fases 3–4).                │
└──────────────────────────────────────────────────────────────┘
```

## Decisiones clave

| Decisión | Motivo |
|---|---|
| El motor se enlaza **dentro del proceso** como librería estática | No hay saltos entre procesos en el camino del audio; latencia de control mínima. |
| Frontera del motor = **ABI en C** (no C++, no `cxx`) | La misma librería se puede consumir desde Rust (escritorio), Kotlin/JNI (Android) y Swift (iPadOS). Sin tipos C++ ni JUCE en la frontera. |
| Ninguna excepción C++ cruza la ABI | Cada función `extern "C"` captura todo y devuelve `lp_result`. |
| JUCE se descarga a `third_party/JUCE` (git ignorado) o vía `FetchContent` | No versionamos 5000 archivos de terceros; la versión queda fijada en `engine/CMakeLists.txt`. |
| SQLite vive en Rust | El frontend no toca la base de datos; las migraciones son únicas y versionadas (`PRAGMA user_version`). |
| El motor se compila siempre optimizado (`RelWithDebInfo`) y con CRT `/MD` | El código de audio no debe ejecutarse sin optimizar; evita conflictos de CRT con Rust en MSVC. |

## Modelo de hilos

| Hilo | Quién | Reglas |
|---|---|---|
| **Principal / control** | Bucle de eventos de Tauri; también es el *message thread* de JUCE | Crea/destruye el motor. Los comandos Tauri **síncronos** se ejecutan aquí, por eso los comandos del motor no son `async`. `liveplayer-engine` rechaza llamadas desde otros hilos (`EngineError::WrongThread`). |
| **Audio** | Driver (WASAPI; ASIO/CoreAudio más adelante) vía JUCE → `Player` | Sin locks, sin asignaciones de memoria, sin E/S de disco, sin IPC. Solo copia bloques ya renderizados, suma pistas, aplica el volumen maestro suavizado y los fundidos. Lee órdenes de valores atómicos. |
| **Render** (+ 1 ayudante) | `Player::RenderThread` y `SongRenderer::Helper`, prioridad alta | Prepara el audio ~150 ms por delante en un anillo lock-free (`ChunkRing`, bloques de 256 muestras con metadatos). Aquí ocurre el cambio de tempo (Signalsmith Stretch), repartido en dos hilos. Un pico de CPU queda absorbido por el anillo en vez de causar un corte. |
| **Carga** | `SongLoader` (+ un hilo por archivo, hasta núcleos − 1) | Decodifica cada archivo (WAV/MP3/AIFF/FLAC/OGG), corrige el retardo de los MP3 y convierte a la frecuencia del dispositivo con r8brain. Todo el audio queda en RAM: **la reproducción nunca lee del disco**. |
| **Análisis** | `Engine::AnalysisJob`, prioridad baja | Formas de onda, BPM, inicio de compás y secciones. No compite con el audio. |

### Ruta del audio (fase 2)

```
archivos ──SongLoader──► SongData (RAM, frecuencia del dispositivo, inmutable)
                              │
               SongRenderer (hilo de render)
               ├─ tempo 1.0 → copia directa (bit a bit, sin procesar)
               └─ tempo ≠ 1 → Signalsmith Stretch por pista (mismo tamaño de bloque y semilla
                              en todas → sincronía exacta entre pistas)
                              │  cambio de modo = fundido cruzado de 21 ms; tempo con deslizamiento de ~120 ms
                         ChunkRing (lock-free, 2 canales por pista)
                              │
               Player (hilo de audio): suma + volumen maestro suavizado + fundidos de 10 ms
                              │
                         dispositivo de salida
```

- **Saltos** (secciones, clic en la forma de onda): el hilo de audio desvanece en 10 ms, descarta lo pre-renderizado (cada bloque lleva un número de "generación") y entra con otro fundido desde la nueva posición.
- **Cambio de canción**: se desconecta el callback (JUCE espera a que termine el que está en curso), se instala la nueva canción y se vuelve a conectar. La canción anterior se libera en el hilo de control, nunca en el de audio.
- **Posición**: cada bloque lleva la posición de la canción de su primera muestra y la velocidad, así que la posición mostrada es exacta también con el tempo cambiado.

En el escritorio, el hilo principal ejecuta el bucle de mensajes nativo (Win32 en Windows, NSApplication en macOS), que también despacha los mensajes internos de JUCE. Por eso JUCE puede usar el hilo principal sin un bucle propio.

## Contrato IPC

- Comandos en `apps/desktop/src-tauri/src/commands/`; tipos espejo en `apps/desktop/src/lib/ipc/types.ts` (camelCase en ambos lados).
- Errores siempre con forma `{ code, message }`.
- Cuando la UI se ejecuta fuera de Tauri (navegador), `backend.*` lanza `NativeUnavailableError`: **nunca se simulan datos**.

### Comandos

| Comando | Devuelve | Pasa por el motor C++ |
|---|---|---|
| `app_info` | versión, SO, arquitectura | no |
| `engine_info` | versión del motor, versión de JUCE, ABI, tipo de build | sí (funciones estáticas) |
| `engine_ping(value)` | `value + 1` y el tiempo de la llamada nativa | sí (instancia) |
| `audio_diagnostics` | sistemas de audio y dispositivos de salida (solo lectura) | sí (JUCE `AudioDeviceManager`) |
| `database_status` | ruta, versión del esquema, tablas, versión de SQLite | no |
| `studio_open_files(paths)` / `studio_open_song(songId)` | crea o reabre la canción en la base de datos y empieza a cargarla (las carpetas se expanden a sus archivos de audio) | sí |
| `studio_status` | progreso de carga, datos de la canción, BPM y secciones detectados | sí (también instala la canción recién cargada) |
| `studio_peaks(track)` | forma de onda en bytes crudos (`ArrayBuffer`), 100 valores por segundo | sí |
| `studio_detect_sections(bpm, downbeatOffsetSec)` | vuelve a detectar secciones con un tempo confirmado | sí |
| `studio_save_sections` / `studio_save_tempo` / `studio_get_song` / `studio_recent_songs` | persistencia de la canción | no |
| `transport_play/pause/stop/seek/set_master_gain/set_tempo_ratio/state` | transporte | sí |
| `output_info` | dispositivo, frecuencia, buffer y latencia de salida | sí |

Los comandos son síncronos y cortos: el trabajo pesado (decodificar, analizar) ocurre en hilos del motor y la UI consulta `studio_status` (cada 250 ms mientras hay trabajo) y `transport_state` (25 veces por segundo; el cursor se interpola entre lecturas).

## Código específico de cada plataforma

| Lugar | Qué es específico |
|---|---|
| `engine/CMakeLists.txt` | Flags `JUCE_WASAPI`, `JUCE_DIRECTSOUND`, `JUCE_ASIO` (Windows). CoreAudio se activa automáticamente en Apple. |
| `crates/liveplayer-engine/build.rs` | Librerías y frameworks del sistema que se enlazan en cada SO. |
| `apps/desktop/src-tauri/tauri.conf.json` | Ventana e iconos del escritorio. |

Todo lo demás (UI, IPC, base de datos y lógica del motor) es independiente de la plataforma.
