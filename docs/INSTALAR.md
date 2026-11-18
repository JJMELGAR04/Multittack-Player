# Cómo instalar LIVEPLAYER

LIVEPLAYER es gratis y se puede compartir. Hay dos formas de instalarlo:

- **[Con la USB](#1-con-la-usb-o-un-archivo-compartido)**: alguien te pasa el instalador. Es la forma más fácil.
- **[Desde el repositorio de GitHub](#2-desde-el-repositorio-de-github)**: si tienes el código (`git clone`), compilas tu propio instalador.

Una vez instalada, **la app queda completa en la computadora**: no necesita la USB, ni internet, ni nada más.

**Requisitos:** Windows 10 u 11 de 64 bits, o macOS 11 (Big Sur) o posterior.

---

## 1. Con la USB (o un archivo compartido)

### Windows

1. Conecta la USB y **copia** `LIVEPLAYER_1.0.0_x64-setup.exe` a la computadora (por ejemplo, al Escritorio o a Descargas).
2. Abre el archivo copiado con doble clic.
3. Si aparece **«Windows protegió su PC»**: pulsa **«Más información»** y luego **«Ejecutar de todas formas»**.
   Sale porque la app no está firmada (firmar cuesta dinero). Es normal y solo pasa con el instalador.
4. Sigue el instalador. **No pide contraseña de administrador** y **no necesita internet** (trae incluido todo lo que Windows necesita para mostrar la app).
5. Abre LIVEPLAYER desde el menú Inicio o desde el acceso directo del Escritorio.

Listo: ya puedes sacar la USB y borrar el instalador que copiaste.

### Mac

1. Elige el archivo correcto según tu Mac ( › **Acerca de esta Mac**):
   - **Chip Apple M1, M2, M3, M4…** → `LIVEPLAYER_1.0.0_aarch64.dmg`
   - **Procesador Intel** → `LIVEPLAYER_1.0.0_x64.dmg`
2. Copia el `.dmg` de la USB a la Mac y ábrelo con doble clic.
3. **Arrastra LIVEPLAYER a la carpeta Aplicaciones** en la ventana que aparece.
4. Expulsa el disco «LIVEPLAYER» (y la USB). Ya puedes borrar el `.dmg`.
5. **La primera vez** que abras la app, macOS avisará de que no puede verificarla (no está firmada):
   - **macOS 15 (Sequoia) o posterior:** pulsa «Aceptar», ve a **Ajustes del Sistema › Privacidad y seguridad**, baja hasta el mensaje sobre LIVEPLAYER y pulsa **«Abrir igualmente»**. Confirma con tu contraseña.
   - **macOS 11 a 14:** en Aplicaciones, **clic derecho** (o Control + clic) sobre LIVEPLAYER › **Abrir** › **Abrir**.
   - Si dice que **«está dañada»**: abre la app *Terminal* y escribe
     `xattr -cr /Applications/LIVEPLAYER.app`
     y vuelve a abrirla.

   Después de la primera vez se abre normal.

---

## 2. Desde el repositorio de GitHub

### 2a. Descargar el instalador ya hecho
Si en la página del proyecto hay una versión publicada (**Releases**, a la derecha en GitHub), descarga el archivo de tu sistema y sigue los pasos de la [sección 1](#1-con-la-usb-o-un-archivo-compartido).

### 2b. Compilar el instalador desde el código
Todo lo que se instala aquí es gratuito. Solo se hace una vez por computadora.

**Windows** (en PowerShell):

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Rustlang.Rustup -e
winget install --id Kitware.CMake -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Cierra y vuelve a abrir la terminal después de instalarlos.

**Mac** (en Terminal):

```bash
xcode-select --install          # herramientas de compilación de Apple
# Node.js LTS: https://nodejs.org   ·   CMake: https://cmake.org/download
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
```

**Después, en los dos sistemas:**

```bash
git clone https://github.com/JJMELGAR04/Multittack-Player.git
cd Multittack-Player
npm run installer
```

La primera vez tarda bastante (de 10 a 30 minutos): compila el motor de audio y la app. Al terminar, el instalador queda en la carpeta **`instaladores/`**:

- Windows: `instaladores/LIVEPLAYER_1.0.0_x64-setup.exe`
- Mac: `instaladores/LIVEPLAYER_1.0.0_<aarch64 o x64>.dmg`

Instálalo como en la [sección 1](#1-con-la-usb-o-un-archivo-compartido). Ese mismo archivo se puede pasar por USB a otras computadoras con el mismo sistema.

**Para actualizar** a una versión nueva del repositorio:

```bash
git pull
npm run installer
```

y vuelve a instalar encima. Tu biblioteca se conserva.

---

## Tus canciones y ajustes

- **Instalar una versión nueva encima nunca borra** tu biblioteca, tus canciones, mezclas ni setlists.
- Se guardan aquí (no dentro de la app):
  - Windows: `%APPDATA%\com.liveplayer.app`
  - Mac: `~/Library/Application Support/com.liveplayer.app`
- La app hace una copia diaria de la biblioteca automáticamente.
- **Para llevar tus canciones a otra computadora:** en la app, *General Settings › Copia de seguridad › Guardar copia…*. Pasa el `.zip` por la USB y en la otra computadora usa *Restaurar copia…*.

## Desinstalar

- **Windows:** *Configuración › Aplicaciones* › LIVEPLAYER › Desinstalar. El desinstalador pregunta si quieres borrar también los datos de la app: **déjalo sin marcar** si quieres conservar tu biblioteca.
- **Mac:** arrastra LIVEPLAYER de Aplicaciones a la Papelera. Tu biblioteca se queda en la carpeta indicada arriba.
