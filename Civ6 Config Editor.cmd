@echo off
title Civ6 Config Editor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required but was not found on this PC.
  echo   Install it from https://nodejs.org  then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   First run: installing dependencies, please wait...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   Install failed - see the messages above.
    pause
    exit /b 1
  )
)

echo.
echo   Starting the Civ6 Config Editor...
echo   Your browser will open automatically at http://127.0.0.1:8673
echo.
echo   ^>^>^>  Keep this window open while you use the editor.  ^<^<^<
echo   ^>^>^>  Close this window (or press Ctrl+C) to stop it.  ^<^<^<
echo.
call npm start

echo.
echo   The editor has stopped. You can close this window.
pause >nul
