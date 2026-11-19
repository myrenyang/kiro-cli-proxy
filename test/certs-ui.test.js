'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createCertAuthority, isValidHost } = require('../src/certs');
const ui = require('../src/ui');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcp-test-')); }
function fakeSystemCa(dir) {
  const f = path.join(dir, 'system.pem');
  fs.writeFileSync(f, '# fake system roots\n');
  return f;
}

test('isValidHost accepts DNS names and rejects injection attempts', () => {
  assert.ok(isValidHost('runtime.eu-central-1.kiro.dev'));
  assert.ok(!isValidHost('bad host'));
  assert.ok(!isValidHost('a;rm -rf /'));
  assert.ok(!isValidHost('../etc/passwd'));
  assert.ok(!isValidHost('a..b'));
  assert.ok(!isValidHost(''));
  assert.ok(!isValidHost('-leading.example'));
});

test('init creates the CA, key mode 600, and a bundle with system roots + CA', async () => {
  const dir = tmp();
  try {
    const ca = createCertAuthority({ certDir: path.join(dir, 'certs'), systemCaFile: fakeSystemCa(dir) });
    await ca.init();
    assert.equal(fs.statSync(ca.caKeyPath).mode & 0o777, 0o600);
    const bundle = fs.readFileSync(ca.bundlePath, 'utf8');
    assert.match(bundle, /fake system roots/);
    assert.match(bundle, /BEGIN CERTIFICATE/);
    const subject = execFileSync('openssl', ['x509', '-in', ca.caCertPath, '-noout', '-subject', '-ext', 'basicConstraints']).toString();
    assert.match(subject, /CA:TRUE, pathlen:0/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent init calls converge on one CA (atomic creation)', async () => {
  const dir = tmp();
  try {
    const certDir = path.join(dir, 'certs');
    const sys = fakeSystemCa(dir);
    const cas = Array.from({ length: 4 }, () => createCertAuthority({ certDir, systemCaFile: sys }));
    await Promise.all(cas.map(c => c.init()));
    const pems = new Set(cas.map(c => fs.readFileSync(c.caCertPath, 'utf8')));
    assert.equal(pems.size, 1);
    assert.deepEqual(fs.readdirSync(certDir).filter(n => n.startsWith('.ca-tmp-')), []);
    // The key must match the certificate that survived.
    const certPub = execFileSync('openssl', ['x509', '-in', cas[0].caCertPath, '-noout', '-pubkey']).toString();
    const keyPub = execFileSync('openssl', ['pkey', '-in', cas[0].caKeyPath, '-pubout']).toString();
    assert.equal(certPub, keyPub);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a second start reuses the existing CA and leaf certificates', async () => {
  const dir = tmp();
  try {
    const certDir = path.join(dir, 'certs');
    const sys = fakeSystemCa(dir);
    const first = createCertAuthority({ certDir, systemCaFile: sys });
    await first.init();
    await first.getSecureContext('runtime.example.kiro.dev');
    const caBefore = fs.readFileSync(first.caCertPath, 'utf8');
    const leafBefore = fs.readFileSync(path.join(certDir, 'leaf', 'runtime.example.kiro.dev', 'leaf.pem'), 'utf8');
    const second = createCertAuthority({ certDir, systemCaFile: sys });
    await second.init();
    await second.getSecureContext('runtime.example.kiro.dev');
    assert.equal(fs.readFileSync(second.caCertPath, 'utf8'), caBefore);
    assert.equal(fs.readFileSync(path.join(certDir, 'leaf', 'runtime.example.kiro.dev', 'leaf.pem'), 'utf8'), leafBefore);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('leaf certificate completes a real TLS handshake for a client that trusts only our CA', async () => {
  const dir = tmp();
  try {
    const ca = createCertAuthority({ certDir: path.join(dir, 'certs'), systemCaFile: fakeSystemCa(dir) });
    await ca.init();
    const ctx = await ca.getSecureContext('runtime.example.kiro.dev');
    const sockets = new Set();
    const server = tls.createServer({ SNICallback: (_n, cb) => cb(null, ctx) }, s => { sockets.add(s); s.on('error', () => {}); s.end('ok'); });
    server.on('tlsClientError', () => {});
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const result = await new Promise((resolve, reject) => {
      const c = tls.connect({
        port: server.address().port, host: '127.0.0.1', servername: 'runtime.example.kiro.dev',
        ca: fs.readFileSync(ca.caCertPath),
      }, () => { const r = { authorized: c.authorized, cert: c.getPeerCertificate() }; c.destroy(); resolve(r); });
      c.on('error', reject);
    });
    assert.equal(result.authorized, true);
    assert.match(result.cert.subjectaltname, /DNS:runtime\.example\.kiro\.dev/);
    // A client that does not trust our CA must reject it.
    await assert.rejects(new Promise((resolve, reject) => {
      const c = tls.connect({ port: server.address().port, host: '127.0.0.1', servername: 'runtime.example.kiro.dev' }, resolve);
      c.on('error', reject);
    }), /self-signed|unable to verify|certificate/i);
    // And a different hostname must not validate.
    await assert.rejects(new Promise((resolve, reject) => {
      const c = tls.connect({ port: server.address().port, host: '127.0.0.1', servername: 'other.example.com', ca: fs.readFileSync(ca.caCertPath) }, resolve);
      c.on('error', reject);
    }), /altnames|hostname/i);
    for (const s of sockets) s.destroy();
    server.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent requests for one host generate one leaf; invalid hosts are refused', async () => {
  const dir = tmp();
  try {
    const ca = createCertAuthority({ certDir: path.join(dir, 'certs'), systemCaFile: fakeSystemCa(dir) });
    await ca.init();
    const [a, b] = await Promise.all([ca.getSecureContext('runtime.a.kiro.dev'), ca.getSecureContext('runtime.a.kiro.dev')]);
    assert.equal(a, b);
    await assert.rejects(ca.getSecureContext('x y'), /invalid host/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UI script is syntactically valid JavaScript and avoids innerHTML', () => {
  assert.doesNotThrow(() => new vm.Script(ui.js));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(ui.js));
  assert.match(ui.html, /\/proxy\/ui\.js/);
  assert.ok(!/<script>[^<]/.test(ui.html), 'no inline script allowed under the CSP');
});

test('UI table area is a fixed 8-row viewport that scrolls vertically and keeps its scroll position', () => {
  assert.match(ui.html, /id="tablewrap"/);
  assert.match(ui.css, /--visible-rows:8/);
  assert.match(ui.css, /\.table-wrap\{[^}]*height:calc\(var\(--row-h\) \* \(var\(--visible-rows\) \+ 1\)/);
  assert.match(ui.css, /\.table-wrap\{[^}]*overflow-y:auto/);
  assert.match(ui.css, /thead th\{position:sticky;top:0/);
  assert.match(ui.js, /\.reverse\(\)/, 'rows are shown oldest first, newest last');
  assert.match(ui.js, /wasAtBottom/, 'follows new rows only while the user is at the bottom');
  assert.match(ui.js, /scrollTop : scrollTop|: scrollTop;/, 'otherwise the scroll position is restored on auto-refresh');
  assert.match(ui.js, /fitTableHeight/, 'horizontal scrollbar thickness must be compensated');
  assert.match(ui.html, /<option selected>100<\/option>/, 'loads more than 8 rows so the scrollbar is meaningful');
  assert.match(ui.html, /<input type="checkbox" id="tunnels" checked> show tunnels/, 'tunnels filter is on by default');
  assert.match(ui.html, /<input type="checkbox" id="telemetry"> show telemetry/, 'telemetry filter exists and is off by default');
  assert.match(ui.js, /var COLS = \['id', 'time', 'category', 'host'/, 'the table has a category column');
  assert.match(ui.js, /cell\(tr, r\.category\)/, 'and fills it from the row');
  assert.match(ui.js, /'&telemetry=' \+ \(\$\('telemetry'\)\.checked/, 'the filter is sent to the API');
});
