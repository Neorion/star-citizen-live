@echo off
REM One-click launcher for Windows. Double-click this file, or run it from a
REM terminal. The service has zero runtime dependencies (Node built-ins only),
REM so there is nothing to install - it just starts. Close the window or press
REM Ctrl+C to stop.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js LTS ^(18+^) from https://nodejs.org/
  echo Then rerun this file.
  pause
  exit /b 1
)

echo Starting Star Citizen Live - dashboard opens at http://localhost:3041/ (close this window to stop).
echo It auto-detects your Star Citizen install and tails the freshest Game.log (read-only).
REM Enable the optional cargo route-optimizer (Cargo tab: routing, inline cargo entry, UEX vocab).
set SC_CARGO_ROUTER=1
node app\server.js

pause
