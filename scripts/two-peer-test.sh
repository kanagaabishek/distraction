#!/usr/bin/env bash
# Launch two Terrace instances that join the same room and let them sync.
set -u
export PATH="/Users/kanagaabishek-00038/Library/Application Support/pear/bin:$PATH"
cd "$(dirname "$0")/.."

HOST_LOG=/tmp/terrace-host.log
GUEST_LOG=/tmp/terrace-guest.log
rm -f "$HOST_LOG" "$GUEST_LOG"

echo "[orchestrator] starting HOST"
pear run --dev -t . host > "$HOST_LOG" 2>&1 &
HOST_PID=$!

# wait for the host to print its room key
KEY=""
for i in $(seq 1 30); do
  KEY=$(grep -o '"key":"[0-9a-f]*"' "$HOST_LOG" 2>/dev/null | head -1 | sed 's/.*"key":"//;s/"//')
  [ -n "$KEY" ] && break
  sleep 1
done

if [ -z "$KEY" ]; then
  echo "[orchestrator] ERROR: host never printed a room key"
  kill $HOST_PID 2>/dev/null
  exit 1
fi
echo "[orchestrator] room key = $KEY"
echo "[orchestrator] starting GUEST joining $KEY"
pear run --dev -t . guest "$KEY" > "$GUEST_LOG" 2>&1 &
GUEST_PID=$!

# let them discover + sync
sleep 25

echo "[orchestrator] stopping instances"
kill $HOST_PID $GUEST_PID 2>/dev/null
sleep 2
pkill -f "pear run --dev" 2>/dev/null
echo "[orchestrator] done"
