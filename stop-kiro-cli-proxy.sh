#!/bin/bash
# kiro-cli-proxy is a local forward proxy that decrypts and logs kiro-cli's chat
# traffic. This script stops a running instance of it: a graceful SIGTERM first
# (so the database and sockets close cleanly), then SIGKILL if it does not exit
# in time. It only ever signals a process that is verifiably this project's
# server (its command line must contain this repo's src/server.js).
#
# Usage:
#   ./stop-kiro-cli-proxy.sh [port=8901]
#   ./stop-kiro-cli-proxy.sh usage
#
# What this script does:
#   1. Finds the proxy process from the PID file, or from /proxy/health on the port
#   2. Verifies that the process really is this project's proxy server
#   3. Sends SIGTERM and waits for it to exit
#   4. Sends SIGKILL if it is still running after the timeout
#   5. Removes the PID file
#
# Prerequisites:
#   - ps, curl and kill are available (no Node.js is needed to stop the proxy)

print_usage() {
    echo "Usage: $0 [port=PORT]"
    echo ""
    echo "Parameters:"
    echo "  port=PORT   Port the proxy listens on; used to find it when the PID file is missing (default: 8901)"
    echo "  usage       Print this help message"
    echo ""
    echo "Examples:"
    echo "  $0"
    echo "  $0 port=8901"
}

ROOT="$(dirname "$(realpath "$0")")"
PORT=8901
PID_FILE="$ROOT/run/kiro-cli-proxy.pid"
SERVER_JS="$ROOT/src/server.js"
STOP_TIMEOUT_SECONDS=10
KILL_TIMEOUT_SECONDS=3

for arg in "$@"; do
    case $arg in
        port=*) PORT="${arg#*=}" ;;
        usage) print_usage; exit 0 ;;
        *) echo "Unknown argument: $arg" >&2; print_usage >&2; exit 1 ;;
    esac
done

case $PORT in
    ''|*[!0-9]*) echo "Invalid port: $PORT" >&2; exit 1 ;;
esac

execute_cmd() {
    echo "+ $*"
    # shellcheck disable=SC2294
    eval "$@"
}

# True when PID is a running process whose command line contains our server.js.
is_our_proxy() {
    ps -p "$1" -o command= 2>/dev/null | grep -qF -- "$SERVER_JS"
}

# True while PID is running at all.
is_running() {
    ps -p "$1" -o pid= >/dev/null 2>&1
}

# Waits up to $2 seconds for PID $1 to exit. Returns 0 once it is gone.
wait_for_exit() {
    local pid="$1" seconds="$2" i
    for ((i = 0; i < seconds * 2; i++)); do
        is_running "$pid" || return 0
        sleep 0.5
    done
    ! is_running "$pid"
}

echo "Looking for a running kiro-cli-proxy..."
PID=""
if [ -f "$PID_FILE" ]; then
    PID="$(tr -dc '0-9' < "$PID_FILE")"
    echo "PID file $PID_FILE says: ${PID:-<empty>}"
fi

if [ -z "$PID" ] || ! is_running "$PID"; then
    # No usable PID file: ask whatever answers on the port. --noproxy keeps this
    # request from being routed through a proxy named in the environment.
    HEALTH="$(curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$PORT/proxy/health" 2>/dev/null)"
    if printf '%s' "$HEALTH" | grep -q '"name":"kiro-cli-proxy"'; then
        PID="$(printf '%s' "$HEALTH" | grep -o '"pid":[0-9]*' | head -n 1 | tr -dc '0-9')"
        echo "Found a proxy answering on port $PORT with PID ${PID:-unknown}"
    else
        PID=""
    fi
fi

if [ -z "$PID" ] || ! is_running "$PID"; then
    echo "kiro-cli-proxy is not running."
    execute_cmd "rm -f -- \"\$PID_FILE\""
    exit 0
fi

if ! is_our_proxy "$PID"; then
    echo "Refusing to stop PID $PID: its command line does not contain $SERVER_JS" >&2
    ps -p "$PID" -o pid=,command= >&2
    exit 1
fi

echo ""
echo "Stopping kiro-cli-proxy (PID $PID) gracefully..."
execute_cmd "kill -TERM \"\$PID\""
if wait_for_exit "$PID" "$STOP_TIMEOUT_SECONDS"; then
    echo "Stopped."
else
    echo ""
    echo "Still running after ${STOP_TIMEOUT_SECONDS}s; forcing it to stop..."
    execute_cmd "kill -KILL \"\$PID\""
    if ! wait_for_exit "$PID" "$KILL_TIMEOUT_SECONDS"; then
        echo "Failed to stop PID $PID" >&2
        exit 1
    fi
    echo "Killed."
fi

execute_cmd "rm -f -- \"\$PID_FILE\""
