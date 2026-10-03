#!/bin/bash
# crear-lanzador.sh — (re)genera «Open Higgsfield.app» en la carpeta raíz.
#
# El .app no se versiona: es un applet de AppleScript que busca su propia
# carpeta y llama a app/scripts/ohf.sh. Si se borra o deja de abrir, este
# script lo vuelve a crear con el icono del estudio.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/.." && pwd)"
TARGET="$ROOT_DIR/Open Higgsfield.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# El applet no lleva rutas absolutas: se ubica por `path to me`, así la
# carpeta puede moverse. Lanza ohf.sh en segundo plano y termina al momento;
# el progreso llega como notificación.
cat >"$TMP/lanzador.applescript" <<'APPLESCRIPT'
set appPath to POSIX path of (path to me)
set rootDir to do shell script "dirname " & quoted form of appPath
do shell script quoted form of (rootDir & "/app/scripts/ohf.sh") & " abrir > /dev/null 2>&1 &"
APPLESCRIPT

rm -rf "$TARGET"
osacompile -o "$TARGET" "$TMP/lanzador.applescript"

# Icono: el de la propia app (public/icon-512.png) convertido a .icns.
ICONSET="$TMP/icono.iconset"
mkdir -p "$ICONSET"
SRC="$APP_DIR/public/icon-512.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$TARGET/Contents/Resources/applet.icns"
# Cambiar el icono rompe la firma ad hoc de osacompile: se vuelve a firmar.
codesign --force --deep -s - "$TARGET" >/dev/null 2>&1 || true
touch "$TARGET"
echo "Lanzador creado: $TARGET"
