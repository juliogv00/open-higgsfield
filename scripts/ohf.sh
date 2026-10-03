#!/bin/bash
# ohf.sh — arranca, para y mantiene Open Higgsfield.
#
#   ohf.sh [abrir|parar|reiniciar|estado|logs|comprobar|actualizar|lanzador]
#   (por defecto: abrir)
#
# Lo usa «Open Higgsfield.app», el icono de la carpeta del Escritorio.
# Todo se calcula desde la ubicación de este script, así que la carpeta
# «Open Higgsfield» se puede mover sin romper nada.
#
# Por qué cada cosa:
#   PATH   el repo usa Node 24 de nvm; un doble clic en Finder no hereda el
#          PATH de la terminal, así que se fija aquí (mismo patrón que
#          ~/dev/scripts/opendesign.sh).
#   PORT   3011, fijo: el historial de la galería vive en el almacenamiento
#          del navegador para localhost:3011. Cambiar el puerto lo "vacía".
#   dev    el servidor corre en modo desarrollo: los cambios en el código se
#          ven al guardar, sin reconstruir. Es una herramienta local.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/.." && pwd)"
LOGS_DIR="$ROOT_DIR/logs"
PID_FILE="$LOGS_DIR/.servidor.pid"
SERVER_LOG="$LOGS_DIR/servidor.log"
PORT=3011
URL="http://localhost:$PORT"
NODE_BIN="$HOME/.nvm/versions/node/v24.21.0/bin"
export PATH="$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export OHF_ROOT="$ROOT_DIR"

mkdir -p "$LOGS_DIR" "$ROOT_DIR/datos/objetos" "$ROOT_DIR/datos/personajes"

aviso() {
  osascript -e "display notification \"$1\" with title \"Open Higgsfield\"" >/dev/null 2>&1 || true
  echo "$1"
}

vivo() { curl -s -o /dev/null -m 2 "$URL/"; }

pid_servidor() {
  lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | head -1
}

arrancar() {
  if vivo; then return 0; fi
  if [ ! -d "$APP_DIR/node_modules" ]; then
    aviso "Instalando dependencias (solo la primera vez)…"
    (cd "$APP_DIR" && pnpm install) >>"$SERVER_LOG" 2>&1
  fi
  aviso "Arrancando…"
  echo "── $(date '+%F %T') arranque ──" >>"$SERVER_LOG"
  (cd "$APP_DIR" && nohup pnpm dev --port $PORT >>"$SERVER_LOG" 2>&1 &)
  # Primera compilación: unos segundos. Se espera a que la página responda
  # de verdad, no solo a que el puerto esté abierto.
  for _ in $(seq 1 90); do
    if vivo; then pid_servidor >"$PID_FILE" || true; return 0; fi
    sleep 1
  done
  aviso "No ha arrancado en 90 s. Mira logs/servidor.log"
  return 1
}

parar() {
  local pid
  pid="$(pid_servidor || true)"
  if [ -z "$pid" ]; then echo "No estaba en marcha."; rm -f "$PID_FILE"; return 0; fi
  # El servidor de Next cuelga de pnpm; se para el grupo entero.
  pkill -f "next dev --port $PORT" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "Parado."
}

case "${1:-abrir}" in
  abrir)
    arrancar && open "$URL" ;;
  parar)
    parar ;;
  reiniciar)
    parar; sleep 1; arrancar && open "$URL" ;;
  estado)
    if vivo; then echo "En marcha en $URL (pid $(pid_servidor))"; else echo "Parado."; fi
    echo "Carpeta: $ROOT_DIR"
    echo "Rama:    $(git -C "$APP_DIR" branch --show-current)" ;;
  logs)
    tail -n 50 -f "$SERVER_LOG" ;;
  comprobar)
    # Lo mismo que hay que pasar antes de dar un cambio por bueno.
    cd "$APP_DIR" && npx tsc --noEmit -p . && pnpm build ;;
  actualizar)
    # Trae los cambios del Open Higgsfield original (upstream) a tu rama.
    cd "$APP_DIR"
    if [ -n "$(git status --porcelain)" ]; then
      echo "Hay cambios sin commit en app/; no actualizo." >&2; exit 1
    fi
    parar
    git fetch upstream
    git merge --no-edit upstream/main
    pnpm install
    arrancar && open "$URL" ;;
  lanzador)
    "$APP_DIR/scripts/crear-lanzador.sh" ;;
  *)
    echo "uso: ohf.sh [abrir|parar|reiniciar|estado|logs|comprobar|actualizar|lanzador]" >&2; exit 2 ;;
esac
