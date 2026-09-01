:: SPDX-License-Identifier: GPL-3.0-or-later
@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title RoLink Bridge
cd /d "%~dp0"

if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>nul
set "LOGFILE=%~dp0logs\start.log"
call :log "===== %DATE% %TIME%  start.bat launched ====="
for /f "tokens=*" %%v in ('ver') do call :log "%%v"

echo.
echo   === RoLink Bridge ===
echo.

if not exist "%~dp0bridge.py" (
    echo   ERROR: bridge.py not found next to start.bat.
    echo.
    echo   If you opened start.bat from inside the downloaded ZIP, first EXTRACT
    echo   the whole ZIP ^(right-click, "Extract All..."^), then run start.bat
    echo   from the extracted folder.
    echo.
    call :log "FATAL: bridge.py missing next to start.bat (run from inside ZIP?)."
    pause
    exit /b 1
)
if not exist "%~dp0rolink-extension\manifest.json" (
    echo   WARN: rolink-extension\manifest.json not found - the browser extension
    echo   will not load. Re-download / re-extract the ZIP.
    call :log "WARN: rolink-extension missing."
)

REM --- 1. Find Python ---------------------------------------------------------
echo   [1/3] Looking for Python...
set "PY="

where py >nul 2>nul && set "PY=py -3"
call :validate_py && goto :found

set "PY=python"
call :validate_py && goto :found

for %%R in (
    "%LOCALAPPDATA%\Programs\Python"
    "%ProgramFiles%"
    "%ProgramFiles(x86)%"
) do (
    if exist "%%~R" (
        for /f "delims=" %%D in ('dir /b /ad /o-n "%%~R\Python3*" 2^>nul') do (
            if exist "%%~R\%%D\python.exe" (
                set PY="%%~R\%%D\python.exe"
                call :validate_py && goto :found
            )
        )
    )
)

set "PY="
call :log "Python not found on PATH or in standard install folders."
goto :need_install

:found
for /f "tokens=*" %%v in ('call "%PY%" --version 2^>^&1') do (
    echo         Found: %PY%  ^(%%v^)
    call :log "Python found: %PY% (%%v)"
)
goto :install_deps

:need_install
where winget >nul 2>nul
set "WINGET_OK=1"
if errorlevel 1 set "WINGET_OK=0"

if "%WINGET_OK%"=="1" (
    echo         Not found. Trying winget first...
    echo.
    winget install --id Python.Python.3.12 --source winget --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        call :log "winget install failed (errorlevel=%errorlevel%). Falling back to direct download."
        echo.
        echo         winget failed - downloading Python directly from python.org...
        echo.
        goto :direct_dl
    )
    echo.
    echo   Checking again after winget...
    set "PY=py -3"
    call :validate_py && goto :ready
    set "PY=python"
    call :validate_py && goto :ready
    for %%R in (
        "%LOCALAPPDATA%\Programs\Python"
        "%ProgramFiles%"
        "%ProgramFiles(x86)%"
    ) do (
        if exist "%%~R" (
            for /f "delims=" %%D in ('dir /b /ad /o-n "%%~R\Python3*" 2^>nul') do (
                if exist "%%~R\%%D\python.exe" (
                    set PY="%%~R\%%D\python.exe"
                    call :validate_py && goto :ready
                )
            )
        )
    )
    call :log "winget returned OK but no Python found on PATH. Falling back to direct download."
)

:direct_dl
REM --- Direct download fallback: embeddable Python 3.12 zip --------------------
REM Winget on corporate / restricted Windows often fails with
REM "0x8a15000f : Data required by the source is missing" (broken winget source).
REM The embeddable zip from python.org is a self-contained, NO-INSTALLER,
REM NO-ADMIN bundle that extracts to a folder and just works. This is the most
REM reliable fallback on locked-down machines.
echo.
echo   Downloading Python 3.12 (embeddable, no admin needed) from python.org...
echo.

REM Use hardcoded fallback paths so we never depend on %TEMP% / %LOCALAPPDATA%
REM being defined (some locked-down / cmd /c relaunched sessions have them empty).
if defined TEMP (set "ROlink_TEMP=%TEMP%") else (set "ROlink_TEMP=%SystemRoot%\Temp")
if defined LOCALAPPDATA (set "ROlink_LA=%LOCALAPPDATA%") else (set "ROlink_LA=%USERPROFILE%\AppData\Local")
set "PYDIR=%ROlink_LA%\Programs\Python\RoLinkPython312"
set "PYEXE=%ROlink_LA%\Programs\Python\RoLinkPython312\python.exe"
set "PYZIP=%ROlink_TEMP%\rolink-python312.zip"
set "GETPIP=%ROlink_TEMP%\rolink-get-pip.py"

REM Hardcoded URLs (no env-var indirection anywhere).
set "URL_PY=https://www.python.org/ftp/python/3.12.7/python-3.12.7-embed-amd64.zip"
set "URL_PIP=https://bootstrap.pypa.io/get-pip.py"

call :log "direct_dl: PYEXE=%PYEXE%"

REM Write the download PowerShell script to a real .ps1 file and run it with
REM -File. Passing URLs/paths as separate args via -Command + $args[] is fragile
REM across PowerShell versions; -File + $args is the documented, reliable path.
set "DL_PS1=%ROlink_TEMP%\rolink-download.ps1"
> "%DL_PS1%" echo $ErrorActionPreference = 'Stop'
>> "%DL_PS1%" echo [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
>> "%DL_PS1%" echo try { Invoke-WebRequest -Uri $args[0] -OutFile $args[1] -UseBasicParsing; exit 0 } catch { Write-Host ('Download failed: ' + $_.Exception.Message); exit 1 }

powershell -NoProfile -ExecutionPolicy Bypass -File "%DL_PS1%" "%URL_PY%" "%PYZIP%"
if errorlevel 1 (
    echo   ERROR: Direct download failed. Install Python manually from
    echo   https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^).
    call :log "FATAL: direct python.org download failed."
    pause
    exit /b 1
)
call :log "Downloaded Python embeddable zip to %PYZIP%."

if not exist "%PYDIR%" mkdir "%PYDIR%" >nul 2>nul
> "%DL_PS1%" echo $ErrorActionPreference = 'Stop'
>> "%DL_PS1%" echo try { Expand-Archive -Path $args[0] -DestinationPath $args[1] -Force; exit 0 } catch { Write-Host ('Extract failed: ' + $_.Exception.Message); exit 1 }
powershell -NoProfile -ExecutionPolicy Bypass -File "%DL_PS1%" "%PYZIP%" "%PYDIR%"
if errorlevel 1 (
    echo   ERROR: Could not extract Python zip. Install manually.
    call :log "FATAL: extract of embeddable Python zip failed."
    pause
    exit /b 1
)
call :log "Extracted Python to %PYDIR%."

if not exist "%PYEXE%" (
    echo   ERROR: %PYEXE% missing after extract. Install manually.
    call :log "FATAL: python.exe missing after extract."
    pause
    exit /b 1
)

REM Embeddable zip ships python.exe + python312._pth (which DISABLES site-packages
REM AND pip). Patch python312._pth so site-packages work, then bootstrap pip.
set "PYPTH=%PYDIR%\python312._pth"
if exist "%PYPTH%" (
    > "%DL_PS1%" echo $p = $args[0]
    >> "%DL_PS1%" echo $c = Get-Content $p
    >> "%DL_PS1%" echo $c = $c -replace '^#import site','import site'
    >> "%DL_PS1%" echo $c ^| Set-Content $p
    powershell -NoProfile -ExecutionPolicy Bypass -File "%DL_PS1%" "%PYPTH%"
    call :log "Patched %PYPTH% to enable site-packages."
)

REM Bootstrap pip into the embeddable Python.
powershell -NoProfile -ExecutionPolicy Bypass -File "%DL_PS1%" "%URL_PIP%" "%GETPIP%"
if errorlevel 1 (
    call :log "WARN: get-pip.py download failed; continuing without pip."
) else (
    "%PYEXE%" "%GETPIP%" --no-warn-script-location >nul 2>&1
    if errorlevel 1 (
        call :log "WARN: get-pip.py bootstrap failed; pip may be unavailable."
    ) else (
        call :log "Bootstrapped pip into embeddable Python."
    )
)

set "PY=%PYEXE%"
call :validate_py
if errorlevel 1 (
    echo.
    echo   ERROR: Embeddable Python did not validate. Dumping details:
    echo   PYEXE=%PYEXE%
    echo   "%PYEXE%" --version:
    call "%PYEXE%" --version 2>&1
    echo   "%PYEXE%" -m pip --version:
    call "%PYEXE%" -m pip --version 2>&1
    echo.
    echo   Install Python manually from https://www.python.org/downloads/
    echo   ^(tick "Add python.exe to PATH"^) then run this again.
    call :log "FATAL: embeddable Python failed validation. See console above."
    pause
    exit /b 1
)
echo         Python ready (embeddable, no admin)!
call :log "Python ready via direct download: %PY%"
goto :install_deps

:ready
echo         Python ready!
call :log "Python ready after winget install: %PY%"

:install_deps
REM --- 2. Install websockets --------------------------------------------------
echo.
echo   [2/3] Checking websockets library...
call "%PY%" -c "import websockets" >nul 2>nul
if errorlevel 1 (
    echo         Installing websockets - first time only...
    call "%PY%" -m pip install --user websockets
    if errorlevel 1 (
        echo.
        echo   ERROR: Could not install websockets ^(see pip output above^).
        echo   Common causes: no internet, a firewall/antivirus blocking pip,
        echo   or Python has no working pip. If you used the Microsoft Store
        echo   python, install from https://www.python.org/downloads/ instead
        echo   ^(tick "Add to PATH"^).
        echo.
        call :log "FATAL: pip install websockets failed."
        pause
        exit /b 1
    )
)
echo         OK
call :log "websockets library OK"

REM --- 3. Run the bridge ------------------------------------------------------
echo.
echo   [3/3] Starting bridge...

set "OLDPID="
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :17613 ^| findstr LISTENING 2^>nul') do (
    set "OLDPID=%%a"
)
if defined OLDPID (
    echo         A previous bridge ^(pid !OLDPID!^) is already running on this port.
    echo         Replacing it with this new instance...
    call :log "Killing previous bridge instance (pid !OLDPID!) on port 17613."
    taskkill /F /T /PID !OLDPID! >nul 2>nul
    timeout /t 1 /nobreak >nul
    set "STILLTHERE="
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr :17613 ^| findstr LISTENING 2^>nul') do (
        set "STILLTHERE=%%a"
    )
    if defined STILLTHERE (
        echo.
        echo   WARNING: port 17613 is still held by pid !STILLTHERE! after trying
        echo   to close the previous bridge. If the bridge below fails to start,
        echo   close that process manually in Task Manager ^(or restart Windows^)
        echo   and run start.bat again.
        echo.
        call :log "WARNING: port 17613 still held by pid !STILLTHERE! after taskkill."
    )
)

echo.
echo  ############################################################
echo  ##                                                        ##
echo  ##   KEEP THIS TERMINAL OPEN - DO NOT CLOSE THIS WINDOW   ##
echo  ##                                                        ##
echo  ##   RoLink stops working if you close it. Just           ##
echo  ##   minimize this window and leave it running.           ##
echo  ##                                                        ##
echo  ############################################################
echo.
call :log "Launching bridge.py with %PY%"
call %PY% "%~dp0bridge.py"
set "BRIDGE_EXIT=%errorlevel%"
call :log "bridge.py exited with code %BRIDGE_EXIT%"

echo.
if not "%BRIDGE_EXIT%"=="0" (
    echo   Bridge stopped with ERROR code %BRIDGE_EXIT% - scroll up for the Python
    echo   error message and include THIS WHOLE WINDOW in any bug report.
    echo   Log file: logs\start.log
) else (
    echo   Bridge stopped normally.
)
echo   Press any key to close.
pause >nul
exit /b 0

:validate_py
call %PY% -m pip --version >nul 2>nul || exit /b 1
call %PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
exit /b %errorlevel%

:log
>>"%LOGFILE%" 2>nul echo(%~1
exit /b 0
