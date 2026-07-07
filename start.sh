#!/usr/bin/env bash
#
# start.sh — run the Terrace project.
#
# Until the desktop shell lands (Phase 4b), "running the project" means booting the full
# assembled stack headless: a local chain + the room + WDK wallet + escrow + on-device
# QVAC translation, all in one process, driven end to end. This is the same code the GUI
# worker will wrap.
#
# Usage:
#   ./start.sh            # run the assembled full-stack demo (default)
#   ./start.sh room       # just the P2P room two-peer sync (Phase 1, under Pear)
#   ./start.sh contracts  # just the escrow contract tests
#
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"

need() { command -v "$1" >/dev/null 2>&1 || { echo "✖ missing '$1' — see README setup"; exit 1; }; }

wait_for_port() { # host port timeout_s
  local i=0
  until (echo >"/dev/tcp/$1/$2") 2>/dev/null; do
    i=$((i+1)); [ "$i" -gt "${3:-30}" ] && { echo "✖ port $2 never opened"; return 1; }
    sleep 0.5
  done
}

MODE="${1:-assemble}"

case "$MODE" in
  room)
    echo "▶ Phase 1 room sync (two peers, Pear/Bare)…"
    exec bash scripts/two-peer-test.sh
    ;;
  contracts)
    need forge
    echo "▶ escrow contract tests…"
    exec forge test --root contracts -vv
    ;;
  assemble)
    need forge; need node; need anvil
    echo "▶ building contracts…"
    forge build --root contracts >/dev/null

    echo "▶ starting local chain (anvil)…"
    pkill -9 -f anvil 2>/dev/null || true
    anvil --silent > /tmp/terrace-anvil.log 2>&1 &
    ANVIL_PID=$!
    trap 'kill -9 $ANVIL_PID 2>/dev/null || true' EXIT
    wait_for_port 127.0.0.1 8545 30

    echo "▶ running assembled stack: room + WDK + escrow + QVAC (first run downloads NMT models once)…"
    node scripts/assemble-e2e.mjs
    ;;
  *)
    echo "usage: ./start.sh [assemble|room|contracts]"; exit 1
    ;;
esac
