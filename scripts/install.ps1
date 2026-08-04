# Instala Huddle en Windows: compila, entra a una sala, registra el servidor MCP
# y deja el daemon corriendo.
#
#   .\scripts\install.ps1 -Room MPP8V-7HZS5 -Alias @tualias
#
param(
  [Parameter(Mandatory = $true)][string]$Room,
  [Parameter(Mandatory = $true)][string]$Alias,
  [string]$Hub = "wss://hub.ryzeon.dev",
  [string]$Expose = $PWD.Path,
  [switch]$NoMcp,
  [switch]$NoDaemon
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

function Gris($m) { Write-Host $m -ForegroundColor DarkGray }
function Verde($m) { Write-Host $m -ForegroundColor Green }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Hace falta Node. Instalalo desde https://nodejs.org"
}

$major = [int](node -p 'process.versions.node.split(".")[0]')
if ($major -lt 20) { throw "Node $major es demasiado viejo; hace falta 20 o superior." }

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  throw "No encuentro el CLI de Claude Code. Instalalo desde https://claude.com/claude-code"
}

$Expose = (Resolve-Path $Expose).Path
Gris "repositorio a exponer: $Expose"

Gris "instalando dependencias..."
Push-Location $repo
try {
  npm install --silent --no-audit --no-fund
  Gris "compilando..."
  npx tsc --build
} finally { Pop-Location }

# En Windows el lanzador es el .cmd: `huddle` a secas es un script de bash y
# el sistema ofreceria elegir con que abrirlo.
$huddle = Join-Path $repo "huddle.cmd"

Gris "entrando a la sala..."
& $huddle join $Room $Alias --hub $Hub --cwd $Expose
if ($LASTEXITCODE -ne 0) { throw "no se pudo entrar a la sala" }

if (-not $NoMcp) {
  # Idempotente: si ya estaba, se reemplaza en vez de duplicarse.
  claude mcp remove huddle 2>$null | Out-Null
  claude mcp add huddle -- $huddle mcp
  Verde "servidor MCP registrado: tu agente ya puede preguntar por ti"
}

Write-Host ""
Verde "Listo."
Write-Host ""

if (-not $NoDaemon) {
  Write-Host "Arrancando el daemon. Dejalo abierto; Ctrl+C para salir de la sala."
  Write-Host ""
  & $huddle daemon
} else {
  Write-Host "Arrancalo cuando quieras con:"
  Write-Host "  $huddle daemon"
}
