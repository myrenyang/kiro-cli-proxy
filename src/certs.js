'use strict';

// Certificate authority and leaf certificate generation.
//
// Node has no X.509 builder, so this shells out to the `openssl` CLI. It is
// always invoked through execFile with an argument array (never a shell), and
// hostnames are validated before they reach any argument or file name.

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');

const execFileP = promisify(execFile);

const CA_DAYS = 365;
const LEAF_DAYS = 30;
const LEAF_MIN_REMAINING_MS = 24 * 3600 * 1000;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

function openssl(args, opts = {}) {
  return execFileP('openssl', args, { timeout: 20000, ...opts });
}

async function checkOpenssl() {
  try {
    const { stdout } = await openssl(['version']);
    return stdout.trim();
  } catch (e) {
    throw new Error(`openssl CLI is required but could not be run: ${e.message}`);
  }
}

function isValidHost(host) {
  return typeof host === 'string' && HOST_RE.test(host) && !host.includes('..');
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function randomSuffix() {
  return `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

function createCertAuthority({ certDir, systemCaFile, log = () => {} }) {
  const caDir = path.join(certDir, 'ca');
  const caKeyPath = path.join(caDir, 'ca.key');
  const caCertPath = path.join(caDir, 'ca.pem');
  const bundlePath = path.join(certDir, 'bundle.pem');
  const leafRoot = path.join(certDir, 'leaf');

  const contexts = new Map();   // host -> tls.SecureContext
  const inflight = new Map();   // host -> Promise<tls.SecureContext>

  async function generateCa(tmp) {
    const key = path.join(tmp, 'ca.key');
    const cert = path.join(tmp, 'ca.pem');
    await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
    fs.chmodSync(key, 0o600);
    await openssl([
      'req', '-x509', '-new', '-key', key, '-sha256', '-days', String(CA_DAYS),
      '-subj', '/CN=kiro-cli-proxy local CA',
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-out', cert,
    ]);
  }

  // Create the CA atomically: build it in a private temp directory, then
  // rename the directory into place. If another process won the race, rename
  // fails and the winner's complete CA is used instead.
  async function ensureCa() {
    if (exists(caKeyPath) && exists(caCertPath)) return;
    if (exists(caDir)) throw new Error(`${caDir} exists but is incomplete; remove it to regenerate the CA`);
    fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
    const tmp = fs.mkdtempSync(path.join(certDir, '.ca-tmp-'));
    try {
      fs.chmodSync(tmp, 0o700);
      await generateCa(tmp);
      try {
        fs.renameSync(tmp, caDir);
        log('info', `created new root CA at ${caCertPath}`);
        return;
      } catch (e) {
        if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (!(exists(caKeyPath) && exists(caCertPath))) throw new Error('root CA creation raced and the winner is incomplete');
  }

  // bundle.pem = system roots + our CA. kiro-cli reads it through SSL_CERT_FILE,
  // which replaces (not extends) the default trust store.
  function writeBundle() {
    if (!exists(systemCaFile)) throw new Error(`system CA file not found: ${systemCaFile} (set SYSTEM_CA_FILE)`);
    const system = fs.readFileSync(systemCaFile, 'utf8');
    const ca = fs.readFileSync(caCertPath, 'utf8');
    const tmp = path.join(certDir, `.bundle-${randomSuffix()}.tmp`);
    fs.writeFileSync(tmp, `${system.trimEnd()}\n${ca.trimEnd()}\n`, { mode: 0o644 });
    fs.renameSync(tmp, bundlePath);
  }

  async function init() {
    const version = await checkOpenssl();
    await ensureCa();
    writeBundle();
    return { caCertPath, bundlePath, openssl: version };
  }

  function loadLeafFromDisk(host) {
    const dir = path.join(leafRoot, host);
    const keyFile = path.join(dir, 'leaf.key');
    const certFile = path.join(dir, 'leaf.pem');
    if (!(exists(keyFile) && exists(certFile))) return null;
    try {
      const certPem = fs.readFileSync(certFile, 'utf8');
      const x509 = new crypto.X509Certificate(certPem);
      const ca = new crypto.X509Certificate(fs.readFileSync(caCertPath));
      if (!x509.verify(ca.publicKey)) return null;
      if (new Date(x509.validTo).getTime() - Date.now() < LEAF_MIN_REMAINING_MS) return null;
      return { key: fs.readFileSync(keyFile, 'utf8'), cert: certPem };
    } catch {
      return null;
    }
  }

  async function generateLeaf(host) {
    fs.mkdirSync(leafRoot, { recursive: true, mode: 0o700 });
    const tmp = fs.mkdtempSync(path.join(leafRoot, '.tmp-'));
    try {
      const key = path.join(tmp, 'leaf.key');
      const csr = path.join(tmp, 'leaf.csr');
      const cert = path.join(tmp, 'leaf.pem');
      const ext = path.join(tmp, 'ext.cnf');
      fs.writeFileSync(ext, [
        `subjectAltName=DNS:${host}`,
        'extendedKeyUsage=serverAuth',
        'keyUsage=critical,digitalSignature',
        'basicConstraints=critical,CA:FALSE',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid',
        '',
      ].join('\n'));
      await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
      fs.chmodSync(key, 0o600);
      await openssl(['req', '-new', '-key', key, '-subj', `/CN=${host}`, '-out', csr]);
      await openssl([
        'x509', '-req', '-in', csr, '-CA', caCertPath, '-CAkey', caKeyPath,
        '-set_serial', `0x${crypto.randomBytes(16).toString('hex')}`,
        '-days', String(LEAF_DAYS), '-sha256', '-extfile', ext, '-out', cert,
      ]);
      const result = { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8') };

      // Persist so a restart does not regenerate; best effort only.
      const finalDir = path.join(leafRoot, host);
      try {
        fs.rmSync(finalDir, { recursive: true, force: true });
        fs.mkdirSync(finalDir, { mode: 0o700 });
        fs.copyFileSync(key, path.join(finalDir, 'leaf.key'));
        fs.chmodSync(path.join(finalDir, 'leaf.key'), 0o600);
        fs.copyFileSync(cert, path.join(finalDir, 'leaf.pem'));
      } catch (e) {
        log('warn', `could not persist leaf for ${host}: ${e.message}`);
      }
      return result;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Returns a ready tls.SecureContext for `host`, generating the leaf
  // certificate on first use. Concurrent calls for one host share one run.
  function getSecureContext(host) {
    const h = String(host).toLowerCase();
    if (!isValidHost(h)) return Promise.reject(new Error(`refusing to issue a certificate for invalid host "${host}"`));
    const cached = contexts.get(h);
    if (cached) return Promise.resolve(cached);
    let p = inflight.get(h);
    if (!p) {
      p = (async () => {
        const pair = loadLeafFromDisk(h) || await generateLeaf(h);
        const ctx = tls.createSecureContext({ key: pair.key, cert: pair.cert });
        contexts.set(h, ctx);
        return ctx;
      })().finally(() => inflight.delete(h));
      inflight.set(h, p);
    }
    return p;
  }

  return { init, getSecureContext, caCertPath, caKeyPath, bundlePath };
}

module.exports = { createCertAuthority, isValidHost, checkOpenssl };
