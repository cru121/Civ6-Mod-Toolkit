@echo off
setlocal
title Civ6 Mod Toolkit
cd /d "%~dp0"

set "PORT=8673"
set "URL=http://127.0.0.1:%PORT%"
rem Tells the server it's running under this launcher (no "Ctrl+C" hint).
set "CIV6_LAUNCHER=1"

where node >nul 2>nul
if errorlevel 1 goto no_node
rem The Mod manager reads the game's mod database with Node's built-in SQLite
rem (Node 22.5+). Older Node runs everything else.
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
if errorlevel 1 goto old_node
goto node_ok

:no_node
echo.
echo   The Civ6 Mod Toolkit needs Node.js, which isn't installed on this PC.
set "NODE_WHY=install"
goto get_node

:old_node
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
echo.
echo   Your Node.js %NODE_VER% is too old for the Mod manager, which needs 22.5 or newer.
echo   Everything else works, but updating is recommended.
set "NODE_WHY=update"
goto get_node

:get_node
set "HAS_WINGET="
where winget >nul 2>nul
if not errorlevel 1 set "HAS_WINGET=1"
echo.
if defined HAS_WINGET echo     [I]  Install Node.js LTS automatically ^(using winget^)
echo     [D]  Open the Node.js download page in your browser
if "%NODE_WHY%"=="update" echo     [C]  Continue without updating
echo     [Q]  Quit
echo.
choice /c IDCQ /n /m "  Press a key: "
if errorlevel 4 exit /b 1
if errorlevel 3 goto get_node_continue
if errorlevel 2 goto get_node_download
if not defined HAS_WINGET goto get_node
echo.
echo   Installing Node.js LTS - Windows may ask you to confirm...
echo.
winget install --id OpenJS.NodeJS.LTS -e
if errorlevel 1 (
  echo.
  echo   The automatic install didn't finish. Try the download page instead [D].
  goto get_node
)
echo.
echo   Node.js is installed. Close this window and double-click
echo   "Civ6 Mod Toolkit.cmd" again - Windows needs a fresh window to find it.
echo.
pause
exit /b 0

:get_node_continue
if not "%NODE_WHY%"=="update" goto get_node
goto node_ok

:get_node_download
start "" "https://nodejs.org/en/download"
echo.
echo   Download and install the LTS version, then double-click
echo   "Civ6 Mod Toolkit.cmd" again.
echo.
pause
exit /b 1

:node_ok

where curl >nul 2>nul
if errorlevel 1 (
  echo.
  echo   This launcher needs curl, which comes with Windows 10 ^(2018^) and newer.
  echo   You can still run the toolkit from a terminal with:  npm start
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

rem Already running (e.g. launcher double-clicked twice)? Just open the page.
call :isrunning
if not errorlevel 1 (
  echo.
  echo   The toolkit is already running in another window - opening your browser.
  start "" "%URL%"
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

echo.
echo   Starting the Civ6 Mod Toolkit...
call :start

:menu
echo.
call :isrunning
if errorlevel 1 (
  echo   Status: stopped
) else (
  echo   Status: running at %URL%
)
echo.
echo     [O]  Open the toolkit in your browser
echo     [R]  Restart the toolkit
echo     [S]  Stop and close this window
echo.
choice /c ORS /n /m "  Press O, R or S: "
if errorlevel 3 goto stop
if errorlevel 2 goto restart
start "" "%URL%"
goto menu

:restart
echo.
echo   Restarting...
call :shutdown
rem The browser tab is already open; it reconnects by itself.
set "NO_OPEN=1"
call :start
set "NO_OPEN="
goto menu

:stop
echo.
echo   Stopping...
call :shutdown
exit /b 0

rem ---- helpers ---------------------------------------------------------------

rem Start the server in the background of this window and wait until it answers.
:start
start "" /b node src\server.js
set /a tries=0
:start_wait
call :isrunning
if not errorlevel 1 exit /b 0
set /a tries+=1
if %tries% geq 20 (
  echo   The toolkit did not start - see the messages above.
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto start_wait

rem errorlevel 0 when the toolkit answers.
:isrunning
curl -s -o nul --max-time 2 "%URL%/api/game"
exit /b %errorlevel%

rem Ask the server to stop and wait until it has.
:shutdown
call :isrunning
if errorlevel 1 exit /b 0
curl -s -o nul -X POST -H "Content-Type: application/json" -d "{}" "%URL%/api/shutdown"
set /a tries=0
:shutdown_wait
call :isrunning
if errorlevel 1 exit /b 0
set /a tries+=1
if %tries% geq 10 exit /b 1
ping -n 2 127.0.0.1 >nul
goto shutdown_wait
