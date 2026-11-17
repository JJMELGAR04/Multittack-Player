# LIVEPLAYER — Estado del desarrollo

| | |
|---|---|
| **Fase actual** | **FASE 1 — FOUNDATION** |
| **Estado** | ✅ **Aprobada por el usuario (2026-11-16)** |
| **Rama** | `feature/phase-1-foundation`, fusionada en `main` |
| **Fecha** | 2026-11-16 |
| **Próxima fase** | FASE 2 — Real Audio Playback (**no iniciada**; requiere aprobación expresa) |

## Objetivo de la fase 1
Crear los cimientos: estructura modular, React + TypeScript + Tailwind, Tauri 2, motor C++/JUCE, SQLite, Dashboard, navegación y comunicación verificada entre la UI y el componente nativo.

## Funcionalidades

Leyenda: ✅ Implementado y probado · 🟡 Implementado, no probado · ⏳ Pendiente · ⛔ Bloqueado

| Funcionalidad | Estado | Evidencia |
|---|---|---|
| Repositorio GitHub revisado y `origin` configurado | ✅ | Solo contenía `README.md` (commit `bbc732a`); no había trabajo previo que conservar. |
| Estructura modular (`apps/`, `crates/`, `engine/`, `docs/`) | ✅ | Ver `docs/ARCHITECTURE.md` |
| React 19 + TypeScript 6 + Tailwind 4 + Vite 8 | ✅ | `tsc` sin errores; build de Vite OK |
| Tauri 2 | ✅ | La app compila y abre (verificado por E2E) |
| Motor C++20 + JUCE 9.0.5 (librería estática, ABI en C) | ✅ | Pruebas nativas con CTest OK |
| Wrapper Rust seguro del motor (con protección de hilo) | ✅ | `cargo test`: motor (2 pruebas) |
| SQLite embebido con migraciones versionadas | ✅ | `cargo test`: base de datos (4 pruebas); archivo real creado en `%APPDATA%\com.liveplayer.app\` |
| Comunicación UI ↔ Rust ↔ C++ | ✅ | E2E: ping a través del botón real ×5, `value → value+1`, unos 5 ms de ida y vuelta UI↔motor y 1–2 µs de llamada nativa |
| Detección de sistemas y dispositivos de audio (solo lectura) | ✅ | Detecta Windows Audio (Shared, Exclusive, Low Latency) y DirectSound con los dispositivos reales de este equipo |
| Dashboard (motor, audio, base de datos, aplicación) | ✅ | Capturas E2E |
| Navegación principal (8 módulos) | ✅ | Pruebas de Vitest y E2E en las 8 rutas |
| Módulos de fases posteriores | Placeholder | Muestran "Planificado para la Fase N"; sin funcionalidad simulada |

### Nota sobre el alcance
La detección de dispositivos es **solo lectura** y se adelantó a propósito para verificar que JUCE inicializa correctamente los back-ends de audio del sistema. **No se abre ningún dispositivo ni se reproduce audio.** La selección de dispositivos y el enrutamiento corresponden a la fase 4.

El esquema de la base de datos solo contiene `app_settings`. Las tablas de canciones, pistas, setlists, etc. se crearán mediante migraciones en sus respectivas fases.

## Pruebas realizadas (2026-11-16, Windows 10 Home 19045, i5-7200U, 24 GB)

| Suite | Comando | Resultado |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ 0 errores |
| UI (Vitest + Testing Library) | `npm test` | ✅ 11/11 |
| Motor C++ nativo (CTest) | `ctest --test-dir engine/build -C RelWithDebInfo` | ✅ 1/1 (ABI, ping, buffer insuficiente, argumentos nulos, 3 ciclos de create/destroy, escaneo de dispositivos) |
| Rust: `liveplayer-engine` | `cargo test --workspace` | ✅ 2/2 (información estática, ciclo de vida, ping, diagnóstico de audio, rechazo de hilo ajeno) |
| Rust: `liveplayer-db` | `cargo test --workspace` | ✅ 4/4 (migración, upsert, persistencia y reapertura, rechazo de esquema futuro) |
| E2E sobre la app real | `npm run test:e2e -w apps/desktop` | ✅ 14/14 comprobaciones (WebView2 + CDP) |
| Modo desarrollo | `npm run dev` | ✅ Vite listo en 1,2 s y la app abre. Un cambio en `DashboardPage.tsx` se aplica por HMR sin reiniciar; un cambio en `src-tauri/src/error.rs` recompila (≈11,5 s) y relanza la app sola |

### Errores encontrados y corregidos durante la fase
1. `baseUrl` está obsoleto en TypeScript 6 → eliminado (`paths` relativo).
2. En Windows, `canonicalize()` producía rutas `\\?\C:\...` que MSVC no puede abrir → `build.rs` ya no usa `canonicalize`.
3. Enlace: faltaban bibliotecas Win32 (`shell32`, `ole32`…) que JUCE no declara → añadidas en `build.rs`.
4. UI: la etiqueta "F3" se confundía con las teclas de función → cambiada a "Fase 3"; se corrigieron cortes de texto.

## Errores conocidos / limitaciones
- La primera compilación es lenta (configurar JUCE ≈ 3 min, Rust ≈ 5 min en este equipo).
- macOS, Android e iPadOS: no compilados ni probados (corresponde a las fases 6 y 7).
- ASIO desactivado (`JUCE_ASIO=0`) hasta la fase 4.

## Decisiones tomadas por el usuario
- **Licencia:** LIVEPLAYER se publica bajo **AGPL-3.0-or-later** (ver `LICENSE` y `docs/LICENSING.md`), lo que permite usar JUCE gratis. El código fuente se publicará al distribuir.
- **Email de los commits:** se mantiene el configurado en git.

## Dependencias instaladas

**Sistema** (vía winget): Visual Studio 2022 Build Tools 17.14 (MSVC + Windows SDK), Rust stable (MSVC), CMake 4.4.4. Ya existían: Git 2.56, Node 26.13, npm 11.20, GitHub CLI 2.103.

**npm:** react/react-dom 19.3.1, react-router-dom 7.18.5, lucide-react 1.73.0, @tauri-apps/api 2.12.5, @tauri-apps/cli 2.12.5, tailwindcss y @tailwindcss/vite 4.3.5, vite 8.3.8, @vitejs/plugin-react 6.3.0, typescript 6.0.3, vitest 5.1.0, @testing-library/react 16.3.3, jsdom 31.0.1.

**Cargo:** tauri 2, tauri-build 2, rusqlite 0.43 (bundled, SQLite 3.54.1), serde 1, serde_json 1, thiserror 2, cmake 0.1, tempfile 3.

**C++:** JUCE 9.0.5 (en `third_party/JUCE`, git ignorado; o descarga automática con FetchContent).

Todas son gratuitas (ver `docs/LICENSING.md`).

## Resultado de compilación
- Motor: `liveplayer_engine.lib` (RelWithDebInfo, /MD) ✅
- App: `target/debug/liveplayer-desktop.exe` ✅. El bundle/instalador está desactivado (`bundle.active: false`) hasta la fase 7.

## Commits
Ver `git log feature/phase-1-foundation`. Resumen en el informe de la fase.

## Próximo paso propuesto (pendiente de aprobación del plan)
**FASE 2 — Real Audio Playback**: lector de WAV con precarga en un hilo de disco, reloj compartido basado en muestras, apertura de dispositivo WASAPI, Play/Pause/Stop/Restart/Seek, posición y duración en la UI vía eventos, volumen maestro con rampas, y pruebas repetidas de sincronización con 2–3 pistas.
