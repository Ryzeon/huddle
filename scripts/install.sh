#!/usr/bin/env bash
#
# Instala Huddle en esta máquina: compila, entra a una sala, deja el daemon
# corriendo y registra el servidor MCP en tu agente.
#
#   ./scripts/install.sh --room MPP8V-7HZS5 --alias @tualias
#
set -euo pipefail

HUB="wss://hub.ryzeon.dev"
ROOM=""
ALIAS=""
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPOSE="$PWD"
SKIP_MCP=0
SKIP_DAEMON=0

rojo()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
gris()  { printf '\033[90m%s\033[0m\n' "$*"; }

uso() {
  cat >&2 <<'FIN'
Uso: ./scripts/install.sh --room <CODIGO> --alias <@tualias> [opciones]

  --room <CODIGO>    Código de la sala. Te lo pasa quien la creó.
  --alias <@nombre>  Con qué nombre apareces en la sala.
  --hub <url>        Hub al que conectarse. Por defecto wss://hub.ryzeon.dev
  --expose <dir>     Repositorio que expones. Por defecto, el directorio actual.
  --no-mcp           No registrar el servidor MCP.
  --no-daemon        No arrancar el daemon al terminar.

Para crear una sala en vez de entrar a una:
  ./huddle create "Nombre del equipo" @tualias --hub <url>
FIN
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --room)    ROOM="${2:-}"; shift 2 ;;
    --alias)   ALIAS="${2:-}"; shift 2 ;;
    --hub)     HUB="${2:-}"; shift 2 ;;
    --expose)  EXPOSE="${2:-}"; shift 2 ;;
    --no-mcp)     SKIP_MCP=1; shift ;;
    --no-daemon)  SKIP_DAEMON=1; shift ;;
    -h|--help) uso ;;
    *) rojo "opción desconocida: $1"; uso ;;
  esac
done

[ -n "$ROOM" ]  || { rojo "falta --room"; uso; }
[ -n "$ALIAS" ] || { rojo "falta --alias"; uso; }

# --- 1. Requisitos ----------------------------------------------------------

command -v node >/dev/null 2>&1 || { rojo "hace falta Node. Instálalo desde https://nodejs.org"; exit 1; }

MAYOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAYOR" -lt 20 ]; then
  rojo "Node $MAYOR es demasiado viejo; hace falta 20 o superior."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  rojo "No encuentro el CLI de Claude Code, que es quien responde las preguntas."
  rojo "Instálalo desde https://claude.com/claude-code y vuelve a ejecutar esto."
  exit 1
fi

EXPOSE="$(cd "$EXPOSE" && pwd)"
gris "repositorio a exponer: $EXPOSE"

# --- 2. Compilar ------------------------------------------------------------

gris "instalando dependencias…"
( cd "$REPO_DIR" && npm install --silent --no-audit --no-fund )

gris "compilando…"
( cd "$REPO_DIR" && npx tsc --build )

HUDDLE="$REPO_DIR/huddle"
[ -x "$HUDDLE" ] || chmod +x "$HUDDLE"

# --- 3. Entrar a la sala ----------------------------------------------------

# `join` se niega a pisar una configuración existente sin --force, y eso está
# bien: el aviso es más útil que sobrescribir en silencio.
gris "entrando a la sala…"
"$HUDDLE" join "$ROOM" "$ALIAS" --hub "$HUB" --cwd "$EXPOSE"

# --- 4. Registrar el MCP ----------------------------------------------------

if [ "$SKIP_MCP" -eq 0 ]; then
  # Idempotente: si ya estaba, se reemplaza en vez de duplicarse.
  claude mcp remove huddle >/dev/null 2>&1 || true
  claude mcp add huddle -- "$HUDDLE" mcp
  verde "servidor MCP registrado: tu agente ya puede preguntar por ti"
fi

# --- 5. Arrancar el daemon --------------------------------------------------

echo
verde "Listo."
echo
if [ "$SKIP_DAEMON" -eq 0 ]; then
  echo "Arrancando el daemon. Déjalo abierto; Ctrl+C para salir de la sala."
  echo
  exec "$HUDDLE" daemon
else
  echo "Arráncalo cuando quieras con:"
  echo "  $HUDDLE daemon"
fi
