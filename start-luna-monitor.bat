@echo off
title Luna Monitor
cd /d "%~dp0"

echo Luna live monitor
echo Opening browser dashboard...
start "" "http://127.0.0.1:8787/monitor"
echo Terminal log below. Press Ctrl+C to stop.
echo.

npm run monitor

pause
