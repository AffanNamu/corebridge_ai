#!/usr/bin/env bash
# Starts / stops the live ARO server (the one the app talks to) in the
# background, serving the current published version from ARO_HUB_REPO.
#   ./scripts/live_server.sh start | stop | status
set -uo pipefail
cd "$(dirname "$0")/.."
PID_FILE="live_server.pid"

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

case "${1:-status}" in
  start)
    if running; then echo "Live server already running (pid $(cat "$PID_FILE"))."; exit 0; fi
    nohup ./scripts/serve_vllm.sh >> live_server.log 2>&1 &
    echo $! > "$PID_FILE"
    echo "Live server starting (pid $!), log: live_server.log"
    ;;
  stop)
    if running; then
      kill "$(cat "$PID_FILE")"
      for _ in $(seq 1 30); do running || break; sleep 2; done
      echo "Live server stopped."
    fi
    rm -f "$PID_FILE"
    ;;
  status)
    if running; then echo "running (pid $(cat "$PID_FILE"))"; else echo "stopped"; fi
    ;;
  *)
    echo "usage: $0 start|stop|status"; exit 64
    ;;
esac
