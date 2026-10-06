@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Whisper Studio WebUI - close this window to stop

set "NODE_EXE="
if exist "%~dp0.runtime\node\node.exe" set "NODE_EXE=%~dp0.runtime\node\node.exe"
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\scoop\apps\nodejs\current\node.exe" set "NODE_EXE=%USERPROFILE%\scoop\apps\nodejs\current\node.exe"

if not defined NODE_EXE (
  echo [Whisper Studio] Node.js 22.12 or newer is required.
  echo Install it from https://nodejs.org/ or add Node.js to PATH.
  pause
  exit /b 1
)

for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"

echo [Whisper Studio] Keep this window open while using the WebUI.
echo [Whisper Studio] Close this window to stop the entire project.
echo.
"%NODE_EXE%" scripts\launch.mjs %*
set "WHISPER_EXIT_CODE=%ERRORLEVEL%"

if not "%WHISPER_EXIT_CODE%"=="0" (
  echo.
  echo [Whisper Studio] Startup failed with code %WHISPER_EXIT_CODE%.
  pause
)

exit /b %WHISPER_EXIT_CODE%
