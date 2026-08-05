@echo off
REM Lanzador de Windows.
REM
REM Usa el codigo ya compilado si existe: es diez veces mas rapido que `tsx` y,
REM sobre todo, no deja `esbuild.exe` abierto, que en Windows impide reemplazar
REM la instalacion al actualizar.
setlocal
cd /d "%~dp0"
if exist "packages\agent\dist\adapters\inbound\cli.js" (
  node "packages\agent\dist\adapters\inbound\cli.js" %*
) else (
  npx --yes tsx packages/agent/src/adapters/inbound/cli.ts %*
)
