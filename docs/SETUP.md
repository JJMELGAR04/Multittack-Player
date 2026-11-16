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
git clone --depth 1 -b 9.0.5 https://github.com/juce-framework/JUCE.git third_party/JUCE   # opcional, evita descargas repetidas
npm install
```

Si `third_party/JUCE` no existe, CMake descarga JUCE automáticamente (`FetchContent`).
También se puede indicar una ruta con la variable de entorno `LIVEPLAYER_JUCE_DIR`.

## Comandos

| Acción | Comando |
|---|---|
| Ejecutar la app (desarrollo) | `npm run dev` |
| Pruebas del frontend | `npm test` |
| Comprobación de tipos | `npm run typecheck` |
| Pruebas de Rust (motor + base de datos) | `cargo test --workspace` |
| Pruebas nativas del motor C++ | `cmake -S engine -B engine/build && cmake --build engine/build --config RelWithDebInfo && ctest --test-dir engine/build -C RelWithDebInfo --output-on-failure` |

La primera compilación de JUCE y Rust tarda varios minutos.

## Dónde se guardan los datos
La base de datos se crea en `%APPDATA%\com.liveplayer.app\liveplayer.sqlite3`.
