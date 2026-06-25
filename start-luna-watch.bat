@echo off
title Luna Watch
cd /d "%~dp0"
echo Luna performance watch - live events every 2s
echo.
node scripts\luna-watch.mjs
pause
