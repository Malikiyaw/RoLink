@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "LOGDIR=logs"
set "LOGFILE=%LOGDIR%\start.log"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
call :log "=== RoLink start %date% %time% ==="
ver >> "%LOGFILE%" 2>&1
echo [RoLink] Starting... check logs/start.log for details
echo.

REM Guard: must be extracted, not zip preview
if not exist "bridge.py" (
  echo [ERROR] bridge.py not found. You opened the zip without extracting.
  echo Please right-click the zip -^> Extract All... then run start.bat from the extracted folder.
  call :log "ERROR zip preview"
  pause
  exit /b 1
)
if not exist "rolink-extension\manifest.json" (
  echo [WARN] rolink-extension missing - extension may not load.
  call :log "WARN extension missing"
)

REM Find Python >=3.9 with cascade: py -3 -> python -> scan -> winget
set "PY="
set "PYVER="
call :find_python
if not defined PY (
  echo [ERROR] Python 3.9+ not found. Installing via winget...
  call :log "winget install Python"
  winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements >nul 2>&1
  call :find_python
)
if not defined PY (
  echo [ERROR] Python still not found. Install manually from https://python.org/downloads
  call :log "ERROR python not found post winget"
  pause
  exit /b 1
)
"%PY%" --version >> "%LOGFILE%" 2>&1
call :log "Using PY=%PY%"

REM Validate pip + version
"%PY%" -c "import sys; assert sys.version_info >= (3,9), 'need 3.9'" 2>nul
if errorlevel 1 (
  echo [ERROR] Python ^<3.9. Please update Python.
  pause
  exit /b 1
)
"%PY%" -m pip --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pip not found for %PY%
  pause
  exit /b 1
)

REM Deps: websockets
"%PY%" -c "import websockets" 2>nul
if errorlevel 1 (
  echo [RoLink] Installing websockets...
  call :log "pip install websockets"
  "%PY%" -m pip install --user websockets >> "%LOGFILE%" 2>&1
  "%PY%" -c "import websockets" 2>nul
  if errorlevel 1 (
    echo [ERROR] Failed to install websockets. Check firewall/antivirus.
    type "%LOGFILE%"
    pause
    exit /b 1
  )
)

REM Reclaim :17613
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /C:":17613" ^| findstr LISTENING 2^>nul') do (
  echo [RoLink] Port 17613 busy, killing PID %%a
  call :log "killing 17613 pid %%a"
  taskkill /F /T /PID %%a >nul 2>&1
  timeout /t 1 >nul
)
REM Verify free
netstat -aon | findstr /C:":17613" | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
  echo [WARN] Port 17613 still busy. Close other RoLink bridges.
  call :log "WARN port still busy"
)

echo.
echo ============================================
echo  RoLink Bridge running — KEEP THIS WINDOW OPEN
echo  Bridge: ws://127.0.0.1:17613  MCP: StudioMCP via config.json
echo  Next: load rolink-extension in chrome://extensions
echo  Then open chat.deepseek.com / chatgpt.com etc. and click Start session
echo ============================================
echo.
call :log "launch bridge.py"
"%PY%" bridge.py
set "EC=%errorlevel%"
echo.
echo [RoLink] Bridge exited with code %EC%
call :log "exit %EC%"
pause
exit /b %EC%

:find_python
REM Try py -3 first (avoids Store stub)
py -3 --version >nul 2>&1
if not errorlevel 1 (
  for /f "tokens=*" %%i in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do set "PY=%%i"
  if defined PY exit /b 0
)
REM Try python but skip WindowsApps stub (pip check)
python --version >nul 2>&1
if not errorlevel 1 (
  python -m pip --version >nul 2>&1
  if not errorlevel 1 (
    for /f "tokens=*" %%i in ('python -c "import sys; print(sys.executable)" 2^>nul') do set "PY=%%i"
    if defined PY exit /b 0
  )
)
REM Scan common locations newest first
for %%B in ("%LOCALAPPDATA%\Programs\Python" "%ProgramFiles%" "%ProgramFiles(x86)%") do (
  if exist "%%~B\Python3*" (
    for /f "delims=" %%P in ('dir /b /o-n "%%~B\Python3*" 2^>nul') do (
      if exist "%%~B\%%P\python.exe" (
        "%%~B\%%P\python.exe" -m pip --version >nul 2>&1
        if not errorlevel 1 (
          set "PY=%%~B\%%P\python.exe"
          exit /b 0
        )
      )
    )
  )
)
exit /b 0

:log
>>"%LOGFILE%" echo(%~1 %~2 %~3 %~4 %~5 %~6 %~7 %~8 %~9
exit /b 0
