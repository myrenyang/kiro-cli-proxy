#!/bin/bash
# kiro-cli-proxy is a local forward proxy that decrypts and logs kiro-cli's chat
# traffic into SQLite and serves a small web UI at /proxy/data. This script
# starts it detached from the terminal, so it keeps running after you close the
# shell and can be shared by several kiro-cli sessions. If the proxy is already
# running it does nothing except report that fact; use stop-kiro-cli-proxy.sh to
# stop it, or run stop and then start to restart it.
#
# Configuration lives in config.json in the repo root. This script only overrides the port
# (via the proxy's --proxy-port flag); edit config.json for everything else. See README.md.
#
# Usage:
#   ./start-kiro-cli-proxy.sh [port=8901]
#   ./start-kiro-cli-proxy.sh usage
#
# What this script does:
#   1. Checks whether kiro-cli-proxy already answers on the port, and if so reports it and exits
#   2. Checks that the active Node.js satisfies "engines" in package.json
#   3. Starts the proxy in the background with the proxy environment variables removed
#   4. Waits until /proxy/health answers as kiro-cli-proxy, i.e. the CA is ready
#
# Prerequisites:
#   - Node.js matching package.json "engines" is already active (run: nvm use 24)
#     when the proxy has to be started. This script never switches Node versions.
#   - openssl, curl and ps are installed
#   - The port is free or held by a kiro-cli-proxy

print_usage() {
    echo "Usage: $0 [port=PORT]"
    echo ""
    echo "Parameters:"
    echo "  port=PORT   Port the proxy listens on, on 127.0.0.1 only (default: 8901)"
    echo "  usage       Print this help message"
    echo ""
    echo "Examples:"
    echo "  $0"
    echo "  $0 port=8901"
    echo "  $0 port=8902"
}

ROOT="$(dirname "$(realpath "$0")")"
PORT=8901
# shellcheck disable=SC2034  # used inside the eval'd start command below
SERVER_JS="$ROOT/src/server.js"
PACKAGE_JSON="$ROOT/package.json"
RUN_DIR="$ROOT/run"
PID_FILE="$RUN_DIR/kiro-cli-proxy.pid"
LOG_FILE="$ROOT/proxy.log"
START_TIMEOUT_SECONDS=20
HEALTH_TIMEOUT_SECONDS=2

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

print_endpoints() {
    echo "  UI    : http://localhost:$PORT/proxy/data"
    echo "  Health: http://localhost:$PORT/proxy/health"
    echo "  CA    : $ROOT/certs/ca/ca.pem"
    echo "  Bundle: $ROOT/certs/bundle.pem  (use as SSL_CERT_FILE)"
}

# Fails unless the active node satisfies the ">=N" range in package.json engines.
check_node_version() {
    local required current_major required_major
    if ! command -v node >/dev/null 2>&1; then
        echo "ERROR: node is not on PATH. Activate the version this project needs, e.g.: nvm use" >&2
        return 1
    fi
    required="$(node -p 'require(process.argv[1]).engines.node' "$PACKAGE_JSON" 2>/dev/null)"
    case $required in
        '>='[0-9]*) required_major="${required#>=}"; required_major="${required_major%%.*}" ;;
        *) echo "ERROR: cannot read a '>=N' engines.node range from $PACKAGE_JSON (found: '${required}')" >&2; return 1 ;;
    esac
    current_major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$current_major" -lt "$required_major" ]; then
        echo "ERROR: Node $(node -v) is active but package.json requires node $required." >&2
        echo "       Activate a matching version first, e.g.: nvm use $required_major" >&2
        return 1
    fi
    echo "Node $(node -v) satisfies engines.node $required"
}

echo "Checking whether kiro-cli-proxy is already running on port $PORT..."
# --noproxy keeps this probe from being routed through a proxy named in the environment.
HEALTH="$(curl -fsS --noproxy '*' --max-time "$HEALTH_TIMEOUT_SECONDS" "http://127.0.0.1:$PORT/proxy/health" 2>/dev/null)"
CURL_STATUS=$?

if [ "$CURL_STATUS" -eq 0 ] && printf '%s' "$HEALTH" | grep -q '"name":"kiro-cli-proxy"'; then
    RUNNING_PID="$(printf '%s' "$HEALTH" | grep -o '"pid":[0-9]*' | head -n 1 | tr -dc '0-9')"
    echo "kiro-cli-proxy is already running (PID ${RUNNING_PID:-unknown}); nothing to start."
    print_endpoints
    exit 0
fi

if [ "$CURL_STATUS" -ne 7 ]; then
    echo "ERROR: port $PORT is in use by something that is not kiro-cli-proxy (curl exit $CURL_STATUS)." >&2
    echo "       Choose another port with port=PORT, or stop whatever is using it." >&2
    exit 1
fi

# Nothing listens on the port. A live proxy recorded in the PID file must then be
# running on a different port; starting a second one would overwrite its PID file.
if [ -f "$PID_FILE" ]; then
    OLD_PID="$(tr -dc '0-9' < "$PID_FILE")"
    if [ -n "$OLD_PID" ] && ps -p "$OLD_PID" -o command= 2>/dev/null | grep -qF -- "$SERVER_JS"; then
        echo "ERROR: a kiro-cli-proxy (PID $OLD_PID) is already running, but not on port $PORT." >&2
        echo "       Stop it first with: $ROOT/stop-kiro-cli-proxy.sh" >&2
        exit 1
    fi
    echo "Removing a stale PID file (PID ${OLD_PID:-<empty>} is not a running kiro-cli-proxy)..."
    execute_cmd "rm -f -- \"\$PID_FILE\""
fi

echo ""
echo "Checking the Node.js version..."
check_node_version || exit 1

echo ""
echo "Starting kiro-cli-proxy in the background on 127.0.0.1:$PORT..."
execute_cmd "mkdir -p -- \"\$RUN_DIR\""
# The eight proxy variables are removed so the proxy can never route its own
# upstream connections back through itself. --use-system-ca makes Node trust
# the OS certificate store (needed behind a TLS-inspecting corporate proxy);
# it mirrors the "start" script in package.json.
execute_cmd "env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY -u http_proxy -u https_proxy -u all_proxy -u no_proxy nohup node --use-system-ca \"\$SERVER_JS\" --proxy-port=\"\$PORT\" >> \"\$LOG_FILE\" 2>&1 < /dev/null &"
PID=$!
disown "$PID"
echo "$PID" > "$PID_FILE"
echo "kiro-cli-proxy PID: $PID (log: $LOG_FILE)"
execute_cmd "ps -p \"\$PID\" -o pid=,command="

echo ""
echo "Waiting for the proxy to become healthy..."
HEALTHY=0
for ((i = 0; i < START_TIMEOUT_SECONDS * 2; i++)); do
    if ! ps -p "$PID" -o pid= >/dev/null 2>&1; then
        break
    fi
    if curl -fsS --noproxy '*' --max-time "$HEALTH_TIMEOUT_SECONDS" "http://127.0.0.1:$PORT/proxy/health" 2>/dev/null | grep -q '"name":"kiro-cli-proxy"'; then
        HEALTHY=1
        break
    fi
    sleep 0.5
done

if [ "$HEALTHY" -ne 1 ]; then
    echo "ERROR: kiro-cli-proxy did not become healthy. Last log lines:" >&2
    tail -n 20 -- "$LOG_FILE" >&2
    rm -f -- "$PID_FILE"
    exit 1
fi

echo "kiro-cli-proxy is up."
print_endpoints
