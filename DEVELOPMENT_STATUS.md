# LIVEPLAYER — Estado del desarrollo

| | |
|---|---|
| **Fase actual** | **FASE 7 — INSTALADORES PARA COMPARTIR LA APP** |
| **Estado** | Instalador de Windows listo y probado en este equipo. **Fusionada en `main` a pedido del usuario (2026-11-18).** ⏳ Pendiente: la prueba de instalación desde cero en otra computadora, junto con el usuario, y la versión de Mac |
| **Rama** | `feature/phase-7-installers` (fusionada en `main`) |
| **Versión** | **1.0.0** |
| **Fecha** | 2026-11-17 |
| **Fases anteriores** | Fases 1 a 6 ✅ (informes en [`docs/fases/`](docs/fases/)) |

## Objetivo de la fase 7 (acordado con el usuario)
- La app se lleva en una **USB**, se **copia a la computadora** y se instala desde ahí. Después **la USB ya no hace falta**: la app queda completa en la computadora y funciona sin internet.
- Sin firmar (aceptado por el usuario: firmar cuesta dinero).
- Si alguien tiene el **repositorio de GitHub**, que pueda instalarla desde ahí: guía para las dos formas.
- La prueba de instalación desde cero se hace **junto con el usuario**.

## Cambios pedidos por el usuario durante la fase (incluidos)
- **Acceso directo «LIVEPLAYER» en el Escritorio** de este equipo.
- **Song Editor › Pistas**: corregir el nombre de cada audio y elegir qué instrumento es (se guarda solo). Debajo se ve el nombre del archivo original. Antes, borrar todo el nombre para reescribirlo devolvía el nombre viejo.
- **Partes con total libertad**:
  - ya **no se ajustan al compás por defecto** (el botón «Ajuste al compás» sigue disponible);
  - se puede **escribir el inicio y el final exactos** con decimales (`1:23.45` o `1:23,45`);
  - flechas ‹ › para ajustar fino, de a **1 tiempo, 0,1 s o 0,01 s**;
  - el final de una parte es el inicio de la siguiente (sin huecos, para que los saltos en Live siempre tengan destino).
- **README** con qué hace la app, cómo funciona, guía de uso y capturas presentables (biblioteca de demostración; nunca la del usuario). Se regeneran con `node scripts/readme-shots.mjs <exe> ../../docs/img` en `apps/desktop`.
- **Revisión de robustez** (sin agregar carga):
  - **clics rápidos**: en tono, tempo ±1, flechas de las partes (Song Editor y Studio), cada clic cuenta. Antes, dos clics rápidos podían contar como uno;
  - **buscador de canciones** del Studio: la lista se carga al abrirse los resultados, no solo al recibir el foco;
  - **más ligera con la ventana minimizada**: la interfaz deja de consultar al motor (unas 50 consultas por segundo) mientras nadie la ve. El audio no se ve afectado: el motor toca por su cuenta. La vigilancia de la interfaz de audio (desconexión) sigue activa.

## Funcionalidades

Leyenda: ✅ Implementado y probado · ⏳ Pendiente

| Funcionalidad | Estado | Evidencia |
|---|---|---|
| **Instalador de Windows** `LIVEPLAYER_1.0.0_x64-setup.exe` (212 MB): instala **sin internet** (trae WebView2 dentro) y **sin contraseña de administrador**; acceso en el menú Inicio (y en el Escritorio, opción marcada al terminar) | ✅ | Compilado con `npm run installer` |
| **La app no depende de nada de esta computadora**: el runtime de C++ de Microsoft va dentro del `.exe` (antes necesitaba `MSVCP140.dll`, que un Windows recién instalado puede no tener) | ✅ | `dumpbin /dependents`: solo DLL que trae Windows 10/11 |
| La app instalada usa su propia carpeta de datos y **actualizar no borra la biblioteca** | ✅ | Arranque de la versión final con una carpeta de datos limpia: crea biblioteca, copia diaria y registro («LIVEPLAYER 1.0.0 iniciado») |
| **Guía de instalación** [`docs/INSTALAR.md`](docs/INSTALAR.md): con la USB (Windows y Mac, avisos de app no firmada) y **desde el repositorio de GitHub** | ✅ | |
| **`npm run installer`**: desde un `git clone`, comprueba las herramientas, compila y deja el instalador en `instaladores/` | ✅ | Usado para generar el instalador final |
| **Acerca de** (General Settings): versión, enlace al código fuente y licencias **dentro de la app** (AGPL-3.0 y componentes de terceros) | ✅ | Prueba de Rust + E2E |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) con los avisos de licencia de todo lo que va dentro | ✅ | |
| Versión **1.0.0** en toda la app (barra superior, Acerca de, motor) | ✅ | E2E |
| **Mac**: configuración del `.dmg` (firma *ad hoc* gratuita para que funcione en Mac con chip Apple) y flujo de GitHub «Installers» que genera `.exe` y `.dmg` (Apple Silicon e Intel) | ⏳ | Se lanza a mano en GitHub › Actions › Installers. Pendiente de que GitHub ejecute flujos en la cuenta |
| **Prueba de instalación desde cero en otra computadora** | ⏳ | **Se hará junto con el usuario** |

## Pruebas realizadas (2026-11-18)

| Suite | Resultado |
|---|---|
| Typecheck | ✅ 0 errores |
| UI (Vitest) | ✅ 45/45 (nueva: leer tiempos escritos) |
| Motor C++ (4 suites) | ✅ 4/4, dos ejecuciones seguidas |
| Rust (`liveplayer-db` 15, `liveplayer-engine` 2, `liveplayer-desktop` 8) | ✅ |
| E2E sobre la app real | ✅ **120/120** (incluye que la forma de onda del Song Editor se vea con su altura) (nuevas: Acerca de, tiempos exactos con decimales, flecha fina, renombrar pista y cambiar instrumento desde el Song Editor) |
| Resistencia a 2×: 10 min de audio (12 cambios de canción, 84 saltos, 29 bucles, 59 tempo, 47 tono) | ✅ 0 cortes, 0 muestras inválidas |

### Corregido durante la fase
- **La app necesitaba `MSVCP140.dll`** (el runtime de C++ de Microsoft). En un Windows recién instalado no habría abierto. Ahora todo va dentro del `.exe` (`.cargo/config.toml` y el motor con `/MT`).
- El motor seguía diciendo versión 0.6.0; ahora 1.0.0.
- Dos clics rápidos en «Subir medio tono» podían contar como uno (encontrado por la prueba E2E). Lo mismo pasaba con tempo ±1 y las flechas de las partes.
- La forma de onda y las partes del Song Editor se aplastaban a altura 0 cuando la página era más alta que la ventana (al agregar «Pistas»). Corregido y cubierto por la prueba E2E.
- El buscador de canciones del Studio podía quedarse vacío si la ventana estaba en segundo plano al recibir el foco.
- La prueba automática de resistencia corría a 6× la velocidad real y fallaba 1 de cada 3 veces con un solo corte (a 6× el margen es de 25 ms, frente a 150 ms en uso normal; ya estaba en el informe de la fase 6). Ahora corre a 2×, que es el mismo margen que en uso real. La de 6× sigue disponible a mano: `liveplayer_soak <carpeta> 60 6`.

## Limitaciones conocidas
- **Sin firma**: Windows puede mostrar «Windows protegió su PC» y Mac pide permiso la primera vez. La guía explica cómo pasarlo.
- El instalador de Windows pesa 212 MB porque trae WebView2 para instalar sin internet (la app instalada ocupa unos 16 MB).
- **La versión de Mac no se ha compilado todavía** (ver arriba).

## Próximo paso
1. **Prueba de instalación desde cero junto con el usuario**: copiar el instalador a la USB, pasarlo a otra computadora, instalar, abrir, importar una canción, tocarla en Live, sacar la USB y comprobar que todo sigue funcionando.
2. Con la aprobación del usuario: fusionar en `main` y, si se desea, publicar la versión 1.0.0 en GitHub (Releases).
