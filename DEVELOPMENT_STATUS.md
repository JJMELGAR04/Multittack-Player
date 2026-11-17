# LIVEPLAYER — Estado del desarrollo

| | |
|---|---|
| **Fase actual** | **FASE 6 — ESTABILIDAD, RENDIMIENTO Y MAC** |
| **Estado** | Implementada y probada en Windows. ⏳ **Pendiente de aprobación del usuario** |
| **Rama** | `feature/phase-6-stability` (se fusionará en `main` cuando se apruebe) |
| **Fecha** | 2026-11-17 |
| **Fases anteriores** | Fases 1 a 5 ✅ (informes en [`docs/fases/`](docs/fases/)) |
| **Próxima fase** | FASE 7 — Instaladores para Windows (.exe) y Mac (.dmg) que se puedan compartir por USB o comprimidos · **no iniciada** |

## Objetivo de la fase 6 (acordado con el usuario)
Que la app aguante un servicio completo sin fallar y funcione bien también en computadoras modestas, en **Windows y Mac**. Sin tablets ni tiendas de apps. Las pruebas con la interfaz real (desconexión y ASIO) se harán cuando el usuario la tenga a mano.

## Funcionalidades

Leyenda: ✅ Implementado y probado · ⏳ Pendiente

| Funcionalidad | Estado | Evidencia |
|---|---|---|
| **Canciones preparadas (caché)**: la primera vez se decodifica y se guarda; las siguientes veces abre mucho más rápido, idéntica bit a bit | ✅ | Prueba del motor: 2,09 s → 0,14 s. E2E: canción reabierta con 5/5 pistas de la caché en 0,14 s |
| La caché se invalida sola si cambia el archivo y respeta un límite (4 GB por defecto, de 1 a 32 GB en General Settings); botón «Vaciar» | ✅ | Prueba del motor + E2E |
| Pistas "estéreo" con los dos canales iguales guardadas como mono: **la mitad de memoria, el mismo sonido** | ✅ | Prueba del motor: mismo nivel de salida (0,500) |
| **Modo económico** (tempo y tono con menos CPU), se aplica sin perder la posición | ✅ | E2E |
| **Prueba de resistencia**: cambios de canción, saltos, bucles, tempo, tono y volúmenes durante horas de audio | ✅ | Ver «Pruebas realizadas» |
| **Corregido gracias a la prueba de resistencia**: en modo ensayo la suma de los dos buses podía pasar de 0 dBFS (1,587) → limitador de salida | ✅ | Pico tras la corrección: 0,944 (el techo) |
| Decodificación con prioridad baja y revisión de dispositivos menos frecuente (para que la interfaz no se trabe) | ✅ | |
| **Copia diaria automática de la biblioteca** (se guardan 7) y **recuperación automática** si el archivo se daña | ✅ | Prueba de Rust: se daña el archivo y vuelve desde la copia. E2E: copia del día creada |
| **Registro de errores** (motor, base de datos, cierres inesperados, interfaz); visible en General Settings | ✅ | E2E |
| Tiempo de carga, caché y calidad visibles en Studio › Motor | ✅ | |
| **Sin etiquetas de "Fase"** en la barra ni en el Dashboard (la barra solo muestra la versión) | ✅ | E2E |
| **Mac**: ajustes para compilar (macOS 11+, frameworks) y flujo de GitHub que compila y prueba en Windows y Mac | ⏳ | El flujo está listo, pero **GitHub no lo ejecutó: la cuenta tiene un bloqueo de facturación** («account is locked due to a billing issue»). Al resolverlo en GitHub › Settings › Billing se lanza desde la pestaña Actions |
| Prueba real de desconexión de la interfaz y ASIO | ⏳ | Cuando el usuario tenga la interfaz |

## Pruebas realizadas (2026-11-17)

| Suite | Resultado |
|---|---|
| Typecheck | ✅ 0 errores |
| UI (Vitest) | ✅ 44/44 |
| Motor C++ (ABI v8: caché, mono idéntico, cambio de tono, saltos y bucles, enrutamiento, sincronía, análisis + **resistencia**) | ✅ 4/4 suites |
| Rust (`liveplayer-db` 15, `liveplayer-engine` 2, `liveplayer-desktop` 7) | ✅ |
| E2E sobre la app real | ✅ **113/113** |
| Resistencia: 30 min de audio a 2× (42 cambios de canción, 234 saltos, 118 bucles, 152 tempo, 143 tono, 193 volúmenes) | ✅ **0 cortes**, 0 muestras inválidas, pico en el techo (0,944), memoria sin crecer (169,1 → 169,1 MB) |
| Resistencia extrema: 60 min a 6× (466 saltos, 90 cambios) | 0 muestras inválidas, memoria estable; 5 cortes en 60 min. Los 5 caen en saltos con tempo o tono cambiado: a 6× el margen es de solo 25 ms reales, frente a 150 ms en uso normal. A 2× hubo 0 cortes |

### Medidas en este equipo
| Canción | Primera vez (decodificar) | Siguientes veces (caché) |
|---|---|---|
| *Ancient* (7 MP3, ~4 min) | 6,25 s | **0,43 s** (14× más rápido) |
| Canción de prueba (WAV) | 2,09 s | **0,14 s** |

En *Ancient*, una de las pistas tenía los dos canales iguales y ahora ocupa la mitad.

## Limitaciones conocidas
- **La versión de Mac no se ha compilado todavía** (ver arriba). Puede necesitar algún ajuste la primera vez que compile.
- La caché ocupa disco: unos 10 MB por minuto y pista estéreo a 48 kHz (una canción de 5 min con 8 pistas son unos 400 MB). El límite se ajusta en General Settings.
- El modo económico se nota solo al cambiar tempo o tono; sin cambios suena exactamente igual.

## Base de datos
Sin migraciones nuevas. Ajustes nuevos en `app_settings`: `audio.economy`, `audio.cacheMb`.

## Próximo paso propuesto (requiere aprobación)
**FASE 7 — Instaladores**: `.exe` para Windows (puede incluir todo lo necesario para instalar sin internet, desde una USB) y `.dmg` para Mac; versión portable opcional; guía corta para quien la instale (incluido el aviso de "app no firmada" de Windows y Mac la primera vez).
