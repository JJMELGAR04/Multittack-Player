# LIVEPLAYER — Entorno de desarrollo (Windows)

> Esto es solo para **desarrollar**. El usuario final no necesitará nada de esto (ver la fase 7).

## Herramientas (todas gratuitas)

```powershell
winget install --id Kitware.CMake -e
winget install --id Rustlang.Rustup -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install --id OpenJS.NodeJS -e   # Node.js 20 o superior
```

WebView2 ya viene incluido en Windows 10/11.

## Primera vez

```powershell
git clone https://github.com/JJMELGAR04/Multittack-Player.git
cd Multittack-Player
# Opcional: copias locales de las dependencias del motor (evitan descargas repetidas)
git clone --depth 1 -b 9.0.5 https://github.com/juce-framework/JUCE.git third_party/JUCE
git clone --depth 1 -b 1.4.0 https://github.com/Signalsmith-Audio/signalsmith-stretch.git third_party/signalsmith-stretch
git clone --depth 1 -b 0.6.4 https://github.com/Signalsmith-Audio/linear.git third_party/signalsmith-linear
git clone --depth 1 -b version-6.5 https://github.com/avaneev/r8brain-free-src.git third_party/r8brain
npm install
```

Si alguna de esas carpetas no existe, CMake descarga esa versión exacta automáticamente (`FetchContent`).
También se puede indicar una ruta con la variable de entorno `LIVEPLAYER_JUCE_DIR`.

## Comandos

| Acción | Comando |
|---|---|
| Ejecutar la app (desarrollo) | `npm run dev` |
| Pruebas del frontend | `npm test` |
| Comprobación de tipos | `npm run typecheck` |
| Pruebas de Rust (motor + base de datos) | `cargo test --workspace` |
| Pruebas nativas del motor C++ (incluye audio, sincronía, rendimiento y análisis) | `cmake -S engine -B engine/build && cmake --build engine/build --config RelWithDebInfo && ctest --test-dir engine/build -C RelWithDebInfo --output-on-failure` |
| Prueba E2E sobre la app real (Windows) | `npm run test:e2e -w apps/desktop` |
| Generar la canción de prueba | `node tools/generate-test-song.mjs test-audio` (lo hacen solas las pruebas que la necesitan) |

La primera compilación de JUCE y Rust tarda varios minutos.

## Dónde se guardan los datos
La base de datos se crea en `%APPDATA%\com.liveplayer.app\liveplayer.sqlite3`.
