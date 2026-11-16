# LIVEPLAYER — Licencias de dependencias

Requisito del proyecto: **todo debe ser gratuito**.

| Componente | Licencia | ¿Gratuito? | Observaciones |
|---|---|---|---|
| JUCE 9.0.5 | AGPLv3 **o** JUCE EULA comercial | Sí (con AGPLv3) | ⚠️ **Decisión pendiente.** Con la opción gratuita (AGPLv3), al distribuir LIVEPLAYER hay que publicar su código fuente bajo AGPLv3. La JUCE EULA puede tener un nivel gratuito con límite de ingresos: hay que revisar sus términos vigentes antes de la fase 7. Mientras solo se desarrolla y no se distribuye, no hay obligaciones. |
| Tauri 2 | MIT / Apache-2.0 | Sí | |
| React, React Router, lucide-react | MIT / ISC | Sí | |
| Tailwind CSS, Vite, Vitest | MIT | Sí | |
| TypeScript | Apache-2.0 | Sí | |
| Rust, rusqlite, serde, thiserror | MIT / Apache-2.0 | Sí | |
| SQLite | Dominio público | Sí | Embebido en el binario. |
| Visual Studio 2022 Build Tools | Licencia de Microsoft | Sí | Gratuito para desarrolladores individuales y proyectos de código abierto. Solo se necesita para compilar; el usuario final no lo instala. |
| CMake | BSD-3 | Sí | |
| ASIO SDK (fase 4) | Licencia de Steinberg / GPLv3 | Sí | Se descarga aparte, nunca se sube al repositorio (`third_party/asio/` está en `.gitignore`). |
| FFmpeg (fase 3, si se usa) | LGPL (configuración sin componentes GPL) | Sí | Hay que enlazarlo dinámicamente para cumplir la LGPL; algunos códecs (AAC, WMA) tienen consideraciones de patentes que se documentarán en la fase 3. |
