# LIVEPLAYER

Reproductor multitrack profesional para presentaciones en vivo: iglesias, equipos de alabanza, bandas y conciertos.

> **Versión 1.0.0** para Windows y Mac. Estado del desarrollo: [`DEVELOPMENT_STATUS.md`](DEVELOPMENT_STATUS.md).

## Instalar
**[Guía de instalación](docs/INSTALAR.md)**: con el instalador (por USB) o desde este repositorio:

```bash
git clone https://github.com/JJMELGAR04/Multittack-Player.git
cd Multittack-Player
npm run installer   # deja el instalador en instaladores/
```

(Antes hay que instalar las herramientas gratuitas que indica la guía.)

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
- [Instalación](docs/INSTALAR.md)
- [Arquitectura](docs/ARCHITECTURE.md)
- [Entorno de desarrollo](docs/SETUP.md)
- [Estrategia multiplataforma](docs/PLATFORMS.md)
- [Licencias](docs/LICENSING.md)

## Licencia
[GNU AGPL-3.0-or-later](LICENSE). Ver [docs/LICENSING.md](docs/LICENSING.md) y [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
