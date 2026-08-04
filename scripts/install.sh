#!/usr/bin/env bash
#
# Instala o actualiza Huddle desde GitHub.
#
#   curl -fsSL https://raw.githubusercontent.com/Ryzeon/huddle/main/scripts/install.sh | bash -s -- --room KY4DK-MHP99 --alias @tualias
#
# Volver a ejecutarlo actualiza a la última versión publicada. Para actualizar
# sin tocar la sala ni el MCP:
#
#   huddle-update      (o)      install.sh --update
#
set -euo pipefail

REPO="Ryzeon/huddle"
HUB="wss://hub.ryzeon.dev"
PREFIX="${HUDDLE_PREFIX:-$HOME/.huddle}"
APP="$PREFIX/app"

ROOM=""
ALIAS=""
EXPOSE="$PWD"
SOLO_ACTUALIZAR=0
SIN_MCP=0
SIN_DAEMON=0

rojo()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
gris()  { printf '\033[90m%s\033[0m\n' "$*"; }

uso() {
  cat >&2 <<'FIN'
Uso: install.sh --room <CODIGO> --alias <@tualias> [opciones]

  --room <CODIGO>    Código de la sala. Te lo pasa quien la creó.
  --alias <@nombre>  Con qué nombre apareces en la sala.
  --hub <url>        Hub al que conectarse. Por defecto wss://hub.ryzeon.dev
  --expose <dir>     Repositorio que expones. Por defecto, el directorio actual.
  --update           Solo actualizar el código; no toca sala ni MCP.
  --no-mcp           No registrar el servidor MCP.
  --no-daemon        No arrancar el daemon al terminar.

Se instala en ~/.huddle/app y deja `huddle` en el PATH.
FIN
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --room)   ROOM="${2:-}"; shift 2 ;;
    --alias)  ALIAS="${2:-}"; shift 2 ;;
    --hub)    HUB="${2:-}"; shift 2 ;;
    --expose) EXPOSE="${2:-}"; shift 2 ;;
    --update)     SOLO_ACTUALIZAR=1; shift ;;
    --no-mcp)     SIN_MCP=1; shift ;;
    --no-daemon)  SIN_DAEMON=1; shift ;;
    -h|--help) uso ;;
    *) rojo "opción desconocida: $1"; uso ;;
  esac
done

if [ "$SOLO_ACTUALIZAR" -eq 0 ]; then
  [ -n "$ROOM" ]  || { rojo "falta --room"; uso; }
  [ -n "$ALIAS" ] || { rojo "falta --alias"; uso; }
  EXPOSE="$(cd "$EXPOSE" && pwd)"
fi

# --- Requisitos -------------------------------------------------------------

for cmd in node curl tar; do
  command -v "$cmd" >/dev/null 2>&1 || { rojo "hace falta $cmd"; exit 1; }
done

MAYOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$MAYOR" -ge 20 ] || { rojo "Node $MAYOR es demasiado viejo; hace falta 20 o superior."; exit 1; }

if [ "$SIN_MCP" -eq 0 ] && ! command -v claude >/dev/null 2>&1; then
  rojo "No encuentro el CLI de Claude Code, que es quien responde las preguntas."
  rojo "Instálalo desde https://claude.com/claude-code, o pasa --no-mcp."
  exit 1
fi

# --- Qué versión toca -------------------------------------------------------

# Se prefiere la última release publicada. Mientras no haya ninguna, `main`
# sirve: así el instalador funciona desde el primer día del proyecto.
etiqueta="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
  | sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\1/p' | head -1 || true)"
if [ -z "$etiqueta" ]; then
  etiqueta="main"
  gris "sin releases publicadas todavía; instalando desde main"
fi

instalada=""
[ -f "$PREFIX/version" ] && instalada="$(cat "$PREFIX/version")"

if [ "$instalada" = "$etiqueta" ] && [ "$etiqueta" != "main" ] && [ -d "$APP" ]; then
  verde "ya tienes la $etiqueta, que es la última."
  if [ "$SOLO_ACTUALIZAR" -eq 1 ]; then exit 0; fi
else
  gris "descargando $etiqueta…"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  if [ "$etiqueta" = "main" ]; then
    url="https://github.com/$REPO/archive/refs/heads/main.tar.gz"
  else
    url="https://github.com/$REPO/archive/refs/tags/$etiqueta.tar.gz"
  fi
  curl -fsSL "$url" -o "$tmp/huddle.tar.gz"
  mkdir -p "$tmp/x" && tar -xzf "$tmp/huddle.tar.gz" -C "$tmp/x" --strip-components=1

  # Se reemplaza entero en vez de mezclar: un archivo que desapareció en la
  # versión nueva no debe seguir ahí. La config vive fuera, en ~/.huddle.
  mkdir -p "$PREFIX"
  rm -rf "$APP"
  mv "$tmp/x" "$APP"
  echo "$etiqueta" > "$PREFIX/version"

  gris "instalando dependencias y compilando…"
  ( cd "$APP" && npm install --silent --no-audit --no-fund && npx tsc --build )
fi

chmod +x "$APP/huddle" "$APP/huddle-hub" 2>/dev/null || true

# --- Dejarlo en el PATH -----------------------------------------------------

destino=""
for dir in /usr/local/bin "$HOME/.local/bin"; do
  if [ -d "$dir" ] && [ -w "$dir" ]; then destino="$dir"; break; fi
done
if [ -z "$destino" ]; then
  destino="$HOME/.local/bin"
  mkdir -p "$destino"
fi

ln -sf "$APP/huddle" "$destino/huddle"

# Un atajo para actualizar sin recordar la URL del instalador.
cat > "$destino/huddle-update" <<ACTUALIZADOR
#!/usr/bin/env bash
exec "$APP/scripts/install.sh" --update "\$@"
ACTUALIZADOR
chmod +x "$destino/huddle-update"

verde "huddle instalado en $destino/huddle ($etiqueta)"

case ":$PATH:" in
  *":$destino:"*) ;;
  *) rojo "OJO: $destino no está en tu PATH. Añádelo a tu ~/.zshrc:"
     rojo "  export PATH=\"$destino:\$PATH\"" ;;
esac

if [ "$SOLO_ACTUALIZAR" -eq 1 ]; then
  verde "actualizado."
  exit 0
fi

# --- Entrar a la sala -------------------------------------------------------

gris "entrando a la sala…"
"$destino/huddle" join "$ROOM" "$ALIAS" --hub "$HUB" --cwd "$EXPOSE" --force

# --- Registrar el MCP -------------------------------------------------------

if [ "$SIN_MCP" -eq 0 ]; then
  # Idempotente: si ya estaba, se reemplaza en vez de duplicarse.
  claude mcp remove huddle >/dev/null 2>&1 || true
  claude mcp add huddle -- "$destino/huddle" mcp
  verde "servidor MCP registrado: tu agente ya puede preguntar por ti"
fi

echo
verde "Listo. Para actualizar más adelante:  huddle-update"
echo
if [ "$SIN_DAEMON" -eq 0 ]; then
  echo "Arrancando el daemon. Déjalo abierto; Ctrl+C para salir de la sala."
  echo
  exec "$destino/huddle" daemon
fi
