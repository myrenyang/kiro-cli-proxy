'use strict';

const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');

// Built-in defaults. config.json (committed in the repo root) normally supplies these; this
// object is the fallback when a key is missing from the file, and the single source of truth
// for the set of known settings and their types.
//
//   proxyPort              listen port, bound to 127.0.0.1 only
//   dbPath, certDir        paths, resolved relative to the repo root
//   systemCaFile           system roots copied into certs/bundle.pem
//   tunnelHosts            hosts left encrypted (array of patterns, "*" = one DNS label);
//                          EVERY other host on port 443 is decrypted
//   learnTunnels           on a client cert rejection, tunnel that host from then on
//   learnedTunnelTtlHours  how long a learned host stays tunnelled after its last use
//   logFullBodies          store request/response bodies
//   bodyCapKilobytes       per-body storage cap in KB (0 = unlimited)
//   retentionDays/Count    a row is deleted only if older than Days AND outside the newest Count
//   logLevel               debug | info | warn | error
//   logFieldMaxLength      truncation of last_user_message
const DEFAULTS = {
  proxyPort: 8901,
  dbPath: 'data.db',
  certDir: 'certs',
  systemCaFile: '/etc/ssl/certs/ca-certificates.crt',
  tunnelHosts: [
    'cognito-identity.*.amazonaws.com',
    'cognito-identity-fips.*.amazonaws.com',
    'oidc.*.amazonaws.com',
    'sts.amazonaws.com',
    'sts.*.amazonaws.com',
    '*.*.auth.desktop.kiro.dev',
  ],
  learnTunnels: true,
  learnedTunnelTtlHours: 24,
  logFullBodies: true,
  bodyCapKilobytes: 1000,
  retentionDays: 7,
  retentionCount: 100,
  logLevel: 'info',
  logFieldMaxLength: 1000,
};

// How each key is parsed from a string (CLI flags always arrive as strings) and validated.
const SPEC = {
  proxyPort: { type: 'int', min: 1, max: 65535 },
  dbPath: { type: 'string' },
  certDir: { type: 'string' },
  systemCaFile: { type: 'string' },
  tunnelHosts: { type: 'list' },
  learnTunnels: { type: 'bool' },
  learnedTunnelTtlHours: { type: 'int', min: 1 },
  logFullBodies: { type: 'bool' },
  bodyCapKilobytes: { type: 'int', min: 0 },
  retentionDays: { type: 'int', min: 0 },
  retentionCount: { type: 'int', min: 0 },
  logLevel: { type: 'enum', values: ['debug', 'info', 'warn', 'error'] },
  logFieldMaxLength: { type: 'int', min: 1 },
};

const KEBAB = Object.fromEntries(Object.keys(SPEC).map(k => [k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), k]));

function coerce(key, value, source) {
  const spec = SPEC[key];
  const where = `${key} (from ${source})`;
  switch (spec.type) {
    case 'string':
      return String(value);
    case 'int': {
      const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
      if (!Number.isInteger(n)) throw new Error(`${where} must be an integer, got "${value}"`);
      if (spec.min !== undefined && n < spec.min) throw new Error(`${where} must be >= ${spec.min}, got ${n}`);
      if (spec.max !== undefined && n > spec.max) throw new Error(`${where} must be <= ${spec.max}, got ${n}`);
      return n;
    }
    case 'bool': {
      if (typeof value === 'boolean') return value;
      if (/^(true|1|yes)$/i.test(value)) return true;
      if (/^(false|0|no)$/i.test(value)) return false;
      throw new Error(`${where} must be true or false, got "${value}"`);
    }
    case 'enum':
      if (!spec.values.includes(String(value))) throw new Error(`${where} must be one of ${spec.values.join(', ')}, got "${value}"`);
      return String(value);
    case 'list': {
      // From config.json: a JSON array. From a CLI flag: a comma separated string.
      const arr = Array.isArray(value) ? value : String(value).split(',');
      return arr.map(s => String(s).trim()).filter(Boolean);
    }
    default:
      throw new Error(`unknown spec type for ${key}`);
  }
}

function readConfigFile(file) {
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`could not parse ${file}: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  const unknown = Object.keys(parsed).filter(k => !(k in SPEC));
  if (unknown.length) throw new Error(`${file} has unknown setting(s): ${unknown.join(', ')}`);
  return parsed;
}

// Parse argv of the form --key=value or --key value into { key: rawString }, using the kebab names.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}" (expected --some-option=value)`);
    let flag = arg.slice(2);
    let value;
    const eq = flag.indexOf('=');
    if (eq >= 0) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    } else {
      value = argv[++i];
      if (value === undefined) throw new Error(`option --${flag} needs a value`);
    }
    const key = KEBAB[flag];
    if (!key) throw new Error(`unknown option --${flag}. Known options: ${Object.keys(KEBAB).map(k => '--' + k).join(', ')}`);
    out[key] = value;
  }
  return out;
}

// Precedence: built-in DEFAULTS, then config.json, then CLI flags (highest).
function loadConfig({ argv = [], configFile = CONFIG_FILE, env } = {}) {
  if (env && env.MITM_HOSTS !== undefined) {
    throw new Error('MITM_HOSTS is no longer used. Set "tunnelHosts" in config.json (hosts left encrypted; everything else is decrypted).');
  }
  const fileValues = readConfigFile(configFile);
  const cliValues = parseArgs(argv);

  const resolved = {};
  for (const key of Object.keys(SPEC)) {
    if (key in cliValues) resolved[key] = coerce(key, cliValues[key], 'command line');
    else if (key in fileValues) resolved[key] = coerce(key, fileValues[key], path.basename(configFile));
    else resolved[key] = coerce(key, DEFAULTS[key], 'built-in default');
  }

  const cfg = {
    root: ROOT,
    listenHost: '127.0.0.1',
    port: resolved.proxyPort,
    dbPath: path.resolve(ROOT, resolved.dbPath),
    certDir: path.resolve(ROOT, resolved.certDir),
    systemCaFile: resolved.systemCaFile,
    tunnelHostsRaw: resolved.tunnelHosts.join(','),
    learnTunnels: resolved.learnTunnels,
    learnedTunnelTtlHours: resolved.learnedTunnelTtlHours,
    logFullBodies: resolved.logFullBodies,
    bodyCapKilobytes: resolved.bodyCapKilobytes,
    retentionDays: resolved.retentionDays,
    retentionCount: resolved.retentionCount,
    logLevel: resolved.logLevel,
    fieldMaxLength: resolved.logFieldMaxLength,
  };
  cfg.bodyCapBytes = cfg.bodyCapKilobytes * 1024; // 0 means unlimited
  cfg.learnedTunnelTtlMs = cfg.learnedTunnelTtlHours * 3600 * 1000;
  cfg.tunnelHosts = parseHostPatterns(resolved.tunnelHosts);
  return cfg;
}

// Turn a host pattern such as "runtime.*.kiro.dev" into an anchored RegExp.
// "*" matches exactly one DNS label (letters, digits, hyphen).
function hostPatternToRegExp(pattern) {
  const escaped = pattern
    .toLowerCase()
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[a-z0-9-]+');
  return new RegExp(`^${escaped}$`);
}

function parseHostPatterns(list) {
  return list.map(p => ({ pattern: p, re: hostPatternToRegExp(p) }));
}

// True when `host` is on the blind-tunnel list.
function isTunnelHost(cfg, host) {
  const h = String(host).toLowerCase();
  return cfg.tunnelHosts.some(({ re }) => re.test(h));
}

// Decides whether a CONNECT is decrypted. Everything is, except:
//   - hosts on the tunnel list
//   - anything that is not port 443 (only HTTPS on the standard port is intercepted)
//   - bare IP addresses (no valid certificate can be issued for them)
function shouldDecrypt(cfg, host, port) {
  if (port !== 443) return false;
  if (net.isIP(String(host).replace(/^\[|\]$/g, ''))) return false;
  return !isTunnelHost(cfg, host);
}

// Config subset that is safe to expose on /proxy/health.
function publicConfig(cfg) {
  return {
    proxyPort: cfg.port,
    tunnelHosts: cfg.tunnelHosts.map(t => t.pattern),
    learnTunnels: cfg.learnTunnels,
    learnedTunnelTtlHours: cfg.learnedTunnelTtlHours,
    logFullBodies: cfg.logFullBodies,
    bodyCapKilobytes: cfg.bodyCapKilobytes,
    retentionDays: cfg.retentionDays,
    retentionCount: cfg.retentionCount,
    logLevel: cfg.logLevel,
    logFieldMaxLength: cfg.fieldMaxLength,
  };
}

module.exports = {
  loadConfig, isTunnelHost, shouldDecrypt, publicConfig, hostPatternToRegExp,
  parseArgs, DEFAULTS, SPEC, CONFIG_FILE, ROOT,
};
