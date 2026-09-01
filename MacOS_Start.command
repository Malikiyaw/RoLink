#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
cd "$(dirname "$0")"
LOGDIR="logs"
LOGFILE="$LOGDIR/start.log"
mkdir -p "$LOGDIR"
echo "=== RoLink start $(date) ===" >> "$LOGFILE"
echo "[RoLink] Starting... check logs/start.log"

if [ ! -f "bridge.py" ]; then
  echo "[ERROR] bridge.py not found. Extract the zip first (don't run from preview)."
  read -n1 -s -p "Press any key to exit..."
  echo
  exit 1
fi

# Find python3 >=3.9
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then
    if "$c" -c "import sys; assert sys.version_info >= (3,9)" 2>/dev/null; then
      PY="$c"; break
    fi
  fi
done
if [ -z "$PY" ]; then
  echo "[ERROR] Python 3.9+ not found. Install from https://python.org/downloads"
  read -n1 -s -p "Press any key..."
  echo
  exit 1
fi
echo "[RoLink] Using $PY ($($PY --version 2>&1))"
echo "PY=$PY" >> "$LOGFILE"

# websockets dep
if ! "$PY" -c "import websockets" 2>/dev/null; then
  echo "[RoLink] Installing websockets..."
  "$PY" -m pip install --user websockets >> "$LOGFILE" 2>&1 || "$PY" -m pip install --user --break-system-packages websockets >> "$LOGFILE" 2>&1
  if ! "$PY" -c "import websockets" 2>/dev/null; then
    echo "[ERROR] Failed to install websockets."
    cat "$LOGFILE"
    read -n1 -s -p "Press any key..."
    echo
    exit 1
  fi
fi

# Reclaim 17613
PID=$(lsof -ti tcp:17613 -sTCP:LISTEN 2>/dev/null)
if [ -n "$PID" ]; then
  echo "[RoLink] Port 17613 busy, killing $PID"
  kill -TERM "$PID" 2>/dev/null; sleep 1
  PID2=$(lsof -ti tcp:17613 -sTCP:LISTEN 2>/dev/null)
  if [ -n "$PID2" ]; then kill -9 "$PID2" 2>/dev/null; fi
fi

echo ""
echo "============================================"
echo " RoLink Bridge running — KEEP THIS WINDOW OPEN"
echo " Bridge: ws://127.0.0.1:17613"
echo " Load rolink-extension in chrome://extensions"
echo " Then open chat.deepseek.com / chatgpt.com etc."
echo "============================================"
echo ""
"$PY" bridge.py
EC=$?
echo "[RoLink] Bridge exited with code $EC"
read -n1 -s -p "Press any key to exit..."
echo
exit $EC
