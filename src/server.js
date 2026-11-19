#!/usr/bin/env node
'use strict';

// kiro-cli-proxy: a forward MITM proxy for kiro-cli.
//
//  * CONNECT to any host on port 443 that is not on the TUNNEL_HOSTS list: the proxy
//    terminates TLS with a certificate signed by its own CA, forwards the request to the
//    real server, and logs the decrypted transaction.
//  * CONNECT to a TUNNEL_HOSTS host, a bare IP address, or any other port: a blind byte
//    tunnel, logged as host + bytes.
//  * Plain requests to the proxy port itself serve the logging UI and health.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

const { loadConfig, shouldDecrypt, publicConfig } = require('./config');
const { openDb } = require('./db');
const { createCertAuthority } = require('./certs');
const { redactHeaders } = require('./redact');
const { operationName, extractRequest, extractResponse } = require('./extract');
const { decodeBody, errorKind } = require('./view');
const ui = require('./ui');
const pkg = require('../package.json');

const NAME = 'kiro-cli-proxy';
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PURGE_INTERVAL_MS = 3600 * 1000;
const CONNECT_ESTABLISHED = 'HTTP/1.1 200 Connection Established\r\n\r\n';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Collects a body up to `cap` bytes (0 = unlimited) while counting every byte.
class Capture {
  constructor(cap) {
    this.cap = cap;
    this.chunks = [];
    this.stored = 0;
    this.total = 0;
    this.truncated = false;
  }

  push(chunk) {
    this.total += chunk.length;
    if (this.cap === 0) { this.chunks.push(chunk); this.stored += chunk.length; return; }
    const room = this.cap - this.stored;
    if (room > 0) {
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.chunks.push(part);
      this.stored += part.length;
    }
    if (this.total > this.cap) this.truncated = true;
  }

  buffer() { return Buffer.concat(this.chunks, this.stored); }
}

function parseJsonSafe(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function parseHostPort(authority) {
  const i = authority.lastIndexOf(':');
  if (i <= 0) return null;
  const host = authority.slice(0, i).replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number.parseInt(authority.slice(i + 1), 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function createProxy(options = {}) {
  const cfg = options.config || loadConfig();
  const level = LEVELS[cfg.logLevel] ?? 1;
  const log = options.log || ((lvl, msg) => {
    if ((LEVELS[lvl] ?? 1) >= level) console.log(`[${new Date().toISOString()}] [${lvl.toUpperCase()}] ${msg}`);
  });
  const db = options.db || openDb(cfg.dbPath);
  if (db.backfilled > 0) log('info', `classified ${db.backfilled} existing rows with the new "category" column`);
  const certs = options.certs || createCertAuthority({ certDir: cfg.certDir, systemCaFile: cfg.systemCaFile, log });
  // Tests inject a resolver to point the "real server" at a local fake.
  const resolveUpstream = options.upstreamResolver || ((host, port) => ({ host, port }));
  const agent = new https.Agent({ keepAlive: true });
  const now = options.now || Date.now; // injectable so tests can move the clock
  const startedAt = Date.now();
  const sockets = new Set();

  // Hosts learned at runtime: a client rejected the proxy's certificate for them, so they are
  // relayed as blind tunnels instead. In memory only (a restart forgets them) and the expiry
  // slides forward every time a learned host is used, so unused entries fade out by themselves.
  const learned = new Map(); // host -> expiry, epoch ms
  function isLearned(host) {
    const until = learned.get(host);
    if (until === undefined) return false;
    if (until <= now()) { learned.delete(host); return false; }
    learned.set(host, now() + cfg.learnedTunnelTtlMs);
    return true;
  }
  // Hosts that have completed at least one decrypted request. A client that later closes right after
  // a handshake is then unlikely to be rejecting the certificate (kiro-cli's own hosts, for example),
  // so the silent-drop signal below never learns them. Memory first, then the database (survives restarts).
  const workedHosts = new Set();
  const workedQuery = db.raw.prepare("SELECT 1 AS ok FROM transactions WHERE host = ? AND kind = 'mitm' AND status IS NOT NULL LIMIT 1");
  function hostEverWorked(host) {
    if (workedHosts.has(host)) return true;
    try {
      if (workedQuery.get(host)) { workedHosts.add(host); return true; }
    } catch { /* treat a failed lookup as "unknown" */ }
    return false;
  }
  function learnedHosts() {
    const t = now();
    for (const [h, until] of learned) if (until <= t) learned.delete(h);
    return [...learned].map(([host, until]) => ({ host, expires_in_s: Math.round((until - t) / 1000) }));
  }
  // `why` says how the rejection was detected, e.g. "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA" (the client sent
  // a certificate alert) or a description of the silent-drop signal.
  function learnHost(host, port, why) {
    const already = learned.has(host) && learned.get(host) > now();
    learned.set(host, now() + cfg.learnedTunnelTtlMs);
    if (already) return;
    log('warn', `client rejected the proxy certificate for ${host} (${why}); tunnelling it blind from now on, ` +
      `for ${cfg.learnedTunnelTtlHours} h of inactivity (LEARN_TUNNELS=false disables this; add it to TUNNEL_HOSTS to make it permanent)`);
    try {
      // The rejected attempt never produced a request, so record it as its own visible row.
      db.insert({
        kind: 'mitm', ts: Date.now(), host, port, method: 'CONNECT', status: null, aborted: true,
        error: `client rejected the proxy certificate (${why}); this host is tunnelled blind from now on`,
      });
    } catch (e) {
      log('error', `failed to record the rejected handshake: ${e.message}`);
    }
  }
  let purgeTimer = null;
  let ready = null;

  // ---- logging UI and API --------------------------------------------------

  function send(res, status, headers, body) {
    res.writeHead(status, {
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-security-policy': CSP,
      ...headers,
    });
    res.end(body);
  }
  const sendJson = (res, status, obj) => send(res, status, { 'content-type': 'application/json' }, JSON.stringify(obj));

  function rowDetail(row) {
    const reqH = parseJsonSafe(row.req_headers) || {};
    const resH = parseJsonSafe(row.res_headers) || {};
    const asBuf = b => (b ? Buffer.from(b) : null);
    return {
      id: row.id,
      summary: {
        category: row.category,
        method: row.method,
        url: `https://${row.host}${row.port && row.port !== 443 ? ':' + row.port : ''}${row.path || ''}`,
        operation: row.operation,
        status: row.status,
        conversation_id: row.conversation_id,
        model_id: row.model_id,
        history_count: row.history_count,
        tools_count: row.tools_count,
        cwd: row.cwd,
        last_user_message: row.last_user_message,
        res_events: parseJsonSafe(row.res_events),
        context_usage: parseJsonSafe(row.context_usage),
        metering: parseJsonSafe(row.metering),
        ttfb_ms: row.ttfb_ms,
        duration_ms: row.duration_ms,
        req_bytes: row.req_bytes,
        res_bytes: row.res_bytes,
        aborted: !!row.aborted,
        error: row.error,
        error_kind: errorKind(row),
      },
      request: {
        headers: reqH,
        body: decodeBody(asBuf(row.req_body), { contentType: reqH['content-type'], contentEncoding: reqH['content-encoding'], truncated: !!row.req_truncated }),
      },
      response: {
        headers: resH,
        body: decodeBody(asBuf(row.res_body), { contentType: resH['content-type'], contentEncoding: resH['content-encoding'], truncated: !!row.res_truncated }),
      },
    };
  }

  function handleLocal(req, res) {
    if (!req.url || req.url[0] !== '/') {
      return send(res, 501, { 'content-type': 'text/plain' }, `${NAME}: only CONNECT tunnelling is supported, not plain proxy requests\n`);
    }
    // DNS-rebinding guard: only answer when addressed as a loopback name.
    const hostHeader = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(hostHeader)) return send(res, 403, { 'content-type': 'text/plain' }, 'forbidden host\n');
    if (req.method !== 'GET') return send(res, 405, { 'content-type': 'text/plain', allow: 'GET' }, 'method not allowed\n');

    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/') { res.writeHead(302, { location: '/proxy/data' }); return res.end(); }
    if (p === '/proxy/health') {
      return sendJson(res, 200, {
        status: 'ok',
        name: NAME,
        version: pkg.version,
        pid: process.pid,
        node: process.version,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        ca_cert: certs.caCertPath,
        ca_bundle: certs.bundlePath,
        rows: db.count(),
        learned_tunnels: learnedHosts(),
        config: publicConfig(cfg),
      });
    }
    if (p === '/proxy/data') return send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, ui.html);
    if (p === '/proxy/ui.js') return send(res, 200, { 'content-type': 'text/javascript; charset=utf-8' }, ui.js);
    if (p === '/proxy/ui.css') return send(res, 200, { 'content-type': 'text/css; charset=utf-8' }, ui.css);
    if (p === '/proxy/api/rows') {
      const rows = db.list({
        limit: url.searchParams.get('limit') || 8,
        tunnels: url.searchParams.get('tunnels') === '1',
        telemetry: url.searchParams.get('telemetry') === '1',
      }).map(r => ({ ...r, error_kind: errorKind(r) }));
      return sendJson(res, 200, { rows, learned: learnedHosts().map(l => l.host) });
    }
    const m = /^\/proxy\/api\/rows\/(\d+)$/.exec(p);
    if (m) {
      const row = db.get(Number(m[1]));
      return row ? sendJson(res, 200, rowDetail(row)) : sendJson(res, 404, { error: 'not found' });
    }
    return send(res, 404, { 'content-type': 'text/plain' }, 'not found\n');
  }

  // ---- decrypted (MITM) transactions ---------------------------------------

  function handleMitmRequest(req, res) {
    const target = req.socket.mitmTarget;
    req.socket.sawRequest = true;
    const start = Date.now();
    const state = { done: false, status: null, ttfb: null, resHeaders: null, error: null, ur: null, upReq: null };
    const reqCap = new Capture(cfg.bodyCapBytes);
    const resCap = new Capture(cfg.bodyCapBytes);
    const operation = operationName(req.headers);

    let pathAndQuery;
    try {
      const u = new URL(req.url, `https://${target.host}`);
      pathAndQuery = u.pathname + u.search;
    } catch {
      req.resume();
      return send(res, 400, { 'content-type': 'text/plain' }, 'bad request target\n');
    }

    function finish() {
      if (state.done) return;
      state.done = true;
      const aborted = !res.writableFinished;
      try {
        const reqBuf = reqCap.buffer();
        const resBuf = resCap.buffer();
        const keep = cfg.logFullBodies;
        const row = {
          kind: 'mitm',
          ts: start,
          host: target.host,
          port: target.port,
          method: req.method,
          path: pathAndQuery,
          operation,
          status: state.status,
          ttfb_ms: state.ttfb,
          duration_ms: Date.now() - start,
          req_bytes: reqCap.total,
          res_bytes: resCap.total,
          req_truncated: reqCap.truncated,
          res_truncated: resCap.truncated,
          aborted,
          error: state.error,
          req_headers: JSON.stringify(redactHeaders(req.headers)),
          res_headers: state.resHeaders ? JSON.stringify(redactHeaders(state.resHeaders)) : null,
          req_body: keep && reqBuf.length ? reqBuf : null,
          res_body: keep && resBuf.length ? resBuf : null,
          ...extractRequest(operation, reqBuf, cfg),
          ...extractResponse(operation, resBuf, cfg),
        };
        if (state.status) workedHosts.add(target.host);
        const id = db.insert(row);
        log('info', `#${id} ${req.method} ${target.host}${pathAndQuery} -> ${state.status ?? '-'} ${row.duration_ms}ms req=${reqCap.total}B res=${resCap.total}B${aborted ? ' ABORTED' : ''}${state.error ? ' ERR=' + state.error : ''}`);
      } catch (e) {
        log('error', `failed to record transaction: ${e.message}`);
      }
    }

    // Fires after a normal finish and after any abort.
    res.on('close', () => {
      if (!res.writableFinished) {
        if (state.upReq) state.upReq.destroy();
        if (state.ur) state.ur.destroy();
      }
      finish();
    });

    const up = resolveUpstream(target.host, target.port);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    headers.host = target.port === 443 ? target.host : `${target.host}:${target.port}`;

    const upReq = https.request({
      host: up.host,
      port: up.port,
      servername: up.servername || target.host,
      ca: up.ca,
      agent,
      method: req.method,
      path: pathAndQuery,
      headers,
    });
    state.upReq = upReq;

    upReq.on('response', ur => {
      state.ur = ur;
      state.status = ur.statusCode;
      state.ttfb = Date.now() - start;
      state.resHeaders = ur.headers;
      res.writeHead(ur.statusCode, ur.statusMessage, ur.headers);
      ur.on('data', c => resCap.push(c));
      ur.on('error', e => { state.error = `upstream response: ${e.message}`; res.destroy(); });
      ur.on('aborted', () => { state.error = state.error || 'upstream aborted the response'; res.destroy(); });
      ur.pipe(res);
    });

    upReq.on('error', e => {
      state.error = `upstream: ${e.code || e.message}`;
      log('warn', `upstream error for ${target.host}: ${e.code || ''} ${e.message}`);
      if (!res.headersSent) {
        state.status = 502;
        send(res, 502, { 'content-type': 'application/json' }, JSON.stringify({ error: 'bad gateway', message: e.message }));
      } else {
        res.destroy();
      }
    });

    req.on('data', c => reqCap.push(c));
    req.on('error', e => { state.error = `client request: ${e.message}`; upReq.destroy(); });
    req.pipe(upReq);
  }

  const mitmServer = http.createServer(handleMitmRequest);
  mitmServer.requestTimeout = 0;
  mitmServer.timeout = 0;
  mitmServer.keepAliveTimeout = 60000;
  mitmServer.on('clientError', (err, socket) => { log('debug', `client error: ${err.code || err.message}`); socket.destroy(); });

  // Certificate problems on the client side almost always mean the client does not trust the
  // proxy CA (it ignores SSL_CERT_FILE) - the fix is to tunnel that host instead.
  const SILENT_DROP_WINDOW_MS = 5000;
  const TRUST_ERRORS = /UNKNOWN_CA|BAD_CERTIFICATE|CERTIFICATE_UNKNOWN|UNSUPPORTED_CERTIFICATE|CERTIFICATE_REQUIRED/;

  function mitm(clientSocket, head, host, port) {
    certs.getSecureContext(host).then(ctx => {
      if (clientSocket.destroyed) return;
      try {
        clientSocket.write(CONNECT_ESTABLISHED);
        if (head && head.length) clientSocket.unshift(head);
        const secure = new tls.TLSSocket(clientSocket, { isServer: true, secureContext: ctx, ALPNProtocols: ['http/1.1'] });
        secure.mitmTarget = { host, port };
        let handshakeAt = null;
        // 'secure' fires when the server side finishes the handshake. A TLS 1.3 client sends its
        // Finished before it verifies the server certificate, so a rejecting client can close
        // before 'secure' does fire; 'keylog' (handshake keys derived) is an earlier signal that
        // the client got at least as far as receiving our certificate.
        const markHandshake = () => { if (handshakeAt === null) handshakeAt = now(); };
        secure.once('secure', markHandshake);
        secure.once('keylog', markHandshake);
        secure.on('error', e => {
          const code = String(e.code || e.message);
          if (TRUST_ERRORS.test(code)) {
            if (cfg.learnTunnels) learnHost(host, port, code);
            else log('warn', `TLS with client failed for ${host}: ${code} - the client does not trust the proxy CA; add ${host} to TUNNEL_HOSTS to stop decrypting it`);
          } else {
            log('warn', `TLS with client failed for ${host}: ${code}`);
          }
        });
        sockets.add(secure);
        secure.on('close', () => {
          sockets.delete(secure);
          // Some TLS stacks (GnuTLS, used by git; Node) finish the handshake, check the certificate
          // afterwards, and just close without any alert. Treat "handshake done, then closed within a
          // few seconds without a single request" as a rejection, unless the host has worked before.
          // Only learn when the handshake reached our certificate but no request followed, inside a
          // short window. handshakeAt === null means nothing was exchanged (not a certificate rejection).
          if (secure.sawRequest || !cfg.learnTunnels || handshakeAt === null) return;
          if (now() - handshakeAt > SILENT_DROP_WINDOW_MS) return;
          if (hostEverWorked(host)) return;
          learnHost(host, port, 'the client closed right after the TLS handshake without sending a request');
        });
        mitmServer.emit('connection', secure);
      } catch (e) {
        log('error', `could not start decrypting ${host}: ${e.message}`);
        clientSocket.destroy();
      }
    }, e => {
      // No certificate can be issued for this name (for example it is not a valid DNS name).
      // Fail open to an encrypted tunnel rather than breaking the connection.
      log('warn', `cannot issue a certificate for ${host} (${e.message}); tunnelling it blind instead`);
      tunnel(clientSocket, head, host, port);
    });
  }

  // ---- blind tunnel --------------------------------------------------------

  function tunnel(clientSocket, head, host, port) {
    const start = Date.now();
    let up = 0;
    let down = 0;
    let error = null;
    let established = false;
    let recorded = false;

    const upTarget = resolveUpstream(host, port);
    const upstream = net.connect({ host: upTarget.host, port: upTarget.port });
    const record = () => {
      if (recorded) return;
      recorded = true;
      try {
        db.insert({
          kind: 'tunnel', ts: start, host, port, method: 'CONNECT',
          status: established ? 200 : 502,
          duration_ms: Date.now() - start, req_bytes: up, res_bytes: down, error,
        });
        log('debug', `tunnel ${host}:${port} up=${up}B down=${down}B ${Date.now() - start}ms${error ? ' ERR=' + error : ''}`);
      } catch (e) {
        log('error', `failed to record tunnel: ${e.message}`);
      }
    };

    upstream.once('connect', () => {
      established = true;
      clientSocket.write(CONNECT_ESTABLISHED);
      if (head && head.length) { up += head.length; upstream.write(head); }
      clientSocket.on('data', d => { up += d.length; });
      upstream.on('data', d => { down += d.length; });
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', e => {
      error = e.code || e.message;
      if (!established) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    });
    upstream.on('close', () => { clientSocket.destroy(); record(); });
    clientSocket.on('close', () => { upstream.destroy(); record(); });
  }

  // ---- server --------------------------------------------------------------

  const server = http.createServer(handleLocal);
  server.requestTimeout = 0;
  server.on('clientError', (err, socket) => { log('debug', `client error: ${err.code || err.message}`); socket.destroy(); });
  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => {});
    const target = parseHostPort(req.url || '');
    if (!target) return clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    if (shouldDecrypt(cfg, target.host, target.port) && !isLearned(target.host)) mitm(clientSocket, head, target.host, target.port);
    else tunnel(clientSocket, head, target.host, target.port);
  });

  function runPurge() {
    try {
      const n = db.purge({ days: cfg.retentionDays, count: cfg.retentionCount });
      if (n > 0) log('info', `retention purge removed ${n} rows`);
    } catch (e) {
      log('error', `retention purge failed: ${e.message}`);
    }
  }

  async function start() {
    if (ready) return ready;
    ready = (async () => {
      const info = await certs.init();
      runPurge();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.listenHost, () => { server.off('error', reject); resolve(); });
      });
      purgeTimer = setInterval(runPurge, PURGE_INTERVAL_MS);
      purgeTimer.unref();
      return { port: server.address().port, ...info };
    })();
    return ready;
  }

  async function stop() {
    if (purgeTimer) clearInterval(purgeTimer);
    agent.destroy();
    for (const s of sockets) s.destroy();
    await new Promise(resolve => server.close(() => resolve()));
    mitmServer.close();
    db.close();
  }

  return { start, stop, server, config: cfg, db, certs };
}

async function main() {
  let proxy;
  try {
    proxy = createProxy({ config: loadConfig({ argv: process.argv.slice(2) }) });
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  }
  const cfg = proxy.config;
  let info;
  try {
    info = await proxy.start();
  } catch (e) {
    console.error(`${NAME}: failed to start: ${e.code === 'EADDRINUSE' ? `port ${cfg.port} is already in use` : e.message}`);
    process.exit(1);
  }
  console.log(`\n${NAME} ${pkg.version} running (pid ${process.pid}, ${process.version})`);
  console.log(`  Listen    : http://${cfg.listenHost}:${info.port}   UI: http://localhost:${info.port}/proxy/data`);
  console.log(`  Tunnels   : ${cfg.tunnelHostsRaw || '(none)'}   (left encrypted; EVERY other host on port 443 is decrypted)`);
  console.log(`  Fallback  : ${cfg.learnTunnels ? `a host whose client rejects the proxy CA is tunnelled blind for ${cfg.learnedTunnelTtlHours} h after its last use` : 'off (LEARN_TUNNELS=false)'}`);
  console.log(`  DB        : ${cfg.dbPath}`);
  console.log(`  CA cert   : ${info.caCertPath}`);
  console.log(`  CA bundle : ${info.bundlePath}   (use as SSL_CERT_FILE for kiro-cli)`);
  console.log(`  Bodies    : ${cfg.logFullBodies ? `stored, cap ${cfg.bodyCapKilobytes === 0 ? 'unlimited' : cfg.bodyCapKilobytes + ' KB'}` : 'not stored'}`);
  console.log(`  Retention : delete rows older than ${cfg.retentionDays} days AND outside newest ${cfg.retentionCount}\n`);

  let stopping = false;
  const shutdown = signal => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 5000).unref();
    proxy.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main();

module.exports = { createProxy, Capture, parseHostPort };
