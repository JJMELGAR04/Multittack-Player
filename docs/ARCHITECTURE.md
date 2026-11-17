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
│  Motor de audio en tiempo real: dispositivos, reloj,         │
│  reproducción, mezcla, enrutamiento (fases 2–4).             │
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
| **Audio** (fase 2+) | Driver (WASAPI/ASIO/CoreAudio) vía JUCE | Sin locks, sin asignaciones de memoria, sin E/S de disco, sin IPC. Se comunica con el control mediante colas lock-free y valores atómicos. |
| **Lectura de disco** (fase 2+) | Hilo dedicado del motor | Precarga/decodifica audio en buffers antes de que el hilo de audio los necesite. |
| **Pool async de Tauri** | Comandos `async` | Trabajo largo que no toca el motor (importación, análisis de waveform, etc.). |

En el escritorio, el hilo principal ejecuta el bucle de mensajes nativo (Win32 en Windows, NSApplication en macOS), que también despacha los mensajes internos de JUCE. Por eso JUCE puede usar el hilo principal sin un bucle propio.

## Contrato IPC

- Comandos en `apps/desktop/src-tauri/src/commands/`; tipos espejo en `apps/desktop/src/lib/ipc/types.ts` (camelCase en ambos lados).
- Errores siempre con forma `{ code, message }`.
- Cuando la UI se ejecuta fuera de Tauri (navegador), `backend.*` lanza `NativeUnavailableError`: **nunca se simulan datos**.

### Comandos de la fase 1

| Comando | Devuelve | Pasa por el motor C++ |
|---|---|---|
| `app_info` | versión, SO, arquitectura | no |
| `engine_info` | versión del motor, versión de JUCE, ABI, tipo de build | sí (funciones estáticas) |
| `engine_ping(value)` | `value + 1` y el tiempo de la llamada nativa | sí (instancia) |
| `audio_diagnostics` | sistemas de audio y dispositivos de salida (solo lectura) | sí (JUCE `AudioDeviceManager`) |
| `database_status` | ruta, versión del esquema, tablas, versión de SQLite | no |

## Código específico de cada plataforma

| Lugar | Qué es específico |
|---|---|
| `engine/CMakeLists.txt` | Flags `JUCE_WASAPI`, `JUCE_DIRECTSOUND`, `JUCE_ASIO` (Windows). CoreAudio se activa automáticamente en Apple. |
| `crates/liveplayer-engine/build.rs` | Librerías y frameworks del sistema que se enlazan en cada SO. |
| `apps/desktop/src-tauri/tauri.conf.json` | Ventana e iconos del escritorio. |

Todo lo demás (UI, IPC, base de datos y lógica del motor) es independiente de la plataforma.
