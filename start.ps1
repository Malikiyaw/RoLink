# RoLink start.ps1 1.0.5 — PowerShell fallback when .bat association broken (bash -> cmd issue)
# Usage: powershell -ExecutionPolicy Bypass -File start.ps1  OR  right-click -> Run with PowerShell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = Get-Location }
Set-Location -LiteralPath $scriptDir
$logDir = Join-Path $scriptDir "logs"
$logFile = Join-Path $logDir "start.log"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
Add-Content -LiteralPath $logFile -Value "=== RoLink PS start $(Get-Date) ===" -ErrorAction SilentlyContinue
Write-Host "[RoLink] Starting via PowerShell... check logs/start.log" -ForegroundColor Cyan

function Find-Python {
  $cands = @()
  try { $v = & py -3 -c "import sys; print(sys.executable)" 2>$null; if ($LASTEXITCODE -eq 0 -and $v) { return $v.Trim() } } catch {}
  try { & python -c "import sys; assert sys.version_info >= (3,9)" 2>$null; if ($LASTEXITCODE -eq 0) { $p = & python -c "import sys; print(sys.executable)" 2>$null; if ($p) { return $p.Trim() } } } catch {}
  $bases = @("$env:LOCALAPPDATA\Programs\Python", $env:ProgramFiles, ${env:ProgramFiles(x86)})
  foreach ($b in $bases) {
    if (-not $b -or -not (Test-Path $b)) { continue }
    Get-ChildItem -Path $b -Filter "Python3*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object {
      $exe = Join-Path $_.FullName "python.exe"
      if (Test-Path $exe) {
        try { & $exe -m pip --version 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { return $exe } } catch {}
      }
    }
  }
  return $null
}

if (-not (Test-Path (Join-Path $scriptDir "bridge.py"))) {
  Write-Host "[ERROR] bridge.py not found. Extract the zip first (right-click -> Extract All...)" -ForegroundColor Red
  Read-Host "Press Enter to exit"
  exit 1
}
$py = Find-Python
if (-not $py) {
  Write-Host "[ERROR] Python 3.9+ not found. Installing via winget..." -ForegroundColor Yellow
  try { winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements 2>$null | Out-Null; $py = Find-Python } catch {}
}
if (-not $py) { Write-Host "[ERROR] Python still not found. Install from https://python.org/downloads" -ForegroundColor Red; Read-Host "Press Enter"; exit 1 }
Add-Content -LiteralPath $logFile -Value "Using PY=$py"
try { & $py --version 2>&1 | Out-String | Add-Content -LiteralPath $logFile } catch {}

# Validate websockets
try { & $py -c "import websockets" 2>$null; if ($LASTEXITCODE -ne 0) { throw "missing" } } catch {
  Write-Host "[RoLink] Installing websockets..." -ForegroundColor Yellow
  & $py -m pip install --user websockets 2>&1 | Add-Content -LiteralPath $logFile
}

# Reclaim 17613
try {
  $conns = netstat -aon | Select-String ":17613" | Select-String "LISTENING"
  foreach ($line in $conns) {
    if ($line -match "\s(\d+)\s*$") {
      $pid = $matches[1]
      Write-Host "[RoLink] Port 17613 busy, killing PID $pid" -ForegroundColor Yellow
      try { taskkill /F /T /PID $pid 2>$null | Out-Null; Start-Sleep -Seconds 1 } catch {}
    }
  }
} catch {}

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host " RoLink Bridge running — KEEP THIS WINDOW OPEN" -ForegroundColor Green
Write-Host " Bridge: ws://127.0.0.1:17613" -ForegroundColor Green
Write-Host " Next: load rolink-extension in chrome://extensions" -ForegroundColor Gray
Write-Host "============================================" -ForegroundColor Green
Write-Host ""

$bridge = Join-Path $scriptDir "bridge.py"
& $py $bridge
$ec = $LASTEXITCODE
Write-Host "[RoLink] Bridge exited with code $ec" -ForegroundColor Yellow
Add-Content -LiteralPath $logFile -Value "exit $ec"
Read-Host "Press Enter to exit"
exit $ec

