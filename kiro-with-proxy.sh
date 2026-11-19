#!/bin/bash
# Kiro CLI has no proxy setting of its own — it reads the standard proxy
# environment variables (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY).
# This script sets them for a single kiro-cli invocation only, so other
# terminal sessions keep talking to the Kiro API directly.
#
# By default it uses kiro-cli-proxy, a local MITM proxy that decrypts and logs
# kiro-cli's traffic and lives in the same directory as this script. When the
# proxy is on localhost the script makes sure it is running (starting it if
# needed) and points kiro-cli at the proxy's CA bundle through SSL_CERT_FILE,
# which is the only CA setting kiro-cli honours (NODE_EXTRA_CA_CERTS is ignored).
# Several kiro-cli sessions can share one proxy.
#
# What this script does:
#   1. Reads the proxy, the proxy project path and the kiro command from the arguments
#   2. For a localhost proxy: under a lock, runs the proxy project's
#      start-kiro-cli-proxy.sh, which starts kiro-cli-proxy only if it is not
#      already running (and reports and skips when it is)
#   3. Exports the standard proxy environment variables (and SSL_CERT_FILE for a
#      localhost proxy) for this invocation only
#   4. Replaces itself with the kiro command so the TUI owns the terminal
#
# Usage:
#   ./kiro-with-proxy.sh [proxy=HOST:PORT|none] [proxy-path=DIR] [kiro-cmd=COMMAND] [no-proxy=LIST]
#
# Prerequisites:
#   - kiro-cli must be installed and on PATH
#   - For a localhost proxy: Node.js matching the proxy's package.json "engines"
#     must be active in this shell (e.g. nvm use 24) when the proxy has to be
#     started; the script fails with a message otherwise. flock is needed here,
#     and curl, openssl and ps by the proxy's start script.
#   - For any other proxy: if it does TLS inspection, its root CA must already be
#     trusted, otherwise the TLS handshake to the Kiro API will fail

print_usage() {
    echo "Usage: $0 [proxy=HOST:PORT|none] [proxy-path=DIR] [kiro-cmd=COMMAND] [no-proxy=LIST]"
    echo ""
    echo "Parameters:"
    echo "  proxy=HOST:PORT   Proxy to route kiro-cli traffic through. Accepts HOST:PORT or a full URL."
    echo "                    A localhost proxy is treated as kiro-cli-proxy: it is started if it is not"
    echo "                    running. Use 'none' to run without any proxy (default: localhost:8901)"
    echo "  proxy-path=DIR    Directory of the kiro-cli-proxy project (default: this script's directory)."
    echo "                    Only used for a localhost proxy"
    echo "  kiro-cmd=COMMAND  Command to run instead of the default (default: kiro-cli chat)"
    echo "  no-proxy=LIST     Comma separated hosts to bypass (default: localhost,127.0.0.1,::1)"
    echo "  usage             Print this help message"
    echo ""
    echo "Examples:"
    echo "  $0"
    echo "  $0 proxy=none"
    echo "  $0 kiro-cmd='kiro-cli chat --agent my-agent'"
    echo "  $0 proxy=proxy.example.com:8080"
    echo "  $0 proxy=http://user:pass@proxy.example.com:8080 no-proxy=localhost,.internal.example.com"
}

PROXY="localhost:8901"
PROXY_PATH="$(dirname "$(realpath "$0")")"
KIRO_CMD="kiro-cli chat"
NO_PROXY_LIST="localhost,127.0.0.1,::1"
LOCK_WAIT_SECONDS=90

for arg in "$@"; do
    case $arg in
        proxy=*) PROXY="${arg#*=}" ;;
        proxy-path=*) PROXY_PATH="${arg#*=}" ;;
        kiro-cmd=*) KIRO_CMD="${arg#*=}" ;;
        no-proxy=*) NO_PROXY_LIST="${arg#*=}" ;;
        usage) print_usage; exit 0 ;;
        *) echo "Unknown argument: $arg" >&2; print_usage >&2; exit 1 ;;
    esac
done

execute_cmd() {
    echo "+ $*"
    # shellcheck disable=SC2294
    eval "$@"
}

# A leading ~ is only expanded by the shell in some argument positions, so do it here.
case $PROXY_PATH in
    \~) PROXY_PATH="$HOME" ;;
    \~/*) PROXY_PATH="$HOME/${PROXY_PATH#\~/}" ;;
esac

# Splits PROXY into PROXY_URL, PROXY_HOST and PROXY_PORT_NUMBER.
parse_proxy() {
    local rest
    case $PROXY in
        http://*|https://*|socks5://*|socks5h://*) PROXY_URL="$PROXY" ;;
        *) PROXY_URL="http://$PROXY" ;;
    esac
    rest="${PROXY_URL#*://}"
    rest="${rest%%/*}"
    rest="${rest##*@}"
    PROXY_PORT_NUMBER="${rest##*:}"
    PROXY_HOST="${rest%:*}"
    PROXY_HOST="${PROXY_HOST#[}"
    PROXY_HOST="${PROXY_HOST%]}"
    case $PROXY_PORT_NUMBER in
        ''|*[!0-9]*) PROXY_PORT_NUMBER="" ;;
    esac
}

# True when the proxy is a plain-HTTP proxy on this machine, i.e. kiro-cli-proxy.
is_local_managed_proxy() {
    case $PROXY_URL in
        http://*) ;;
        *) return 1 ;;
    esac
    [ -n "$PROXY_PORT_NUMBER" ] || return 1
    case $PROXY_HOST in
        localhost|127.0.0.1|::1) return 0 ;;
        *) return 1 ;;
    esac
}

# Prints a notice when the proxy is already up, otherwise starts it; failure to do either is fatal.
ensure_local_proxy() {
    local start_script="$PROXY_PATH/start-kiro-cli-proxy.sh"
    local lock_file="$PROXY_PATH/run/kiro-with-proxy.lock"

    if [ ! -x "$start_script" ] || [ ! -f "$PROXY_PATH/package.json" ]; then
        echo "ERROR: $PROXY_PATH is not a kiro-cli-proxy project (missing start-kiro-cli-proxy.sh)." >&2
        echo "       Pass proxy-path=DIR, or use proxy=none to run without a proxy." >&2
        return 1
    fi

    # Serialise the start so concurrent sessions never start two proxies. The start
    # script is idempotent: it reports and exits 0 when the proxy is already running,
    # and fails when the port is held by something else.
    mkdir -p -- "$PROXY_PATH/run" || return 1
    exec 9>"$lock_file"
    if ! flock -w "$LOCK_WAIT_SECONDS" 9; then
        echo "ERROR: timed out after ${LOCK_WAIT_SECONDS}s waiting for another kiro-with-proxy.sh to finish starting the proxy." >&2
        return 1
    fi

    # fd 9 is closed for the child so the detached proxy never inherits the lock.
    execute_cmd "\"\$start_script\" \"port=\$PROXY_PORT_NUMBER\" 9>&-" || {
        echo "ERROR: kiro-cli-proxy is not available on port $PROXY_PORT_NUMBER." >&2
        return 1
    }

    flock -u 9
    exec 9>&-

    if [ ! -f "$PROXY_PATH/certs/bundle.pem" ]; then
        echo "ERROR: $PROXY_PATH/certs/bundle.pem does not exist; the proxy has not created its CA bundle." >&2
        return 1
    fi
}

if [ -z "$PROXY" ] || [ "$PROXY" = "none" ]; then
    echo "No proxy requested — running without proxy environment variables."
else
    parse_proxy

    if is_local_managed_proxy; then
        echo "Checking kiro-cli-proxy on localhost:$PROXY_PORT_NUMBER..."
        ensure_local_proxy || exit 1
        # kiro-cli only honours SSL_CERT_FILE, and it replaces the default trust
        # store, so the bundle holds the system roots plus the proxy's CA.
        echo ""
        echo "Trusting the proxy CA for this invocation only..."
        execute_cmd "export SSL_CERT_FILE=\"\$PROXY_PATH/certs/bundle.pem\""
    fi

    echo ""
    echo "Setting proxy environment variables for this invocation only..."
    execute_cmd "export HTTP_PROXY=\"$PROXY_URL\""
    execute_cmd "export HTTPS_PROXY=\"$PROXY_URL\""
    execute_cmd "export ALL_PROXY=\"$PROXY_URL\""
    execute_cmd "export NO_PROXY=\"$NO_PROXY_LIST\""
    execute_cmd "export http_proxy=\"$PROXY_URL\""
    execute_cmd "export https_proxy=\"$PROXY_URL\""
    execute_cmd "export all_proxy=\"$PROXY_URL\""
    execute_cmd "export no_proxy=\"$NO_PROXY_LIST\""
fi

echo ""
echo "Starting kiro command..."
execute_cmd "exec $KIRO_CMD"
