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
Todo gratis y sin tiendas de apps: la app se comparte por USB o en un archivo comprimido.

1. **Windows**:
   - instalador `.exe` que funciona **sin internet** (incluye WebView2), desde una USB;
   - versión **portable** opcional (una carpeta que se abre sin instalar).
2. **Mac**:
   - `.dmg` (Apple Silicon e Intel), compilado con el flujo gratuito de GitHub;
   - si GitHub sigue sin ejecutar el flujo, se busca otra opción gratuita o se compila en una Mac prestada.
3. **Primera apertura**:
   - la app no estará firmada (firmar cuesta dinero: Apple 99 USD/año; en Windows, un certificado);
   - guía corta con capturas para pasar el aviso de Windows (SmartScreen: «Más información» › «Ejecutar de todas formas») y el de Mac (clic derecho › «Abrir»).
4. **Datos del usuario**: instalar o actualizar nunca borra la biblioteca, las canciones ni los setlists; la copia de seguridad (.zip) sirve para pasar todo a otra computadora.
5. **Versión y licencias**: número de versión 1.0.0, pantalla «Acerca de» con las licencias de lo que usa la app (JUCE, FFmpeg, etc.) para que se pueda compartir legalmente.
6. **Prueba final**: instalar desde cero en una carpeta limpia, abrir, importar una canción, tocarla en Live y desinstalar.
