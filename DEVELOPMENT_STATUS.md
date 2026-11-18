# LIVEPLAYER — Estado del desarrollo

| | |
|---|---|
| **Última fase cerrada** | **FASE 6 — Estabilidad, rendimiento y Mac** ✅ aprobada (2026-11-17) y fusionada en `main` |
| **Fases anteriores** | Fase 1 ✅ · Fase 2 ✅ ([informe](docs/fases/FASE-2.md)) · Fase 3 ✅ ([informe](docs/fases/FASE-3.md)) · Fase 4 ✅ ([informe](docs/fases/FASE-4.md)) · Fase 5 ✅ ([informe](docs/fases/FASE-5.md)) · Fase 6 ✅ ([informe](docs/fases/FASE-6.md)) |
| **Próxima fase** | **FASE 7 — Instaladores para compartir la app** · plan propuesto, ⏳ **pendiente de aprobación del usuario** (no iniciada) |
| **Fecha** | 2026-11-17 |

## Pendientes que pasan de la fase 6
- **Compilar la versión de Mac**: el flujo de GitHub está listo; falta que GitHub lo ejecute (aviso de bloqueo de facturación en la cuenta, a revisar).
- **Pruebas con la interfaz real** (desconexión en plena canción y ASIO): cuando el usuario la tenga a mano.

## Plan propuesto para la fase 7
Todo gratis y sin tiendas de apps. **Cómo se comparte (definido por el usuario):** la app se lleva en una USB, se **arrastra a la computadora** y se instala desde ahí. Una vez instalada, **la USB ya no hace falta**: la app queda completa en la computadora y funciona sin internet.

1. **Windows**:
   - un solo instalador `.exe`: se copia de la USB a la computadora, se abre y se instala **sin internet** (incluye WebView2, lo que Windows necesita para mostrar la interfaz);
   - todo lo necesario (motor de audio, FFmpeg, librerías) va dentro del instalador; nada se lee de la USB.
2. **Mac**:
   - `.dmg` (Apple Silicon e Intel): se copia a la Mac, se abre y se arrastra la app a Aplicaciones; compilado con el flujo gratuito de GitHub;
   - si GitHub sigue sin ejecutar el flujo, se busca otra opción gratuita o se compila en una Mac prestada.
3. **Primera apertura**:
   - la app **no estará firmada** (aceptado por el usuario; firmar cuesta dinero);
   - guía corta con capturas para pasar el aviso de Windows (SmartScreen: «Más información» › «Ejecutar de todas formas») y el de Mac (clic derecho › «Abrir»).
4. **Datos del usuario**: instalar o actualizar nunca borra la biblioteca, las canciones ni los setlists; la copia de seguridad (.zip) sirve para pasar todo a otra computadora.
5. **Versión y licencias**: número de versión 1.0.0, pantalla «Acerca de» con las licencias de lo que usa la app (JUCE, FFmpeg, etc.) para que se pueda compartir legalmente.
6. **Prueba final de instalación desde cero: se hará junto con el usuario.** Antes de eso se dejan listos los instaladores y se revisa que no dependan de nada de esta computadora; la prueba en la otra computadora espera al usuario.
