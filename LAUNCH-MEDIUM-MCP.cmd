@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ===========================================================================
rem  Medium MCP Server - one-click launcher
rem  Double-click this file. It installs dependencies, builds, and starts the
rem  MCP server. A browser window opens on first run so you can sign in.
rem
rem  Usage:
rem    LAUNCH-MEDIUM-MCP.cmd          start the server (normal use)
rem    LAUNCH-MEDIUM-MCP.cmd test     self-check only, no server left running
rem    LAUNCH-MEDIUM-MCP.cmd reset    clear the saved Medium login session
rem ===========================================================================

set "APP_DIR=%~dp0"
set "LOG=%APP_DIR%launcher.log"
set "NODE_DIR=%APPDATA%\npm"

echo.
echo   ============================================
echo     Medium MCP Server - Studio Voix d'Or
echo   ============================================
echo.

rem --- locate node ---------------------------------------------------------
set "NODE=node"
where node >nul 2>&1
if errorlevel 1 (
  if exist "%NODE_DIR%\node.exe" (
    set "NODE=%NODE_DIR%\node.exe"
  ) else (
    echo   [X] Node.js not found.
    echo.
    echo   Install Node.js 18+ from https://nodejs.org/ then double-click again.
    echo.
    pause
    exit /b 1
  )
)
for /f "tokens=*" %%v in ('"%NODE%" -v') do set "NODE_VER=%%v"
echo   [1/4] Node.js %NODE_VER%

rem --- dependencies --------------------------------------------------------
if not exist "%APP_DIR%node_modules\playwright\package.json" (
  echo   [2/4] Installing dependencies ^(first run, takes a minute^)...
  call npm install --include=dev --no-audit --no-fund >>"%LOG%" 2>&1
  if errorlevel 1 (
    echo   [X] npm install failed. Details:
    type "%LOG%"
    pause
    exit /b 1
  )
) else (
  echo   [2/4] Dependencies present
)

rem --- build ---------------------------------------------------------------
if not exist "%APP_DIR%dist\index.js" (
  echo   [3/4] Building...
  call npx tsc >>"%LOG%" 2>&1
  if errorlevel 1 (
    echo   [X] Build failed. Details:
    type "%LOG%"
    pause
    exit /b 1
  )
) else (
  echo   [3/4] Build present
)

rem --- chromium browser ----------------------------------------------------
if not exist "%LOCALAPPDATA%\ms-playwright" (
  echo   [4/4] Downloading Chromium ^(first run^)...
  call npx playwright install chromium >>"%LOG%" 2>&1
) else (
  echo   [4/4] Browser present
)

if /i "%~1"=="reset" (
  echo.
  echo   Clearing saved Medium session...
  del /q "%USERPROFILE%\.medium-mcp-session.json" >nul 2>&1
  rmdir /s /q "%USERPROFILE%\.medium-mcp-chrome" >nul 2>&1
  echo   Done. The next run will ask you to sign in again.
  echo.
  pause
  exit /b 0
)

if /i "%~1"=="test" (
  echo.
  echo   Self-check: starting server and listing tools...
  echo.
  node "%APP_DIR%selfcheck.js"
  echo.
  pause
  exit /b 0
)

rem --- run -----------------------------------------------------------------
echo.
echo   Starting Medium MCP Server.
echo   A browser window opens the first time so you can sign in to Medium.
echo   Close this window to stop the server.
echo.
node "%APP_DIR%dist\index.js"

echo.
echo   Server stopped.
pause
endlocal
