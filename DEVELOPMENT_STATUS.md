# LIVEPLAYER — Estado del desarrollo

| | |
|---|---|
| **Última fase cerrada** | **FASE 4 — Tarjeta de sonido y salidas** ✅ aprobada (2026-11-17) y fusionada en `main` |
| **Fases anteriores** | Fase 1 ✅ · Fase 2 ✅ ([informe](docs/fases/FASE-2.md)) · Fase 3 ✅ ([informe](docs/fases/FASE-3.md)) · Fase 4 ✅ ([informe](docs/fases/FASE-4.md)) |
| **Próxima fase** | **FASE 5 — Song Editor, Setlists y Live Mode** · plan propuesto, ⏳ **pendiente de aprobación del usuario** (no iniciada) |
| **Fecha** | 2026-11-17 |

## Plan propuesto para la fase 5

1. **Song Editor**: marcar a mano dónde empieza y termina cada parte (la detección automática es solo el punto de partida):
   - arrastrar los bordes de cada parte, con ajuste al compás;
   - marcar un corte con una tecla mientras suena;
   - dividir, unir, borrar y renombrar partes;
   - repetir una parte en bucle para comprobarla;
   - datos de la canción: título, artista, tonalidad, BPM, compás y notas;
   - deshacer y rehacer.
2. **Setlists**: listas por servicio o concierto con nombre, fecha y lugar. Se agregan canciones de la biblioteca, se ordenan arrastrando, cada canción lleva notas y se ve la duración total. Se pueden duplicar.
3. **Live Mode**: pantalla grande para el escenario:
   - canción y parte actual, siguiente parte y compás y tiempo;
   - botones grandes y atajos de teclado;
   - saltos a una parte al terminar el compás (para que la banda siga), y bucle de una parte;
   - carga anticipada de la siguiente canción del setlist;
   - bloqueo contra toques accidentales.
4. **General Settings**: atajos de teclado y copia de seguridad (exportar e importar la biblioteca).
