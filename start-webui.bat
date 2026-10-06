@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Whisper Studio WebUI - close this window to stop

echo [Whisper Studio] Keep this window open while using the WebUI.
echo [Whisper Studio] Close this window to stop the entire project.
echo.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-windows.ps1" %*
set "WHISPER_EXIT_CODE=%ERRORLEVEL%"

if not "%WHISPER_EXIT_CODE%"=="0" (
  echo.
  echo [Whisper Studio] Startup failed with code %WHISPER_EXIT_CODE%.
  pause
)

exit /b %WHISPER_EXIT_CODE%
