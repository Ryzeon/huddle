# Instala o actualiza Huddle desde GitHub, en Windows.
#
#   irm https://raw.githubusercontent.com/Ryzeon/huddle/main/scripts/install.ps1 | iex
#
# O con parámetros:
#   .\install.ps1 -Alias @tualias
#
# Volver a ejecutarlo actualiza a la última versión publicada.
param(
  [string]$Alias,
  [string]$Room,
  [string]$Hub = "ws://localhost:8787",
  [string]$Expose = $PWD.Path,
  [switch]$Update,
  [switch]$NoMcp,
  [switch]$NoDaemon
)

$ErrorActionPreference = "Stop"

$repoSlug = "Ryzeon/huddle"
$prefix = if ($env:HUDDLE_PREFIX) { $env:HUDDLE_PREFIX } else { Join-Path $HOME ".huddle" }
$app = Join-Path $prefix "app"
$binDir = Join-Path $env:LOCALAPPDATA "Huddle\bin"

function Gris($m) { Write-Host $m -ForegroundColor DarkGray }
function Verde($m) { Write-Host $m -ForegroundColor Green }

if (-not $Update) {
  if (-not $Alias) { $Alias = Read-Host "Con que alias apareces en las salas (ej. @ryzeon)" }
  if (-not $Alias) { throw "Falta -Alias: con que nombre apareces en las salas." }

  $respuesta = Read-Host "A que hub te conectas [$Hub]"
  if ($respuesta) { $Hub = $respuesta }
}

# --- Requisitos -------------------------------------------------------------

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Hace falta Node. Instalalo desde https://nodejs.org"
}
# Se lee `node --version` y se parte en PowerShell: pasarle a Node un `-p` con
# comillas dobles dentro no sobrevive al paso por PowerShell, que se las come y
# le deja a Node un `split(.)` que no compila.
$versionNode = (node --version) -replace '^v', ''
$major = [int]($versionNode.Split('.')[0])
if ($major -lt 20) { throw "Node $versionNode es demasiado viejo; hace falta 20 o superior." }

if (-not $NoMcp -and -not (Get-Command claude -ErrorAction SilentlyContinue)) {
  throw "No encuentro el CLI de Claude Code. Instalalo desde https://claude.com/claude-code, o usa -NoMcp"
}

# --- Que version toca -------------------------------------------------------

# Se pide la lista, no `/releases/latest`: ese endpoint se salta las
# prereleases, y mientras el proyecto este en beta no encontraria ninguna.
$tag = "main"
try {
  $releases = Invoke-RestMethod "https://api.github.com/repos/$repoSlug/releases?per_page=1" `
    -Headers @{ "User-Agent" = "huddle-install" }
  $primera = @($releases)[0]
  if ($primera -and $primera.tag_name) { $tag = $primera.tag_name }
} catch {
  Gris "sin releases publicadas todavia; instalando desde main"
}

$versionFile = Join-Path $prefix "version"
$instalada = if (Test-Path $versionFile) { Get-Content $versionFile -Raw } else { "" }

if ($instalada.Trim() -eq $tag -and $tag -ne "main" -and (Test-Path $app)) {
  Verde "ya tienes la $tag, que es la ultima."
  if ($Update) { return }
} else {
  Gris "descargando $tag..."
  $url = if ($tag -eq "main") {
    "https://github.com/$repoSlug/archive/refs/heads/main.zip"
  } else {
    "https://github.com/$repoSlug/archive/refs/tags/$tag.zip"
  }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("huddle-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    $zip = Join-Path $tmp "huddle.zip"
    Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $tmp -Force
    $extraido = Get-ChildItem $tmp -Directory | Select-Object -First 1

    # Se reemplaza entero en vez de mezclar: un archivo que desaparecio en la
    # version nueva no debe seguir ahi. La config vive fuera, en $prefix.
    New-Item -ItemType Directory -Path $prefix -Force | Out-Null

    # Windows no deja borrar un ejecutable en marcha, y el daemon tiene abierto
    # el `esbuild.exe` de tsx. Se para antes de reemplazar nada.
    $antiguo = Join-Path $app "huddle.cmd"
    if (Test-Path $antiguo) {
      try { & $antiguo stop 2>&1 | Out-Null } catch { }
      Start-Sleep -Milliseconds 800
    }

    if (Test-Path $app) {
      try {
        Remove-Item $app -Recurse -Force -ErrorAction Stop
      } catch {
        throw "No se pudo reemplazar la instalacion: hay un proceso usandola. " +
              "Cierra el daemon (huddle stop, o cierra su ventana) y vuelve a intentarlo."
      }
    }
    Move-Item $extraido.FullName $app
    Set-Content -Path $versionFile -Value $tag -NoNewline

    Gris "instalando dependencias y compilando..."
    Push-Location $app
    try {
      npm install --silent --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm install fallo con codigo $LASTEXITCODE" }
      npx tsc --build
      if ($LASTEXITCODE -ne 0) { throw "la compilacion fallo con codigo $LASTEXITCODE" }
    } finally { Pop-Location }
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# --- Dejarlo en el PATH -----------------------------------------------------

# En Windows el lanzador es el .cmd: `huddle` a secas es un script de bash y el
# sistema ofreceria elegir con que abrirlo.
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
$huddle = Join-Path $app "huddle.cmd"

# Un .cmd que delega, en vez de un enlace simbolico: crearlos pide permisos de
# administrador o modo desarrollador, y esto funciona siempre.
Set-Content -Path (Join-Path $binDir "huddle.cmd") -Value "@echo off`r`n`"$huddle`" %*"
# Se baja el instalador de la red en vez de usar el que vino con la release:
# si el actualizador viviera solo dentro de la version instalada, un fallo suyo
# no se podria arreglar nunca desde fuera.
$lineaUpdate = '@echo off' + "`r`n" +
  'powershell -ExecutionPolicy Bypass -Command "' +
  '$t = Join-Path $env:TEMP (''huddle-install.ps1''); ' +
  'irm https://raw.githubusercontent.com/Ryzeon/huddle/main/scripts/install.ps1 -OutFile $t; ' +
  '& $t -Update' +
  '"'
Set-Content -Path (Join-Path $binDir "huddle-update.cmd") -Value $lineaUpdate

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
  Gris "anadido $binDir al PATH; abre una terminal nueva para que surta efecto"
}

Verde "huddle instalado en $binDir ($tag)"

if ($Update) { Verde "actualizado."; return }

# --- Registrar el MCP -------------------------------------------------------

if (-not $NoMcp) {
  # Idempotente: si ya estaba, se reemplaza en vez de duplicarse. El `try` es
  # porque un comando nativo que falla con `2>$null` sigue disparando el
  # ErrorActionPreference y mataria el script.
  try { claude mcp remove huddle 2>&1 | Out-Null } catch { }

  # El alias y el hub viajan como entorno del MCP: son los valores por defecto
  # que usara `room_join` cuando le pases solo el codigo de la sala.
  #
  # Los argumentos van en una lista: el `--` suelto lo puede interpretar
  # PowerShell antes de que llegue a `claude`, y asi pasa literal.
  # `--scope user`, no el `local` por defecto: local ata el MCP al directorio
  # desde el que se instalo, asi que Claude no lo veria en ningun otro proyecto.
  # Se registra con `node` y el .js compilado, no con el .cmd: Windows abre una
  # consola cada vez que ejecuta un archivo por lotes, y Claude lanza el MCP a
  # menudo. Apuntando a node no parpadea nada.
  $cliCompilado = Join-Path $app "packages\agent\dist\adapters\inbound\cli.js"
  if (Test-Path $cliCompilado) {
    $ejecutable = (Get-Command node).Source
    $primerArg = $cliCompilado
  } else {
    $ejecutable = $huddle
    $primerArg = $null
  }

  $argumentos = @(
    'mcp', 'add', 'huddle', '--scope', 'user',
    '--env', "HUDDLE_ALIAS=$Alias",
    '--env', "HUDDLE_HUB=$Hub",
    '--', $ejecutable
  )
  if ($primerArg) { $argumentos += $primerArg }
  $argumentos += 'mcp'
  & claude @argumentos
  Verde "servidor MCP registrado: tu agente ya puede preguntar por ti"
}

Write-Host ""
Verde "Listo. Para actualizar mas adelante:  huddle-update"
Write-Host ""

if (-not $Room) {
  Write-Host "Ya puedes entrar a una sala. Dile a Claude:"
  Write-Host "  <<entrame a la sala ABCDE-12345>>"
  Write-Host ""
  Write-Host "O desde el terminal:"
  Write-Host "  huddle join ABCDE-12345 $Alias"
  return
}

& $huddle join $Room $Alias --hub $Hub --cwd (Resolve-Path $Expose).Path --force
if ($LASTEXITCODE -ne 0) { throw "no se pudo entrar a la sala" }

if (-not $NoDaemon) {
  Write-Host "Arrancando el daemon. Dejalo abierto; Ctrl+C para salir de la sala."
  Write-Host ""
  & $huddle daemon
}
