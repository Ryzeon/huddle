@echo off
REM Envoltorio para Windows (CMD y PowerShell).
REM
REM   huddle.cmd join <sala> <@alias> --hub ws://IP:8787 --token <t>
REM   huddle.cmd daemon
REM   huddle.cmd ask @alguien "pregunta"
REM
REM Para registrarlo en Claude Code hace falta la ruta absoluta:
REM   claude mcp add huddle -- C:\ruta\a\huddle\huddle.cmd mcp
setlocal
cd /d "%~dp0"
npx --yes tsx packages/agent/src/adapters/inbound/cli.ts %*
