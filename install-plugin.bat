:: SPDX-License-Identifier: GPL-3.0-or-later
:: install-plugin.bat - installs the RoLink Studio plugin (third-party MCP path).
:: Copies studio-plugin\RoLink.lua into Roblox Studio's Plugins folder so the
:: 119 registry tools execute inside Studio via the bridge's :3001 queue.
@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0studio-plugin\RoLink.lua" (
    echo   ERROR: studio-plugin\RoLink.lua not found next to this file.
    echo   Extract the WHOLE download, then run this again.
    pause
    exit /b 1
)

set "PLUGINDIR=%LOCALAPPDATA%\Roblox\Plugins"
if not exist "%PLUGINDIR%" mkdir "%PLUGINDIR%" >nul 2>nul
REM Exactly ONE plugin copy may exist: two copies poll the same queue and
REM fight over claims (one executes, the other reports confusing duplicates).
REM Remove known strays from manual installs/renames (never touch other files).
for %%F in ("%PLUGINDIR%\user_RoLink.lua" "%PLUGINDIR%\RoLink*.lua.bak") do (
    if exist "%%~F" (
        echo   Removing stray duplicate: %%~nxF
        del "%%~F" >nul 2>nul
    )
)
copy /y "%~dp0studio-plugin\RoLink.lua" "%PLUGINDIR%\RoLink.lua" >nul
if errorlevel 1 (
    echo   ERROR: could not copy into %PLUGINDIR%.
    echo   Copy studio-plugin\RoLink.lua there by hand.
    pause
    exit /b 1
)

REM Studio loads plugins ONCE at startup: installing while it runs changes
REM NOTHING until it fully quits. Detect that trap and say so loudly.
tasklist /FI "IMAGENAME eq RobloxStudioBeta.exe" 2>nul | findstr /i "RobloxStudioBeta.exe" >nul
if not errorlevel 1 (
    echo.
    echo   ############################################################
    echo   ##  ROBLOX STUDIO IS RUNNING RIGHT NOW.                   ##
    echo   ##  It keeps the OLD plugin in memory until it FULLY      ##
    echo   ##  QUITS. Close EVERY Studio window now, then reopen.    ##
    echo   ############################################################
    echo.
)

echo.
echo   RoLink plugin installed to:
echo     %PLUGINDIR%\RoLink.lua
echo.
echo   TWO MORE STEPS INSIDE ROBLOX STUDIO (once per place):
echo     1. Open your place, press View ^> Command Bar, run:
echo          game:GetService("HttpService").HttpEnabled = true
echo        (lets the plugin reach the bridge queue on :3001)
echo     2. Restart Studio if it was open. A "RoLink" toolbar button
echo        appears; the bridge prints "plugin polling" when it connects.
echo.
echo   Verify: start.bat shows "Studio queue :3001 up - plugin polling".
pause
