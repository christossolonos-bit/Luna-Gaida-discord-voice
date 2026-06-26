@echo off
setlocal enabledelayedexpansion
title Luna Avatar
cd /d "%~dp0.."

if not defined LUNA_FLUFFY_PATH (
  for /f "usebackq tokens=1,* delims==" %%a in ("%~dp0..\.env") do (
    if /i "%%a"=="LUNA_FLUFFY_PATH" set "LUNA_FLUFFY_PATH=%%b"
  )
)
if not defined LUNA_FLUFFY_PATH set "LUNA_FLUFFY_PATH=D:\live2d model viewer"

if not exist "%LUNA_FLUFFY_PATH%\package.json" (
  echo.
  echo Fluffy Live2D project not found at:
  echo   %LUNA_FLUFFY_PATH%
  echo.
  echo Set LUNA_FLUFFY_PATH in GiadaAssistant\.env
  pause
  exit /b 1
)

echo Step 2/2: Waiting for Luna backend before opening avatar...
set /a _waits=0
:wait_luna
curl -sf http://127.0.0.1:8787/health >nul 2>&1
if not errorlevel 1 goto luna_ready
set /a _waits+=1
if !_waits! geq 45 (
  echo.
  echo Luna backend is not responding on http://127.0.0.1:8787
  echo Start Luna first with start-luna.bat
  pause
  exit /b 1
)
timeout /t 2 /nobreak >nul
goto wait_luna

:luna_ready
echo Luna backend is ready.
echo Opening Fluffy Live2D avatar (synced to Luna)...
set LUNA_SYNC=1
if not defined LUNA_LIVE2D_MODEL (
  for /f "usebackq tokens=1,* delims==" %%a in ("%~dp0..\.env") do (
    if /i "%%a"=="LUNA_LIVE2D_MODEL" set "LUNA_LIVE2D_MODEL=%%b"
  )
)
if not defined LUNA_LIVE2D_MODEL set "LUNA_LIVE2D_MODEL=D:\live2d model viewer\tuzi_mian__2_\tuzi mian.model3.json"
cd /d "%LUNA_FLUFFY_PATH%"
call npm run app
if errorlevel 1 pause
