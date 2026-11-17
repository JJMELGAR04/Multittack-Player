# LIVEPLAYER — Estado del desarrollo

| | |
|---|---|
| **Última fase cerrada** | **FASE 3 — Mezclador guardado y biblioteca de canciones** ✅ aprobada (2026-11-17) y fusionada en `main` |
| **Fases anteriores** | Fase 1 ✅ · Fase 2 ✅ ([informe](docs/fases/FASE-2.md)) · Fase 3 ✅ ([informe](docs/fases/FASE-3.md)) |
| **Próxima fase** | **FASE 4 — Dispositivos de audio y enrutamiento de salidas** · plan propuesto, ⏳ **pendiente de aprobación del usuario** (no iniciada) |
| **Fecha** | 2026-11-17 |

## Plan propuesto para la fase 4

Objetivo: que LIVEPLAYER funcione con la interfaz de audio real de un escenario y que cada pista salga por la salida física que el usuario elija.

1. **Elegir el dispositivo de audio**: lista de tarjetas e interfaces conectadas, con el tipo de controlador:
   - WASAPI compartido (siempre disponible);
   - WASAPI exclusivo (menor latencia; la app usa la tarjeta en solitario);
   - ASIO (interfaces profesionales), con el SDK de Steinberg bajo GPLv3, gratuito y compatible con nuestra licencia.
2. **Frecuencia y búfer**: 44,1 / 48 / 88,2 / 96 kHz y tamaño de búfer, con la latencia resultante en milisegundos.
3. **Matriz de salidas**: cada pista y cada bus (PA, banda) se asigna a cualquier salida física de la interfaz, en mono o en estéreo. Sustituye a los modos fijos estéreo / dividido / cuádruple, que quedan como plantillas rápidas.
4. **Persistencia**: el dispositivo y la matriz se guardan; al abrir la app se reconecta. Si la interfaz no está conectada, avisa y usa la salida por defecto sin perder la configuración.
5. **Robustez en vivo**:
   - desconexión de la interfaz en plena reproducción: aviso claro, sin bloqueo; reconexión automática al volver;
   - contador de cortes de audio y carga del motor, visibles.
6. **Página *Audio Settings*** (hoy «planificada»): dispositivo, controlador, frecuencia, búfer, latencia, matriz de salidas y **tono de prueba por salida** para identificar cada canal en la consola.

Fuera de la fase 4: Setlists, Live Mode y Song Editor con edición manual de las partes (fase 5).
