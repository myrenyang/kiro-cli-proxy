# kiro-cli-proxy

A local forward proxy that sits between `kiro-cli` and the Kiro API. It decrypts kiro-cli's HTTPS traffic (TLS man-in-the-middle), logs every transaction to SQLite, and serves a small web UI at `/proxy/data` showing what was sent and received, including the assistant reply assembled from the event stream. Every host is decrypted except a configurable list of credential endpoints, which are relayed untouched.

Node 24, zero runtime dependencies: `node:sqlite` for storage and the `openssl` CLI for certificates.

## How it works

```
kiro-cli ──CONNECT host:443──▶ kiro-cli-proxy ──TLS──▶ real server
                                   │
         host in tunnelHosts?     ├─ no:  terminate TLS with a leaf cert signed by our CA,
         (or an IP / not port 443) │       forward the request, log the decrypted transaction
                                   └─ yes: blind byte tunnel, log only host + byte counts
```

- kiro-cli reads the standard `HTTPS_PROXY` variables and opens a `CONNECT` tunnel to the proxy.
- **Every host on port 443 is decrypted, except the ones on the `tunnelHosts` list.** The proxy answers with a certificate it signs itself; kiro-cli accepts it because the proxy's CA is in the bundle it trusts (see below).
- The default `tunnelHosts` is the credential and token endpoints, so those never reach the logger: `cognito-identity[-fips].*.amazonaws.com` and `sts[.*].amazonaws.com` (temporary AWS credentials), `oidc.*.amazonaws.com` (AWS SSO / Identity Center login and token refresh) and `*.*.auth.desktop.kiro.dev` (Kiro login and token refresh). They were found in the kiro-cli binary and in observed traffic.
- Always tunnelled regardless of the list: bare IP addresses (no certificate can be issued for them) and any port other than 443.
- **Auto-fallback.** If a client rejects the proxy's certificate for a host (it does not trust the proxy CA, or pins certificates), the proxy learns that host and relays it as a blind tunnel from then on, so tools like the AWS CLI and git keep working. Details below.
- If no certificate can be issued for a host (for example it is not a valid DNS name) the proxy fails open to a blind tunnel instead of breaking the connection.
- Upstream connections use strict certificate verification. There is no insecure switch.
- Responses are relayed chunk by chunk as they arrive, so streaming is not delayed.

kiro-cli only honours **`SSL_CERT_FILE`** for custom CAs (`NODE_EXTRA_CA_CERTS` is ignored, it is a native binary). That variable replaces the default trust store, so the proxy writes `certs/bundle.pem` = system roots + its own CA.

## Quick start

The `kiro-with-proxy.sh` wrapper automates all of this:

```bash
nvm use 24
./kiro-with-proxy.sh                               # start the proxy if needed, then run kiro-cli chat
./kiro-with-proxy.sh kiro-cmd='kiro-cli chat --agent my-agent'
./kiro-with-proxy.sh proxy=none                    # run kiro-cli with no proxy
```

It starts `kiro-cli-proxy` if it is not already running (under a lock, so concurrent sessions share one proxy), exports the proxy variables and `SSL_CERT_FILE` for that one kiro-cli process only, and then execs the kiro command. Pass `proxy=HOST:PORT` to use a different proxy; a non-localhost proxy is used as-is (no auto-start, no `SSL_CERT_FILE`). Run `./kiro-with-proxy.sh usage` for all options.

Then open http://localhost:8901/proxy/data.

### Doing it manually

Without the wrapper, start the proxy and point kiro-cli at it for a single invocation:

```bash
npm start   # listens on 127.0.0.1:8901
```

```bash
export HTTPS_PROXY=http://localhost:8901 HTTP_PROXY=http://localhost:8901
export SSL_CERT_FILE=./certs/bundle.pem
kiro-cli chat
```

The proxy is always started with the proxy environment variables removed, so it never routes through itself.

## Scripts

| Script | Purpose |
|---|---|
| `kiro-with-proxy.sh [proxy=…] [kiro-cmd=…] [proxy-path=DIR] [no-proxy=LIST]` | Starts the proxy if needed (under a lock), exports the proxy variables and `SSL_CERT_FILE` for one kiro-cli invocation, then execs it. `proxy=none` runs with no proxy; a non-localhost `proxy=` is used as-is |
| `start-kiro-cli-proxy.sh [port=8901]` | If a proxy already answers on the port: reports it and exits 0 (no Node needed). Otherwise checks Node against `package.json` engines (fails, never switches versions), starts the proxy detached and waits for `/proxy/health`. Fails if the port is held by something else, or if a proxy is already running on a different port |
| `stop-kiro-cli-proxy.sh [port=8901]` | SIGTERM, then SIGKILL after 10 s. Only signals a process whose command line contains this repo's `src/server.js` |

The PID file is `run/kiro-cli-proxy.pid` and the log is `proxy.log`. To restart, run the stop script and then the start script. The proxy is started with all eight proxy environment variables removed, so it can never route through itself.

## Configuration

Settings live in `config.json` in the repo root (committed with the defaults below). Edit it, or override individual settings on the command line with `--kebab-case` flags; a flag wins over `config.json`, which wins over the built-in defaults. There are no environment variables.

```bash
node --use-system-ca src/server.js --proxy-port=8902 --log-full-bodies=false
```

| Setting (config.json key / `--flag`) | Default | Description |
|---|---|---|
| `proxyPort` / `--proxy-port` | `8901` | Listen port, bound to `127.0.0.1` only |
| `tunnelHosts` / `--tunnel-hosts` | the six hosts below | Hosts left encrypted (JSON array in the file; comma list on the command line). Replaces the whole list; `[]` (or `--tunnel-hosts=`) tunnels nothing, i.e. decrypts everything. `*` matches one DNS label |
| `logFullBodies` / `--log-full-bodies` | `true` | Store request/response bodies. `false` keeps metadata and extracted fields only |
| `learnTunnels` / `--learn-tunnels` | `true` | When a client rejects the proxy's certificate for a host, relay that host as a blind tunnel from then on (see *Auto-fallback*) |
| `learnedTunnelTtlHours` / `--learned-tunnel-ttl-hours` | `24` | How long a learned host stays tunnelled after its last use |
| `bodyCapKilobytes` / `--body-cap-kilobytes` | `1000` | Per-body storage cap in KB, `0` = unlimited. The traffic itself is never cut; rows get a truncated flag |
| `retentionDays` / `--retention-days` | `7` | A row is deleted only if older than this **and** ... |
| `retentionCount` / `--retention-count` | `100` | ... outside the newest N rows. Tunnel rows are deleted by age alone |
| `logFieldMaxLength` / `--log-field-max-length` | `1000` | Truncation of `last_user_message` |
| `dbPath` / `--db-path` | `data.db` | SQLite file (relative to the repo) |
| `certDir` / `--cert-dir` | `certs` | CA, leaf certificates and bundle |
| `systemCaFile` / `--system-ca-file` | `/etc/ssl/certs/ca-certificates.crt` | System roots copied into the bundle |
| `logLevel` / `--log-level` | `info` | `debug`, `info`, `warn`, `error` |

The default `tunnelHosts` is the credential and token endpoints, so those never reach the logger: `cognito-identity.*.amazonaws.com`, `cognito-identity-fips.*.amazonaws.com`, `oidc.*.amazonaws.com`, `sts.amazonaws.com`, `sts.*.amazonaws.com`, `*.*.auth.desktop.kiro.dev`. (`MITM_HOSTS` from earlier versions is rejected with an error.)

Retention runs at startup and then hourly.

## Endpoints (same port as the proxy)

| Path | Description |
|---|---|
| `/proxy/health` | `{"status":"ok","name":"kiro-cli-proxy",...}`. Only answers once the CA and bundle exist |
| `/proxy/data` | Web UI: transactions listed oldest first, newest last. "Show tunnels" is on by default and "show telemetry" is off. The table area is a fixed 8 rows tall (header stays pinned) and scrolls vertically beyond that, following new rows while you are at the bottom; it loads the latest 100 rows by default (selectable). Request/response panels show the event-stream as assembled text plus events |
| `/proxy/api/rows?limit=8&tunnels=0&telemetry=0` | Row list as JSON, newest first. Shows decrypted rows that are not telemetry; `tunnels=1` adds blind tunnels (including learned ones), `telemetry=1` adds rows of category `telemetry`. The limit applies after filtering |
| `/proxy/api/rows/:id` | One row with decoded request/response |

The UI is served with a strict CSP, builds all content with `textContent` (captured bodies are untrusted), makes no third-party requests, and requests with a non-loopback `Host` header are refused (DNS-rebinding guard).

## Request categories

Every row has a `category` (what the request was for; `kind` is how it was captured: `mitm` or `tunnel`). It is computed once when the row is written (see `src/classify.js`) and indexed, so the UI filters never pattern-match hostnames at query time.

| Category | What it is | Hosts seen from kiro-cli |
|---|---|---|
| `chat` | The conversation itself (`GenerateAssistantResponse`; a blind tunnel to the runtime host also counts) | `runtime.*.kiro.dev` |
| `telemetry` | Usage metrics and telemetry events | `telemetry.*.kiro.dev`, `client-telemetry.*.amazonaws.com`, `q.*.amazonaws.com` |
| `auth` | Credentials | `cognito-identity.*.amazonaws.com` |
| `management` | Management service | `management.*.kiro.dev` |
| `api` | Non-chat runtime operations | `runtime.*.kiro.dev` (non-chat) |
| `mcp` | MCP registry lookups | hosts starting `mcp-` / `mcp.` |
| `update` | CLI update checks and downloads | `*download.cli.kiro.dev` |
| `other` | Anything else | |

Telemetry wins over every other rule. The hostname rules are anchored, so lookalikes such as `runtime.<region>.kiro.dev.evil.com` become `other`.

The list queries use `idx_transactions_kind_id` for decrypted and tunnel rows and `idx_transactions_category_id` for telemetry; each filter combination is a union of ordered index range scans with its own `LIMIT`, so cost depends on the page size, not the table size. A test checks the query plans for a full table scan.

**Upgrading an existing database:** on start the proxy adds the `category` column and index if they are missing and classifies every row that has no category yet. A database from an earlier build where the column was called `type` is renamed in place (values kept). This is additive (no existing column or body is changed) and idempotent, and it also picks up rows written by an older proxy that was still running. Back up `data.db` first if you want a restore point.

## What is stored

One row per transaction in `transactions`:

- **Generic:** `kind` (`mitm`/`tunnel`), `category`, time, host, port, method, path, `operation` (from `x-amz-target`), status, `ttfb_ms`, `duration_ms`, request/response wire bytes, truncated/aborted flags, error, redacted headers.
- **Raw bodies** (BLOB, capped): exactly the bytes on the wire. The UI decodes at view time (gzip, JSON, AWS event-stream), so a decoder bug never loses data.
- **`GenerateAssistantResponse` extras:** `conversation_id`, `model_id`, `history_count`, `tools_count`, `cwd`, `last_user_message`, `res_text` (assembled assistant reply), `res_events` (event counts), `context_usage` and `metering` (raw JSON of those events).

Headers named `authorization`, `cookie`, `set-cookie`, `x-amz-security-token` or containing `token`/`secret`/`password`/`api-key` are stored as `[REDACTED]`. Redaction applies to header values only; request and response bodies are stored as received. No fields are extracted from credential-bearing bodies into their own columns.

## Security notes

- Request and response bodies are stored for every decrypted host, so `data.db` can contain prompts, file contents, tool output, account and profile details returned by the API, and the traffic of any other program that uses the proxy (see Limitations). Only headers are redacted, not bodies. Treat `data.db` as sensitive; it is gitignored. Each kiro-cli start adds several decrypted rows beyond the chat turn (profile, model list, preferences), so the default `retentionCount` of 100 covers fewer sessions than chat alone; raise it for a longer history.
- `certs/ca/ca.key` can mint certificates for any host that trusts the CA. It is created with mode 600 in a mode-700 directory, gitignored, and the CA is trusted only by the processes you point at the bundle (via `SSL_CERT_FILE`), never installed in the system store.
- The CA is created atomically (private temp dir, then rename), so concurrent first starts end up with one consistent CA. It is valid for 1 year; leaf certificates for 30 days. Delete `certs/` to regenerate everything.
- The proxy listens on loopback only and refuses plain (non-CONNECT) proxy requests.

## Auto-fallback (learned tunnels)

With "decrypt everything else", a client that does not trust the proxy CA would fail every connection. Instead the proxy reacts to the failure:

1. The client refuses the proxy's certificate, either by aborting the handshake with a certificate alert (`unknown_ca`, `bad_certificate`, ...) or by completing the handshake and closing without a request (see *Two signals* below).
2. The proxy records that attempt as a flagged row (`error`: *client rejected the proxy certificate ... tunnelled blind from now on*), logs a warning, and remembers the host.
3. Every later connection to that host is a blind tunnel (encrypted end to end, host and byte counts only), so the retry succeeds. The AWS CLI retries connection errors, so it normally works within the same command; `git` fails once and works on the next run.

Properties, chosen so it cannot quietly hide traffic you care about:
- **Only certificate-trust failures are learned.** Garbage, plain HTTP on port 443 and other TLS errors are not.
- **In memory only.** Restarting the proxy forgets everything, so there is nothing to clean up.
- **Expires by itself.** An entry lasts `learnedTunnelTtlHours` (24) after its last use; every use extends it.
- **Visible.** The UI header shows "auto-tunnelled, client rejected the proxy CA: ..." and `/proxy/health` lists `learned_tunnels` with the seconds left.
- **Not a substitute for configuration.** Add a host to `tunnelHosts` to make it permanent, and set `learnTunnels: false` to turn the behavior off (the log then only hints which host to add).
- **Known caveat:** if kiro-cli ever runs without the CA bundle (for example `HTTPS_PROXY` is set by hand), its own hosts, including the chat host, would be learned and stop being logged until the proxy restarts or the entry expires. The warning row and the UI notice make this easy to spot. Always export `SSL_CERT_FILE=./certs/bundle.pem` when pointing kiro-cli at the proxy.
- **Two signals.** Most clients abort the handshake with a certificate alert (`unknown_ca`, `bad_certificate`). Some (GnuTLS, which `git` uses here, and Node) finish the handshake, check the certificate afterwards and close silently, so the proxy also treats "handshake completed, then closed within 5 s without sending any request" as a rejection. That second signal never applies to a host that has already completed a decrypted request (checked in memory and in the database), so kiro-cli's own hosts are not affected by it. The trade-off: any client that connects to a never-before-seen host and closes immediately without a request looks the same, and that host is tunnelled until the entry expires.

## Limitations

- **Programs that inherit the proxy variables.** kiro-cli passes `HTTPS_PROXY` and `SSL_CERT_FILE` on to the commands it runs, so their HTTPS traffic is decrypted and stored too (curl and Python `urllib` honor `SSL_CERT_FILE`; Node's built-in `fetch` ignores proxy variables and bypasses the proxy). Tools that do not trust the proxy CA, such as the **AWS CLI** and **git over HTTPS**, are handled by the auto-fallback below.

- HTTP/1.1 only. kiro-cli did not negotiate HTTP/2 on the decrypted host in testing; if that changes, those requests will fail rather than be logged.
- The event-stream decoder was written against observed traffic (`initial-response`, `assistantResponseEvent`, `metadataEvent`, `contextUsageEvent`, `meteringEvent`). Unknown event types are listed and shown raw.
- Reliability of the proxy matters: kiro-cli retries aggressively when the proxy refuses connections.

## Development

```bash
nvm use 24
npm test        # node:test; unit tests plus integration tests with a fake upstream
npm start       # run in the foreground (reads config.json; override with --proxy-port=...)
shellcheck *.sh
```

## Todo

- Live view (SSE push) and filtering by host/status on the UI page (beyond the "show tunnels" / "show telemetry" toggles)
- Optional `upstreamProxy` setting to chain through another proxy
