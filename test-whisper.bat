@echo off
title Luna Whisper Test
cd /d "%~dp0"

echo Luna Whisper microphone test
echo.
echo You will have 5 seconds to speak after recording starts.
echo Try: "Hey Luna, can you hear me?"
echo.

"C:\Users\User\Miniconda3\python.exe" scripts\test_whisper.py --record 5 --keep-wav
echo.
pause
