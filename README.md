# LIVEPLAYER

Reproductor multitrack profesional para presentaciones en vivo: iglesias, equipos de alabanza, bandas y conciertos.

> **Estado:** en desarrollo, fase 1 (Foundation). Ver [`DEVELOPMENT_STATUS.md`](DEVELOPMENT_STATUS.md).

## Tecnología
- **UI:** React 19 + TypeScript + Tailwind CSS 4
- **Shell de escritorio:** Tauri 2 (Rust)
- **Motor de audio:** C++20 + JUCE 9 (ABI en C, librería estática)
- **Datos:** SQLite embebido (rusqlite)

## Estructura
```
apps/desktop/            UI React + app Tauri (src-tauri/)
crates/liveplayer-engine Wrapper Rust seguro del motor nativo
crates/liveplayer-db     Persistencia SQLite y migraciones
engine/                  Motor de audio C++/JUCE + pruebas nativas
docs/                    Arquitectura, plataformas, licencias, entorno
```

## Documentación
- [Arquitectura](docs/ARCHITECTURE.md)
- [Entorno de desarrollo](docs/SETUP.md)
- [Estrategia multiplataforma](docs/PLATFORMS.md)
- [Licencias](docs/LICENSING.md)
