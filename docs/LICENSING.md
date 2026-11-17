# LIVEPLAYER — Licencias de dependencias

Requisito del proyecto: **todo debe ser gratuito**.

## Licencia de LIVEPLAYER
LIVEPLAYER se distribuye bajo **GNU AGPL-3.0-or-later** (texto completo en [`LICENSE`](../LICENSE)). Es la vía gratuita para usar JUCE. Implica que, al distribuir la app (o al ofrecerla por red), hay que publicar su código fuente completo, incluidas las modificaciones, bajo la misma licencia. Las demás dependencias (MIT, Apache-2.0, BSD, ISC, dominio público, LGPL enlazada dinámicamente) son compatibles con la AGPLv3.

## Dependencias

| Componente | Licencia | ¿Gratuito? | Observaciones |
|---|---|---|---|
| JUCE 9.0.5 | AGPLv3 **o** JUCE EULA comercial | Sí (con AGPLv3) | ✅ **Decidido (2026-11-16):** se usa JUCE bajo AGPLv3. |
| Signalsmith Stretch 1.4.0 + Signalsmith Linear 0.6.4 | MIT | Sí | Cambio de tempo sin alterar el tono (fase 2). |
| r8brain-free-src 6.5 | MIT | Sí | Conversión de frecuencia de muestreo de alta calidad. Créditos solicitados por el autor: *"Sample rate converter designed by Aleksey Vaneev of Voxengo"*. |
| Decodificador MP3 de JUCE | AGPLv3 (con JUCE) | Sí | Las patentes de MP3 vencieron en 2017. |
| Tauri 2 + tauri-plugin-dialog | MIT / Apache-2.0 | Sí | El plugin solo se usa para el diálogo nativo de abrir archivos. |
| React, React Router, lucide-react | MIT / ISC | Sí | |
| Tailwind CSS, Vite, Vitest | MIT | Sí | |
| TypeScript | Apache-2.0 | Sí | |
| Rust, rusqlite, serde, thiserror | MIT / Apache-2.0 | Sí | |
| SQLite | Dominio público | Sí | Embebido en el binario. |
| Visual Studio 2022 Build Tools | Licencia de Microsoft | Sí | Gratuito para desarrolladores individuales y proyectos de código abierto. Solo se necesita para compilar; el usuario final no lo instala. |
| CMake | BSD-3 | Sí | |
| ASIO SDK (fase 4) | Licencia de Steinberg / GPLv3 | Sí | Se descarga aparte, nunca se sube al repositorio (`third_party/asio/` está en `.gitignore`). |
| FFmpeg (fase 3, si se usa) | LGPL (configuración sin componentes GPL) | Sí | Hay que enlazarlo dinámicamente para cumplir la LGPL; algunos códecs (AAC, WMA) tienen consideraciones de patentes que se documentarán en la fase 3. |
