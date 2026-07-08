#!/usr/bin/env bash
#
# start.sh — run the Terrace project.
#
#   ./start.sh            # assembled full-stack demo, driven by REAL match data (default)
#   ./start.sh desktop    # the Electron desktop app (open twice for two peers)
#   ./start.sh deploy     # deploy the escrow to Sepolia (reads .env)
#   ./start.sh room       # just the P2P room two-peer sync (Phase 1, under Pear)
#   ./start.sh contracts  # just the escrow contract tests
#
# Chain: local anvil (test money) by default. Put SEPOLIA_RPC_URL + ESCROW_ADDRESS +
# USDT_ADDRESS (+ TERRACE_SEED) in .env and `desktop` targets real Sepolia instead.
#
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"

need() { command -v "$1" >/dev/null 2>&1 || { echo "✖ missing '$1' — see README setup"; exit 1; }; }
load_env() { [ -f .env ] && set -a && . ./.env && set +a || true; }

wait_for_port() { # host port timeout_s
  local i=0
  until (echo >"/dev/tcp/$1/$2") 2>/dev/null; do
    i=$((i+1)); [ "$i" -gt "${3:-30}" ] && { echo "✖ port $2 never opened"; return 1; }
    sleep 0.5
  done
}

start_anvil() {
  echo "▶ starting local chain (anvil)…"
  pkill -9 -f anvil 2>/dev/null || true
  anvil --silent > /tmp/terrace-anvil.log 2>&1 &
  ANVIL_PID=$!
  trap 'kill -9 $ANVIL_PID 2>/dev/null || true' EXIT
  wait_for_port 127.0.0.1 8545 30
}

MODE="${1:-assemble}"
load_env

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
  deploy)
    need forge; need node
    forge build --root contracts >/dev/null
    echo "▶ deploying TerraceEscrow to Sepolia from your WDK wallet (account[0])…"
    node scripts/deploy-sepolia.mjs
    echo "→ copy the ESCROW_ADDRESS line into .env, then: ./start.sh desktop"
    ;;
  desktop)
    need node
    export TERRACE_NODE="$(command -v node)"
    if [ -n "${SEPOLIA_RPC_URL:-}" ]; then
      # Sepolia mode needs NO Foundry/anvil — the escrow is already deployed.
      echo "▶ targeting REAL Sepolia (escrow ${ESCROW_ADDRESS:-<unset!>})"
      [ -z "${ESCROW_ADDRESS:-}" ] && echo "  ⚠ ESCROW_ADDRESS not set in .env — set it (or ./start.sh deploy, which needs Foundry)"
    else
      # local dev mode deploys a test chain + token, which needs Foundry
      need forge; need anvil
      echo "▶ building contracts…"; forge build --root contracts >/dev/null
      start_anvil
      echo "  (local dev mode: test chain + test USDt, wallet auto-funded)"
    fi
    if [ ! -d desktop/node_modules/electron ]; then
      echo "▶ installing Electron (first run)…"; ( cd desktop && npm install )
    fi
    echo "▶ launching Terrace… (open a SECOND terminal and run ./start.sh desktop again for a second fan)"
    ( cd desktop && npm start )
    ;;
  assemble)
    need forge; need node; need anvil
    echo "▶ building contracts…"; forge build --root contracts >/dev/null
    start_anvil
    echo "▶ running assembled stack on REAL match data (first run downloads NMT models once)…"
    node scripts/assemble-e2e.mjs
    ;;
  *)
    echo "usage: ./start.sh [assemble|desktop|deploy|room|contracts]"; exit 1
    ;;
esac
