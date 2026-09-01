:: SPDX-License-Identifier: GPL-3.0-or-later
@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title RoLink Bridge
cd /d "%~dp0"
if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>nul
set "LOGFILE=%~dp0logs\start.log"
call :log "===== %DATE% %TIME% start.bat launched ====="
for /f "tokens=*" %%v in ('ver') do call :log "%%v"

REM --- Guard: must be extracted, not zip preview ---
if not exist "%~dp0bridge.py" (
  echo [ERROR] bridge.py not found. Extract the zip first (right-click -> Extract All...).
  echo Then run start.bat from the extracted folder.
  call :log "ERROR zip preview bridge.py missing"
  pause
  exit /b 1
)
if not exist "%~dp0rolink-extension\manifest.json" (
  echo [WARN] rolink-extension\manifest.json missing - extension will not load.
  call :log "WARN extension missing"
)

REM --- Find Python >=3.9 ---
set "PY="
call :find_python
if not defined PY (
  echo [RoLink] Python 3.9+ not found. Trying winget...
  call :log "winget install Python"
  where winget >nul 2>&1
  if not errorlevel 1 (
    winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements >nul 2>&1
    call :find_python
  )
)
if not defined PY (
  echo [ERROR] Python 3.9+ not found. Install from https://python.org/downloads
  call :log "ERROR python not found post winget"
  pause
  exit /b 1
)
call :log "Using PY=%PY%"

REM --- Validate Python ---
call :validate_py
if errorlevel 1 (
  echo [ERROR] Python validation failed. Need 3.9+ with pip.
  pause
  exit /b 1
)

REM --- websockets dep ---
%PY% -c "import websockets" 2>nul
if errorlevel 1 (
  echo [RoLink] Installing websockets...
  call :log "pip install websockets"
  %PY% -m pip install --user websockets >> "%LOGFILE%" 2>&1
  %PY% -c "import websockets" 2>nul
  if errorlevel 1 (
    echo [ERROR] Failed to install websockets. Check logs\start.log
    call :log "ERROR pip install websockets failed"
    pause
    exit /b 1
  )
)

REM --- Reclaim :17613 ---
set "PORTBUSY=0"
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /C:":17613" ^| findstr LISTENING 2^>nul') do (
  echo [RoLink] Port 17613 busy, killing PID %%a
  call :log "killing 17613 pid %%a"
  taskkill /F /T /PID %%a >nul 2>&1
  timeout /t 1 /nobreak >nul 2>&1
  set "PORTBUSY=1"
)
netstat -aon | findstr /C:":17613" | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
  echo [WARN] Port 17613 still busy. Close other RoLink bridges.
  call :log "WARN port still busy"
)

echo.
echo ============================================
echo  RoLink Bridge running -- KEEP THIS WINDOW OPEN
echo  Bridge: ws://127.0.0.1:17613
echo  Next: load rolink-extension in chrome://extensions
echo  Then open chat.deepseek.com / chatgpt.com etc.
echo ============================================
echo.
call :log "launch bridge.py"
"%PY%" "%~dp0bridge.py"
set "BRIDGE_EXIT=%errorlevel%"
echo.
if not "%BRIDGE_EXIT%"=="0" (
  echo [RoLink] Bridge exited with code %BRIDGE_EXIT% - check logs\start.log
  call :log "ERROR bridge exit %BRIDGE_EXIT%"
) else (
  echo [RoLink] Bridge stopped normally
  call :log "bridge exit 0"
)
pause >nul
exit /b %BRIDGE_EXIT%

:find_python
REM Try py -3 first (avoids Store stub)
where py >nul 2>&1
if not errorlevel 1 (
  py -3 --version >nul 2>&1
  if not errorlevel 1 (
    for /f "tokens=*" %%i in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do set "PY=%%i"
    if defined PY exit /b 0
  )
)
REM Try python but skip WindowsApps stub (pip check)
where python >nul 2>&1
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

:validate_py
%PY% -c "import sys; assert sys.version_info >= (3,9), 'need 3.9'" 2>nul
if errorlevel 1 (
  echo [ERROR] Python below 3.9. Please update.
  call :log "ERROR python <3.9"
  exit /b 1
)
%PY% -m pip --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pip not found for %PY%
  call :log "ERROR pip missing"
  exit /b 1
)
exit /b 0

:log
>>"%LOGFILE%" 2>nul echo(%~1 %~2 %~3 %~4 %~5 %~6 %~7 %~8 %~9
exit /b 0
