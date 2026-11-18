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
| zip (crate de Rust) | MIT | Sí | Solo descompresión (deflate) para importar canciones en zip. |
| React, React Router, lucide-react | MIT / ISC | Sí | |
| Tailwind CSS, Vite, Vitest | MIT | Sí | |
| TypeScript | Apache-2.0 | Sí | |
| Rust, rusqlite, serde, thiserror | MIT / Apache-2.0 | Sí | |
| SQLite | Dominio público | Sí | Embebido en el binario. |
| Visual Studio 2022 Build Tools | Licencia de Microsoft | Sí | Gratuito para desarrolladores individuales y proyectos de código abierto. Solo se necesita para compilar; el usuario final no lo instala. |
| CMake | BSD-3 | Sí | |
| ASIO SDK 2.3.4 de Steinberg | Doble licencia: propietaria **o GPLv3** (desde octubre de 2025) | Sí | LIVEPLAYER lo usa bajo la **GPLv3**, compatible con nuestra AGPLv3: gratis, sin firmar acuerdos y redistribuible. Se descarga con `node tools/fetch-asio-sdk.mjs` y no se sube al repositorio (`third_party/asio/` está en `.gitignore`). No usamos el logotipo de ASIO. Los **controladores** ASIO los instala cada fabricante de interfaz; no forman parte de LIVEPLAYER. |
| FFmpeg | LGPL / GPL | Sí | **No va dentro de la app.** Solo se usa en desarrollo para comparar el audio decodificado con una referencia. El motor decodifica WAV, AIFF, FLAC, OGG y MP3 con JUCE. |
| Runtime de C/C++ de Microsoft (MSVC) | Licencia de Microsoft (redistribuible) | Sí | Enlazado **estáticamente** dentro del `.exe` (fase 7): la app no necesita el «Visual C++ Redistributable» en un Windows recién instalado. |
| Microsoft Edge WebView2 (instalador sin conexión) | Licencia de Microsoft, redistribuible gratis | Sí | Va dentro del instalador de Windows (fase 7) para instalar sin internet. Windows 10/11 casi siempre ya lo tiene; si no, el instalador lo agrega. |
| NSIS (genera el instalador de Windows) | zlib / CPL | Sí | Solo crea el instalador; Tauri lo descarga al compilar. |

## Distribución (fase 7)
- Los instaladores **no están firmados** (firmar cuesta: Apple Developer 99 USD/año; certificado de Windows). Decisión del usuario: se comparten sin firmar; la guía [`INSTALAR.md`](INSTALAR.md) explica el aviso de la primera vez. En Mac la app lleva una firma *ad hoc* (gratuita) para que los Mac con chip Apple la puedan ejecutar.
- Los avisos de licencia van **dentro de la app** (General Settings › Acerca de): texto de la AGPL-3.0 y [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). La AGPL exige ofrecer el código fuente: la app muestra el enlace al repositorio.
