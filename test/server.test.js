'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { execFile } = require('node:child_process');

const { loadConfig } = require('../src/config');
const { createCertAuthority } = require('../src/certs');
const { createProxy } = require('../src/server');
const { eventFrame } = require('./helpers');

const HOST = 'runtime.test.kiro.dev';
const silent = () => {};

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcp-int-')); }

// The proxy records a row when the response socket closes, which can be a few
// milliseconds after the client has read the last byte. Wait for it instead of
// assuming it is already there.
async function waitForRow(proxy, { tunnels = false, aborted = false, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = proxy.db.list({ limit: 1, tunnels, aborted });
    if (rows.length > 0) return proxy.db.get(rows[0].id);
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('no row was recorded in time');
}

// Starts a fake "real" server over HTTPS for `host`, signed by its own CA.
async function startUpstream(dir, handler, host = HOST) {
  const authority = createCertAuthority({ certDir: path.join(dir, `upstream-certs-${host}`), systemCaFile: path.join(dir, 'system.pem') });
  await authority.init();
  const ctx = await authority.getSecureContext(host);
  const server = https.createServer({ SNICallback: (_n, cb) => cb(null, ctx) }, handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, caPem: fs.readFileSync(authority.caCertPath) };
}

// Legacy env-style keys used by existing callers, mapped to the config.json keys.
const CONFIG_KEY = {
  DB_PATH: 'dbPath', CERT_DIR: 'certDir', SYSTEM_CA_FILE: 'systemCaFile',
  LOG_FULL_BODIES: 'logFullBodies', TUNNEL_HOSTS: 'tunnelHosts', LEARN_TUNNELS: 'learnTunnels',
};
function toConfigValue(key, raw) {
  if (key === 'tunnelHosts') return raw === '' ? [] : String(raw).split(',').map(s => s.trim()).filter(Boolean);
  if (key === 'logFullBodies' || key === 'learnTunnels') return raw === true || /^(true|1|yes)$/i.test(raw);
  return raw;
}

// `map` redirects named hosts to local fakes: { 'name.test.example': { host, port, ca?, servername? } }.
async function startProxy(dir, upstream, env = {}, { map = {}, log = silent, now } = {}) {
  const fileCfg = { dbPath: path.join(dir, 'proxy.db'), certDir: path.join(dir, 'certs'), systemCaFile: path.join(dir, 'system.pem') };
  for (const [k, v] of Object.entries(env)) {
    const key = CONFIG_KEY[k] || k;
    fileCfg[key] = toConfigValue(key, v);
  }
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(fileCfg));
  const cfg = loadConfig({ argv: [], configFile });
  cfg.port = 0;
  const proxy = createProxy({
    config: cfg,
    log,
    now,
    upstreamResolver: (host, port) => {
      if (map[host]) return map[host];
      if (upstream && host === HOST) return { host: '127.0.0.1', port: upstream.port, ca: upstream.caPem, servername: host };
      return { host, port };
    },
  });
  const info = await proxy.start();
  return { proxy, port: info.port, caPem: fs.readFileSync(proxy.certs.caCertPath) };
}

// CONNECT through the proxy, then speak TLS to it as kiro-cli would.
function connectTunnel(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('error', reject);
    req.end();
  });
}

// An agent that reuses an already established (tunnelled) TLS socket.
function agentFor(secure) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = () => secure;
  return agent;
}

async function mitmRequest(proxyPort, caPem, { method = 'POST', path: p = '/', headers = {}, body = '', host = HOST } = {}) {
  const { status, socket } = await connectTunnel(proxyPort, `${host}:443`);
  assert.equal(status, 200);
  const secure = tls.connect({ socket, servername: host, ca: caPem });
  return new Promise((resolve, reject) => {
    const req = https.request({ host, method, path: p, headers, agent: agentFor(secure) }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { secure.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function getJson(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

const chatRequest = JSON.stringify({
  conversationState: {
    conversationId: 'conv-xyz',
    history: [{ userInputMessage: { content: 'ctx' } }],
    currentMessage: { userInputMessage: { content: 'say hi', modelId: 'auto', userInputMessageContext: { envState: { currentWorkingDirectory: '/work' }, tools: [{}, {}] } } },
  },
  profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/X',
});

const chatResponse = Buffer.concat([
  eventFrame('initial-response', { conversationId: '' }),
  eventFrame('assistantResponseEvent', { content: 'Hel' }),
  eventFrame('assistantResponseEvent', { content: 'lo' }),
  eventFrame('contextUsageEvent', { contextUsagePercentage: 2 }),
  eventFrame('meteringEvent', { unit: 'credit', usage: 0.5 }),
]);

function streamingHandler(seen) {
  return (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream', 'set-cookie': 'sid=secret' });
      // Send the stream in separate writes to prove it is relayed as it arrives.
      let i = 0;
      const step = 20;
      const timer = setInterval(() => {
        if (i >= chatResponse.length) { clearInterval(timer); res.end(); return; }
        res.write(chatResponse.subarray(i, i + step));
        i += step;
      }, 2);
    });
  };
}

test('decrypts, forwards and logs a chat transaction', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const seen = [];
  const upstream = await startUpstream(dir, streamingHandler(seen));
  const { proxy, port, caPem } = await startProxy(dir, upstream);
  try {
    const res = await mitmRequest(port, caPem, {
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
        authorization: 'Bearer super-secret-token',
      },
      body: chatRequest,
    });

    // Client receives exactly what the upstream sent.
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, chatResponse);
    // Upstream received the original request, including the credential.
    assert.equal(seen[0].headers.authorization, 'Bearer super-secret-token');
    assert.equal(seen[0].body.toString(), chatRequest);
    assert.equal(seen[0].headers.host, HOST);

    const row = await waitForRow(proxy);
    assert.equal(row.kind, 'mitm');
    assert.equal(row.host, HOST);
    assert.equal(row.status, 200);
    assert.equal(row.operation, 'GenerateAssistantResponse');
    assert.equal(row.conversation_id, 'conv-xyz');
    assert.equal(row.model_id, 'auto');
    assert.equal(row.history_count, 1);
    assert.equal(row.tools_count, 2);
    assert.equal(row.cwd, '/work');
    assert.equal(row.last_user_message, 'say hi');
    assert.equal(row.res_text, 'Hello');
    assert.deepEqual(JSON.parse(row.res_events), { 'initial-response': 1, assistantResponseEvent: 2, contextUsageEvent: 1, meteringEvent: 1 });
    assert.deepEqual(JSON.parse(row.metering), { unit: 'credit', usage: 0.5 });
    assert.equal(row.req_bytes, Buffer.byteLength(chatRequest));
    assert.equal(row.res_bytes, chatResponse.length);
    assert.equal(row.req_truncated, 0);
    assert.equal(row.res_truncated, 0);
    assert.equal(row.aborted, 0);
    assert.deepEqual(Buffer.from(row.res_body), chatResponse);
    assert.equal(Buffer.from(row.req_body).toString(), chatRequest);
    assert.ok(row.ttfb_ms >= 0 && row.duration_ms >= row.ttfb_ms);

    // Secrets are redacted in stored headers, in both directions.
    const stored = row.req_headers + row.res_headers;
    assert.ok(!stored.includes('super-secret-token'));
    assert.ok(!stored.includes('sid=secret'));
    assert.equal(JSON.parse(row.req_headers).authorization, '[REDACTED]');

    // The detail API decodes the event stream for the UI.
    const detail = JSON.parse((await getJson(port, `/proxy/api/rows/${row.id}`, { host: 'localhost' })).text);
    assert.equal(detail.response.body.format, 'eventstream');
    assert.equal(detail.response.body.data.text, 'Hello');
    assert.equal(detail.request.body.format, 'json');
    assert.equal(detail.summary.operation, 'GenerateAssistantResponse');
  } finally {
    await proxy.stop();
    upstream.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('body cap truncates stored bodies but not the traffic, and flags it', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const upstream = await startUpstream(dir, streamingHandler([]));
  const { proxy, port, caPem } = await startProxy(dir, upstream);
  proxy.config.bodyCapBytes = 10;
  try {
    const res = await mitmRequest(port, caPem, {
      headers: { 'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse' },
      body: chatRequest,
    });
    assert.deepEqual(res.body, chatResponse);
    const row = await waitForRow(proxy);
    assert.equal(row.req_truncated, 1);
    assert.equal(row.res_truncated, 1);
    assert.equal(row.req_body.length, 10);
    assert.equal(row.res_body.length, 10);
    assert.equal(row.req_bytes, Buffer.byteLength(chatRequest));
    assert.equal(row.res_bytes, chatResponse.length);
  } finally {
    await proxy.stop();
    upstream.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LOG_FULL_BODIES=false stores metadata and extracted fields but no bodies', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const upstream = await startUpstream(dir, streamingHandler([]));
  const { proxy, port, caPem } = await startProxy(dir, upstream, { LOG_FULL_BODIES: 'false' });
  try {
    await mitmRequest(port, caPem, {
      headers: { 'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse' },
      body: chatRequest,
    });
    const row = await waitForRow(proxy);
    assert.equal(row.req_body, null);
    assert.equal(row.res_body, null);
    assert.equal(row.conversation_id, 'conv-xyz');
    assert.equal(row.res_text, 'Hello');
  } finally {
    await proxy.stop();
    upstream.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreachable upstream yields 502 to the client and an error row', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const upstream = await startUpstream(dir, streamingHandler([]));
  const closedPort = upstream.port;
  await new Promise(r => upstream.server.close(r));
  const { proxy, port, caPem } = await startProxy(dir, { port: closedPort, caPem: upstream.caPem });
  try {
    const res = await mitmRequest(port, caPem, { body: '{}' });
    assert.equal(res.status, 502);
    const row = await waitForRow(proxy);
    assert.equal(row.status, 502);
    assert.match(row.error, /upstream/);
  } finally {
    await proxy.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a client that aborts mid-stream is recorded as aborted', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const upstream = await startUpstream(dir, (req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('start'); /* never ends */ });
  });
  const { proxy, port, caPem } = await startProxy(dir, upstream);
  try {
    const { socket } = await connectTunnel(port, `${HOST}:443`);
    const secure = tls.connect({ socket, servername: HOST, ca: caPem });
    await new Promise((resolve, reject) => {
      const req = https.request({ host: HOST, method: 'POST', path: '/', agent: agentFor(secure) }, res => {
        res.once('data', () => { secure.destroy(); resolve(); });
      });
      req.on('error', () => {});
      req.end('{}');
      setTimeout(() => reject(new Error('no response data')), 5000).unref();
    });
    const row = await waitForRow(proxy, { aborted: true });
    assert.equal(row.aborted, 1);
    assert.equal(row.status, 200);
  } finally {
    await proxy.stop();
    upstream.server.closeAllConnections();
    upstream.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('IP addresses and non-443 ports are tunnelled blind and logged with byte counts', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const echo = net.createServer(s => s.on('data', d => s.write(Buffer.concat([Buffer.from('echo:'), d]))));
  await new Promise(r => echo.listen(0, '127.0.0.1', r));
  const { proxy, port } = await startProxy(dir, null);
  try {
    const { status, socket } = await connectTunnel(port, `127.0.0.1:${echo.address().port}`);
    assert.equal(status, 200);
    const reply = await new Promise(resolve => { socket.once('data', resolve); socket.write('hello'); });
    assert.equal(reply.toString(), 'echo:hello');
    socket.destroy();
    const row = await waitForRow(proxy, { tunnels: true });
    assert.equal(row.kind, 'tunnel');
    assert.equal(row.host, '127.0.0.1');
    assert.equal(row.req_bytes, 5);
    assert.equal(row.res_bytes, 10);
    assert.equal(row.status, 200);
    // Tunnels never appear in the default list and never have bodies.
    assert.equal(proxy.db.list({ limit: 5 }).length, 0);
    assert.equal(proxy.db.get(row.id).req_body, null);
  } finally {
    await proxy.stop();
    echo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tunnel to an unreachable target returns 502 and logs an error', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise(r => probe.close(r));
  const { proxy, port } = await startProxy(dir, null);
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `127.0.0.1:${deadPort}` });
      req.on('connect', (res, s) => { s.destroy(); resolve(res.statusCode); });
      req.on('response', res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 502);
    const row = await waitForRow(proxy, { tunnels: true });
    assert.equal(row.status, 502);
    assert.equal(row.error, 'ECONNREFUSED');
  } finally {
    await proxy.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every host is decrypted by default, whatever its name', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const NEW_HOST = 'anything.test.example';
  const seen = [];
  const upstream = await startUpstream(dir, (req, res) => { seen.push(req.headers.host); req.resume(); req.on('end', () => res.end('{"ok":true}')); }, NEW_HOST);
  const map = { [NEW_HOST]: { host: '127.0.0.1', port: upstream.port, ca: upstream.caPem, servername: NEW_HOST } };
  const { proxy, port, caPem } = await startProxy(dir, null, {}, { map });
  try {
    const res = await mitmRequest(port, caPem, { host: NEW_HOST, method: 'GET', path: '/hello?x=1' });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), '{"ok":true}');
    const row = await waitForRow(proxy);
    assert.equal(row.kind, 'mitm');
    assert.equal(row.host, NEW_HOST);
    assert.equal(row.path, '/hello?x=1');
    assert.equal(row.category, 'other');
    assert.equal(Buffer.from(row.res_body).toString(), '{"ok":true}');
  } finally {
    await proxy.stop();
    upstream.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a host on TUNNEL_HOSTS is relayed encrypted: the client sees the real certificate and nothing is stored but byte counts', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const SECRET_HOST = 'creds.test.example';
  const upstream = await startUpstream(dir, (req, res) => { req.resume(); req.on('end', () => res.end('{"accessToken":"super-secret"}')); }, SECRET_HOST);
  const map = { [SECRET_HOST]: { host: '127.0.0.1', port: upstream.port } };
  const { proxy, port, caPem } = await startProxy(dir, null, { TUNNEL_HOSTS: SECRET_HOST }, { map });
  try {
    // The client trusts ONLY the real server's CA. If the proxy had decrypted, this handshake would fail.
    const { status, socket } = await connectTunnel(port, `${SECRET_HOST}:443`);
    assert.equal(status, 200);
    const secure = tls.connect({ socket, servername: SECRET_HOST, ca: upstream.caPem });
    const body = await new Promise((resolve, reject) => {
      const req = https.request({ host: SECRET_HOST, method: 'GET', path: '/', agent: agentFor(secure) }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => { secure.destroy(); resolve(Buffer.concat(chunks).toString()); });
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, '{"accessToken":"super-secret"}');
    const row = await waitForRow(proxy, { tunnels: true });
    assert.equal(row.kind, 'tunnel');
    assert.equal(row.host, SECRET_HOST);
    assert.equal(row.req_body, null);
    assert.equal(row.res_body, null);
    assert.ok(row.res_bytes > 0);
    assert.equal(proxy.db.list({ limit: 10 }).length, 0, 'no decrypted row exists');
    assert.ok(!JSON.stringify(proxy.db.raw.prepare('SELECT * FROM transactions').all().map(r => ({ ...r, req_body: undefined, res_body: undefined }))).includes('super-secret'));
  } finally {
    await proxy.stop();
    upstream.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('when no certificate can be issued for a host, it fails open to a blind tunnel instead of breaking', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const echo = net.createServer(s => s.on('data', d => s.write(Buffer.concat([Buffer.from('echo:'), d]))));
  await new Promise(r => echo.listen(0, '127.0.0.1', r));
  const ODD_HOST = 'under_score.test.example'; // not a valid DNS host name: no certificate is issued for it
  const logs = [];
  const map = { [ODD_HOST]: { host: '127.0.0.1', port: echo.address().port } };
  const { proxy, port } = await startProxy(dir, null, {}, { map, log: (lvl, msg) => logs.push(`${lvl}: ${msg}`) });
  try {
    const { status, socket } = await connectTunnel(port, `${ODD_HOST}:443`);
    assert.equal(status, 200);
    const reply = await new Promise(resolve => { socket.once('data', resolve); socket.write('hi'); });
    assert.equal(reply.toString(), 'echo:hi');
    socket.destroy();
    const row = await waitForRow(proxy, { tunnels: true });
    assert.equal(row.kind, 'tunnel');
    assert.equal(row.host, ODD_HOST);
    assert.ok(logs.some(l => /cannot issue a certificate for under_score/.test(l)), logs.join('\n'));
  } finally {
    await proxy.stop();
    echo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `openssl s_client` aborts the handshake with an unknown_ca alert when it does not trust the
// certificate, like kiro-cli's TLS stack (Node's own client finishes the handshake and then
// just drops the connection, which the server cannot tell apart from a normal close).
function untrustingClient(proxyPort, host) {
  return new Promise(resolve => {
    execFile('openssl', ['s_client', '-proxy', `127.0.0.1:${proxyPort}`, '-connect', `${host}:443`,
      '-servername', host, '-verify_return_error'], { timeout: 15000 }, () => resolve()).stdin.end();
  });
}

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('condition not met in time');
}

// One request through a CONNECT tunnel to `host`, trusting only `trustedCa`.
async function requestVia(proxyPort, host, trustedCa) {
  const { status, socket } = await connectTunnel(proxyPort, `${host}:443`);
  assert.equal(status, 200);
  const secure = tls.connect({ socket, servername: host, ca: trustedCa });
  return new Promise((resolve, reject) => {
    secure.on('error', reject);
    const req = https.request({ host, method: 'GET', path: '/', agent: agentFor(secure) }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { secure.destroy(); resolve(Buffer.concat(chunks).toString()); });
    });
    req.on('error', reject);
    req.end();
  });
}

const LEARN_HOST = 'learn.test.example';
async function learnFixture(env = {}, extra = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const upstream = await startUpstream(dir, (req, res) => { req.resume(); req.on('end', () => res.end('real-server-says-hi')); }, LEARN_HOST);
  const map = { [LEARN_HOST]: { host: '127.0.0.1', port: upstream.port, ca: upstream.caPem, servername: LEARN_HOST } };
  const logs = [];
  const started = await startProxy(dir, null, env, { map, log: (lvl, msg) => logs.push(`${lvl}: ${msg}`), ...extra });
  const cleanup = async () => { await started.proxy.stop(); upstream.server.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, upstream, logs, cleanup, ...started };
}

test('auto-fallback: after a client rejects the proxy certificate the host is tunnelled blind, and the rejection is visible', async () => {
  const f = await learnFixture();
  try {
    await untrustingClient(f.port, LEARN_HOST);
    await waitFor(() => f.proxy.db.list({ limit: 5, aborted: true }).find(r => /rejected the proxy certificate/.test(r.error || '')));

    // 1. The rejected attempt is recorded as its own visible, flagged row.
    const rejected = f.proxy.db.list({ limit: 5, aborted: true }).find(r => /rejected the proxy certificate/.test(r.error));
    assert.equal(rejected.host, LEARN_HOST);
    assert.equal(rejected.kind, 'mitm');
    assert.equal(rejected.aborted, 1);
    assert.equal(rejected.status, null);
    assert.match(rejected.error, /UNKNOWN_CA/);
    assert.ok(f.logs.some(l => /warn: client rejected the proxy certificate for learn\.test\.example.*tunnelling it blind from now on/.test(l)), f.logs.join('\n'));

    // 2. It is listed in the health endpoint and in the rows API (shown in the UI).
    const health = JSON.parse((await getJson(f.port, '/proxy/health', { host: 'localhost' })).text);
    assert.deepEqual(health.learned_tunnels.map(h => h.host), [LEARN_HOST]);
    assert.ok(health.learned_tunnels[0].expires_in_s > 0);
    assert.equal(health.config.learnTunnels, true);
    const rows = JSON.parse((await getJson(f.port, '/proxy/api/rows?limit=5', { host: 'localhost' })).text);
    assert.deepEqual(rows.learned, [LEARN_HOST]);

    // 3. The next connection is a blind tunnel: a client that trusts ONLY the real server's CA now succeeds.
    assert.equal(await requestVia(f.port, LEARN_HOST, f.upstream.caPem), 'real-server-says-hi');
    const tunnel = await waitFor(() => f.proxy.db.list({ limit: 10, tunnels: true }).find(r => r.kind === 'tunnel' && r.host === LEARN_HOST));
    assert.equal(tunnel.status, 200);
    assert.equal(f.proxy.db.list({ limit: 10 }).filter(r => r.host === LEARN_HOST && r.status === 200).length, 0, 'no decrypted transaction for it');
  } finally { await f.cleanup(); }
});

test('auto-fallback expires after the TTL, and the expiry slides forward while the host is in use', async () => {
  let clock = 1_000_000;
  const f = await learnFixture({}, { now: () => clock });
  const HOUR = 3600 * 1000;
  try {
    await untrustingClient(f.port, LEARN_HOST);
    await waitFor(async () => (await health(f.port)).learned_tunnels.length === 1);

    const decrypted = async () => { // true if the proxy decrypted (client trusting only the PROXY CA gets through)
      const body = await requestVia(f.port, LEARN_HOST, f.caPem).catch(() => null);
      return body === 'real-server-says-hi';
    };
    clock += 20 * HOUR;                                 // 20 h later: still learned, and the use refreshes it
    assert.equal(await requestVia(f.port, LEARN_HOST, f.upstream.caPem), 'real-server-says-hi', 'still a blind tunnel');
    clock += 20 * HOUR;                                 // 40 h after learning, but only 20 h after last use
    assert.equal(await requestVia(f.port, LEARN_HOST, f.upstream.caPem), 'real-server-says-hi', 'sliding expiry kept it');
    clock += 25 * HOUR;                                 // idle for 25 h: expired
    assert.deepEqual((await health(f.port)).learned_tunnels, []);
    assert.equal(await decrypted(), true, 'decrypted again after the entry expired');
  } finally { await f.cleanup(); }
});

async function health(port) {
  return JSON.parse((await getJson(port, '/proxy/health', { host: 'localhost' })).text);
}

test('with LEARN_TUNNELS=false a rejected certificate only logs a hint and the host stays decrypted', async () => {
  const f = await learnFixture({ LEARN_TUNNELS: 'false' });
  try {
    await untrustingClient(f.port, LEARN_HOST);
    const line = await waitFor(() => f.logs.find(l => /TLS with client failed for learn\.test\.example/.test(l)));
    assert.match(line, /UNKNOWN_CA/);
    assert.match(line, /add learn\.test\.example to TUNNEL_HOSTS/);
    assert.deepEqual((await health(f.port)).learned_tunnels, []);
    // Still decrypted: a client trusting only the proxy CA works, and the transaction is logged.
    assert.equal(await requestVia(f.port, LEARN_HOST, f.caPem), 'real-server-says-hi');
    const row = await waitFor(() => f.proxy.db.list({ limit: 5 }).find(r => r.status === 200));
    assert.equal(row.kind, 'mitm');
  } finally { await f.cleanup(); }
});

// A Node client that does not trust the proxy CA finishes the TLS handshake, checks the certificate
// afterwards, and destroys the socket without sending any alert - the same shape as GnuTLS (git).
function silentlyRejectingClient(proxyPort, host) {
  return new Promise(async resolve => {
    const { socket } = await connectTunnel(proxyPort, `${host}:443`);
    const s = tls.connect({ socket, servername: host }); // trusts only the system roots, not the proxy CA
    s.on('error', () => {});
    s.on('close', () => resolve());
  });
}

test('auto-fallback also catches clients that finish the handshake and then silently drop the connection (GnuTLS/git, Node)', async () => {
  const f = await learnFixture();
  try {
    await silentlyRejectingClient(f.port, LEARN_HOST);
    const h = await waitFor(async () => { const x = await health(f.port); return x.learned_tunnels.length ? x : null; });
    assert.equal(h.learned_tunnels[0].host, LEARN_HOST);
    const rejected = f.proxy.db.list({ limit: 5, aborted: true }).find(r => /rejected the proxy certificate/.test(r.error || ''));
    assert.match(rejected.error, /closed right after the TLS handshake without sending a request/);
    assert.equal(await requestVia(f.port, LEARN_HOST, f.upstream.caPem), 'real-server-says-hi', 'the retry goes through as a blind tunnel');
  } finally { await f.cleanup(); }
});

test('a silent drop is NOT learned for a host that has already completed a decrypted request', async () => {
  const f = await learnFixture();
  try {
    assert.equal(await requestVia(f.port, LEARN_HOST, f.caPem), 'real-server-says-hi'); // a normal, decrypted request
    await waitFor(() => f.proxy.db.list({ limit: 5 }).find(r => r.status === 200));
    await silentlyRejectingClient(f.port, LEARN_HOST);
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual((await health(f.port)).learned_tunnels, [], 'protected: the host is known to work with the proxy CA');
    assert.equal(await requestVia(f.port, LEARN_HOST, f.caPem), 'real-server-says-hi', 'still decrypted');
  } finally { await f.cleanup(); }
});

test('the "has this host worked before" guard survives a proxy restart (it is read from the database)', async () => {
  const f = await learnFixture();
  try {
    // History written by an earlier run of the proxy: a completed decrypted request for this host.
    f.proxy.db.insert({ kind: 'mitm', ts: Date.now() - 1000, host: LEARN_HOST, port: 443, method: 'GET', path: '/', status: 200 });
    await silentlyRejectingClient(f.port, LEARN_HOST);
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual((await health(f.port)).learned_tunnels, []);
  } finally { await f.cleanup(); }
});

test('a client that completes the handshake and closes only after the window is not treated as a rejection', async () => {
  let clock = 5_000_000;
  const f = await learnFixture({}, { now: () => clock });
  try {
    const { socket } = await connectTunnel(f.port, `${LEARN_HOST}:443`);
    const s = tls.connect({ socket, servername: LEARN_HOST, ca: f.caPem }); // trusts the proxy CA
    await new Promise((resolve, reject) => { s.on('secureConnect', resolve); s.on('error', reject); });
    clock += 6000;                       // idle for longer than the 5 s window, then close without a request
    s.destroy();
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual((await health(f.port)).learned_tunnels, []);
  } finally { await f.cleanup(); }
});

test('only certificate-trust failures are learned: garbage and plain-HTTP-on-443 clients do not turn a host into a tunnel', async () => {
  const f = await learnFixture();
  try {
    const { socket } = await connectTunnel(f.port, `${LEARN_HOST}:443`);
    await new Promise(resolve => { socket.on('close', resolve); socket.on('error', () => resolve()); socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'); setTimeout(resolve, 2000).unref(); });
    await waitFor(() => f.logs.some(l => /TLS with client failed for learn\.test\.example/.test(l)));
    assert.deepEqual((await health(f.port)).learned_tunnels, [], 'not learned');
    assert.equal(await requestVia(f.port, LEARN_HOST, f.caPem), 'real-server-says-hi', 'still decrypted afterwards');
  } finally { await f.cleanup(); }
});

test('hosts that are already on the tunnel list are never learned, and an IP or other port needs no learning', async () => {
  const f = await learnFixture({ TUNNEL_HOSTS: LEARN_HOST });
  try {
    // Blind from the start: the client trusting only the real CA works and nothing is learned.
    assert.equal(await requestVia(f.port, LEARN_HOST, f.upstream.caPem), 'real-server-says-hi');
    assert.deepEqual((await health(f.port)).learned_tunnels, []);
  } finally { await f.cleanup(); }
});

test('a remote reset on an established tunnel is classified as reset; a failed connect stays an error', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  // A server that accepts, reads one message, then aborts the connection with a TCP RST.
  const rude = net.createServer(s => { s.on('error', () => {}); s.once('data', () => s.resetAndDestroy()); });
  await new Promise(r => rude.listen(0, '127.0.0.1', r));
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise(r => probe.close(r));
  const { proxy, port } = await startProxy(dir, null);
  try {
    const { status, socket } = await connectTunnel(port, `127.0.0.1:${rude.address().port}`);
    assert.equal(status, 200);
    socket.on('error', () => {});
    socket.write('ping');
    const reset = await waitForRow(proxy, { tunnels: true });
    assert.equal(reset.status, 200);
    assert.equal(reset.error, 'ECONNRESET');
    socket.destroy();

    // A tunnel that never connected is a real error.
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `127.0.0.1:${deadPort}` });
      req.on('connect', (res, s) => { s.destroy(); resolve(); });
      req.on('response', res => { res.resume(); resolve(); });
      req.on('error', reject);
      req.end();
    });
    for (let i = 0; i < 100 && proxy.db.count() < 2; i++) await new Promise(r => setTimeout(r, 20));

    const api = JSON.parse((await getJson(port, '/proxy/api/rows?limit=10&tunnels=1', { host: 'localhost' })).text);
    const byError = Object.fromEntries(api.rows.map(r => [r.error, r.error_kind]));
    assert.equal(byError.ECONNRESET, 'reset');
    assert.equal(byError.ECONNREFUSED, 'error');
  } finally {
    await proxy.stop();
    rude.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the rows API honours the telemetry and tunnels filters', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const { proxy, port } = await startProxy(dir, null);
  try {
    const add = (kind, host) => proxy.db.insert({ kind, ts: Date.now(), host, port: 443, status: 200 });
    add('mitm', 'runtime.eu-central-1.kiro.dev');
    add('tunnel', 'management.eu-central-1.kiro.dev');
    add('tunnel', 'telemetry.eu-central-1.kiro.dev');
    const hosts = async q => JSON.parse((await getJson(port, `/proxy/api/rows?limit=50${q}`, { host: 'localhost' })).text).rows.map(r => r.host).sort();

    assert.deepEqual(await hosts(''), ['runtime.eu-central-1.kiro.dev']);
    assert.deepEqual(await hosts('&tunnels=1'), ['management.eu-central-1.kiro.dev', 'runtime.eu-central-1.kiro.dev']);
    assert.deepEqual(await hosts('&telemetry=1'), ['runtime.eu-central-1.kiro.dev', 'telemetry.eu-central-1.kiro.dev']);
    assert.equal((await hosts('&tunnels=1&telemetry=1')).length, 3);
    assert.deepEqual(await hosts('&telemetry=0&tunnels=0'), ['runtime.eu-central-1.kiro.dev']);
  } finally {
    await proxy.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local routes: health identity, UI assets with CSP, host guard, and plain proxy requests refused', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'system.pem'), '# fake\n');
  const { proxy, port } = await startProxy(dir, null);
  try {
    const health = await getJson(port, '/proxy/health', { host: `localhost:${port}` });
    assert.equal(health.status, 200);
    const h = JSON.parse(health.text);
    assert.equal(h.status, 'ok');
    assert.equal(h.name, 'kiro-cli-proxy');
    assert.equal(h.config.retentionCount, 100);
    assert.ok(!('authorization' in h));

    const page = await getJson(port, '/proxy/data', { host: '127.0.0.1' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.equal((await getJson(port, '/proxy/ui.js', { host: 'localhost' })).status, 200);
    assert.equal((await getJson(port, '/proxy/ui.css', { host: 'localhost' })).status, 200);
    assert.equal((await getJson(port, '/proxy/api/rows', { host: 'localhost' })).status, 200);
    assert.equal((await getJson(port, '/proxy/api/rows/999', { host: 'localhost' })).status, 404);
    assert.equal((await getJson(port, '/nope', { host: 'localhost' })).status, 404);

    // DNS-rebinding style request: right socket, foreign Host header.
    assert.equal((await getJson(port, '/proxy/api/rows', { host: 'evil.example.com' })).status, 403);

    // Absolute-form (plain forward proxy) requests are not supported.
    const abs = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: 'http://example.com/', headers: { host: 'example.com' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(abs, 501);
  } finally {
    await proxy.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
