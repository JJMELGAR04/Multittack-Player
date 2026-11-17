# LIVEPLAYER — Estado del desarrollo

| | |
|---|---|
| **Última fase cerrada** | **FASE 5 — Song Editor, Setlists, Live Mode y cambio de tono** ✅ aprobada (2026-11-17) y fusionada en `main` |
| **Fases anteriores** | Fase 1 ✅ · Fase 2 ✅ ([informe](docs/fases/FASE-2.md)) · Fase 3 ✅ ([informe](docs/fases/FASE-3.md)) · Fase 4 ✅ ([informe](docs/fases/FASE-4.md)) · Fase 5 ✅ ([informe](docs/fases/FASE-5.md)) |
| **Próxima fase** | **FASE 6 — Estabilidad, rendimiento y otras plataformas** · plan propuesto, ⏳ **pendiente de aprobación del usuario** (no iniciada) |
| **Fecha** | 2026-11-17 |

## Plan propuesto para la fase 6
1. **Estabilidad para un servicio completo**:
   - pruebas largas (horas sonando, cientos de cambios de canción, saltos y cambios de tono) vigilando memoria, cortes y CPU;
   - recuperación si algo falla, sin perder la biblioteca;
   - registro de errores para diagnosticar.
2. **Rendimiento en equipos modestos**:
   - caché de canciones ya decodificadas (abrir por segunda vez mucho más rápido);
   - modo económico del time-stretch y del cambio de tono;
   - menos memoria por canción;
   - medidas en el equipo del usuario.
3. **Pruebas reales pendientes**: desconectar una interfaz en plena canción e interfaz ASIO real.
4. **Otras plataformas** (según lo que el usuario vaya a usar): macOS y evaluación de tablets.
