# LIVEPLAYER — Estrategia multiplataforma (preliminar)

> La adaptación a otras plataformas y la distribución son las **fases 6 y 7**. Este documento recoge las decisiones de diseño que se toman *desde ahora* para no cerrar esas puertas. Ninguna plataforma aparte de Windows se ha compilado ni probado todavía.

| Plataforma | Shell de UI | Audio (vía JUCE) | Estado |
|---|---|---|---|
| Windows 10/11 | Tauri 2 (WebView2) | WASAPI; ASIO opcional (fase 4) | **En desarrollo** |
| macOS | Tauri 2 (WKWebView) | CoreAudio | No probado |
| Android (tablets) | Tauri 2 mobile **o** app nativa | Oboe/AAudio (JUCE) | Por evaluar en la fase 6 |
| iPadOS | Tauri 2 mobile **o** app nativa | CoreAudio / AVAudioSession (JUCE) | Por evaluar en la fase 6 |

## Lo que se reutiliza en todas las plataformas
- `engine/` (C++/JUCE) con su ABI en C.
- `crates/liveplayer-db` (SQLite embebido).
- La UI React, con un diseño adaptable a pantallas táctiles en la fase 6.

## Lo que **no** es automático (riesgos)
- **Una app Tauri de escritorio no se convierte sola en una app de iPad o Android.** Tauri 2 tiene soporte móvil, pero hay que validar:
  - enlazar el motor C++ con el NDK de Android y en iOS (sin JIT ni librerías dinámicas no firmadas);
  - el ciclo de vida de la app (segundo plano, interrupciones de audio, `AVAudioSession`);
  - el audio multicanal: Android expone pocas salidas USB de forma fiable y el iPad depende de interfaces class-compliant.
- La alternativa, si Tauri mobile no fuera suficiente, es una app nativa ligera (Kotlin/Swift) que consuma la misma ABI en C y una UI compartida o reescrita.

## Costes (requisito: todo gratuito)
| Elemento | ¿Gratis? | Nota |
|---|---|---|
| Instalador Windows (NSIS/MSI de Tauri) | Sí | Sin firma de código, Windows SmartScreen mostrará un aviso. Un certificado de firma cuesta dinero. |
| `.dmg` de macOS | Sí, **sin firmar** | Firmar y notarizar exige el Apple Developer Program (de pago, anual). Sin él, el usuario debe permitir la app manualmente. |
| APK de Android (instalación directa) | Sí | Publicar en Google Play tiene un coste único. |
| iPadOS | **No hay vía gratuita para distribuir** | Sin una cuenta de pago solo se puede instalar en dispositivos propios desde Xcode, y caduca a los 7 días. |
