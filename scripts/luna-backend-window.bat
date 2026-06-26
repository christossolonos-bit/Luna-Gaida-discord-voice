@echo off
title Luna Backend
cd /d "%~dp0.."
echo Step 1/2: Starting Luna backend...
npm run dev --workspace @giada/server
if errorlevel 1 pause
