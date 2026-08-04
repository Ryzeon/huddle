@echo off
REM Levanta el hub en Windows. Una sola persona del equipo lo corre.
REM
REM   set HUDDLE_TOKEN=un-secreto
REM   huddle-hub.cmd
setlocal
cd /d "%~dp0"
npx --yes tsx packages/hub/src/composition/main.ts %*
