@echo off
title Luna Backend
cd /d "%~dp0"

echo Starting Luna backend...
echo.
echo   Monitor UI:  http://127.0.0.1:8787/monitor
echo   Stop server: close this window or press Ctrl+C
echo.

npm run dev --workspace @giada/server

if errorlevel 1 (
  echo.
  echo Server exited with an error.
  pause
)
