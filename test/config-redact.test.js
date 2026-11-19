'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redactHeaders, REDACTED } = require('../src/redact');
const { loadConfig, isTunnelHost, shouldDecrypt, parseArgs, DEFAULTS, CONFIG_FILE } = require('../src/config');

// Load with no config file (built-in defaults) unless one is provided, so tests do not depend on
// the committed config.json. `argv` and `file` (object written to a temp config.json) are optional.
let tmpDir;
function cfg({ argv = [], file } = {}) {
  let configFile = path.join(os.tmpdir(), 'kcp-nonexistent-config-' + process.pid + '.json');
  if (file !== undefined) {
    tmpDir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'kcp-cfg-'));
    configFile = path.join(tmpDir, `c-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(configFile, JSON.stringify(file));
  }
  return loadConfig({ argv, configFile });
}

test.after(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

const DEFAULT_TUNNELS = DEFAULTS.tunnelHosts.join(',');

test('redacts credential headers and keeps the rest', () => {
  const out = redactHeaders({
    authorization: 'Bearer abc',
    'x-amz-security-token': 'tok',
    cookie: 'a=b',
    'set-cookie': ['a=b'],
    'x-custom-token': 'zzz',
    'content-type': 'application/json',
    'x-amzn-requestid': 'id-1',
  });
  assert.equal(out.authorization, REDACTED);
  assert.equal(out['x-amz-security-token'], REDACTED);
  assert.equal(out.cookie, REDACTED);
  assert.equal(out['set-cookie'], REDACTED);
  assert.equal(out['x-custom-token'], REDACTED);
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out['x-amzn-requestid'], 'id-1');
});

test('redactHeaders tolerates missing input and does not mutate', () => {
  assert.deepEqual(redactHeaders(undefined), {});
  const input = { authorization: 'x' };
  redactHeaders(input);
  assert.equal(input.authorization, 'x');
});

test('built-in defaults apply when there is no config file and no flags', () => {
  const c = cfg();
  assert.equal(c.port, 8901);
  assert.equal(c.listenHost, '127.0.0.1');
  assert.equal(c.logFullBodies, true);
  assert.equal(c.bodyCapKilobytes, 1000);
  assert.equal(c.bodyCapBytes, 1000 * 1024);
  assert.equal(c.retentionDays, 7);
  assert.equal(c.retentionCount, 100);
  assert.equal(c.fieldMaxLength, 1000);
  assert.equal(c.tunnelHostsRaw, DEFAULT_TUNNELS);
});

test('the committed config.json is valid and loads', () => {
  assert.ok(fs.existsSync(CONFIG_FILE), 'config.json is committed in the repo root');
  const c = loadConfig({ argv: [], configFile: CONFIG_FILE });
  assert.equal(c.port, 8901);
  assert.ok(Array.isArray(c.tunnelHosts) && c.tunnelHosts.length > 0);
});

test('auto-fallback config: on by default with a 24 h sliding expiry, and validated', () => {
  const c = cfg();
  assert.equal(c.learnTunnels, true);
  assert.equal(c.learnedTunnelTtlHours, 24);
  assert.equal(c.learnedTunnelTtlMs, 24 * 3600 * 1000);
  const off = cfg({ argv: ['--learn-tunnels=false', '--learned-tunnel-ttl-hours=2'] });
  assert.equal(off.learnTunnels, false);
  assert.equal(off.learnedTunnelTtlMs, 2 * 3600 * 1000);
  assert.throws(() => cfg({ argv: ['--learned-tunnel-ttl-hours=0'] }), /learnedTunnelTtlHours/);
  assert.throws(() => cfg({ argv: ['--learn-tunnels=sometimes'] }), /learnTunnels/);
});

test('precedence: CLI flags override config.json, which overrides built-in defaults', () => {
  // config.json sets 9000 and false; the flag wins for the port only.
  const c = cfg({ file: { proxyPort: 9000, logFullBodies: false }, argv: ['--proxy-port=9100'] });
  assert.equal(c.port, 9100, 'flag beats file');
  assert.equal(c.logFullBodies, false, 'file beats default');
  assert.equal(c.retentionDays, 7, 'default fills the rest');
});

test('flags accept --key=value and --key value, with kebab-case names mapping to camelCase', () => {
  assert.deepEqual(parseArgs(['--proxy-port=9000']), { proxyPort: '9000' });
  assert.deepEqual(parseArgs(['--proxy-port', '9000']), { proxyPort: '9000' });
  assert.deepEqual(parseArgs(['--log-full-bodies=false', '--retention-count', '5']), { logFullBodies: 'false', retentionCount: '5' });
  const c = cfg({ argv: ['--proxy-port', '9000', '--body-cap-kilobytes=0', '--log-full-bodies=false'] });
  assert.equal(c.port, 9000);
  assert.equal(c.bodyCapBytes, 0, '0 means unlimited');
  assert.equal(c.logFullBodies, false);
});

test('tunnelHosts is a JSON array in the file and a comma list on the command line', () => {
  const fromFile = cfg({ file: { tunnelHosts: ['a.example.com', '*.b.example.com'] } });
  assert.ok(isTunnelHost(fromFile, 'a.example.com'));
  assert.ok(isTunnelHost(fromFile, 'x.b.example.com'));
  assert.ok(!isTunnelHost(fromFile, 'oidc.us-east-1.amazonaws.com'), 'file list replaces the default');
  const fromCli = cfg({ argv: ['--tunnel-hosts=a.example.com, *.b.example.com'] });
  assert.ok(isTunnelHost(fromCli, 'x.b.example.com'));
});

test('invalid values are rejected with the camelCase key and the source in the message', () => {
  assert.throws(() => cfg({ argv: ['--proxy-port=abc'] }), /proxyPort.*command line/);
  assert.throws(() => cfg({ argv: ['--body-cap-kilobytes=-1'] }), /bodyCapKilobytes/);
  assert.throws(() => cfg({ argv: ['--log-full-bodies=maybe'] }), /logFullBodies/);
  assert.throws(() => cfg({ argv: ['--log-level=loud'] }), /logLevel.*one of/);
  assert.throws(() => cfg({ argv: ['--proxy-port=70000'] }), /proxyPort.*<= 65535/);
  assert.throws(() => cfg({ file: { proxyPort: 'abc' } }), /proxyPort.*config|proxyPort.*c-/);
});

test('unknown flags and malformed argv are rejected', () => {
  assert.throws(() => parseArgs(['--nope=1']), /unknown option --nope/);
  assert.throws(() => parseArgs(['port=8901']), /expected --some-option/);
  assert.throws(() => parseArgs(['--proxy-port']), /needs a value/);
});

test('an unknown key in config.json is rejected', () => {
  assert.throws(() => cfg({ file: { proxyPort: 8901, bogusSetting: true } }), /unknown setting\(s\): bogusSetting/);
});

test('the tunnel list matches one label per wildcard, case-insensitively', () => {
  const c = cfg({ argv: ['--tunnel-hosts=runtime.*.kiro.dev,*.*.auth.desktop.kiro.dev'] });
  assert.ok(isTunnelHost(c, 'runtime.eu-central-1.kiro.dev'));
  assert.ok(isTunnelHost(c, 'RUNTIME.us-east-1.kiro.dev'));
  assert.ok(isTunnelHost(c, 'prod.us-east-1.auth.desktop.kiro.dev'));
  assert.ok(!isTunnelHost(c, 'runtime.a.b.kiro.dev'));
  assert.ok(!isTunnelHost(c, 'xruntime.eu-central-1.kiro.dev'));
  assert.ok(!isTunnelHost(c, 'runtime.eu-central-1.kiro.dev.evil.com'));
  assert.ok(!isTunnelHost(c, 'runtimeXeu-central-1.kiro.dev'));
  assert.ok(!isTunnelHost(c, 'us-east-1.auth.desktop.kiro.dev'));
});

test('by default everything is decrypted except the credential and token endpoints', () => {
  const c = cfg();
  for (const h of ['cognito-identity.us-east-1.amazonaws.com', 'cognito-identity-fips.us-east-1.amazonaws.com',
    'oidc.us-east-1.amazonaws.com', 'oidc.eu-central-1.amazonaws.com', 'sts.amazonaws.com', 'sts.eu-central-1.amazonaws.com',
    'prod.us-east-1.auth.desktop.kiro.dev']) {
    assert.ok(!shouldDecrypt(c, h, 443), `${h} must stay encrypted`);
  }
  for (const h of ['runtime.eu-central-1.kiro.dev', 'management.eu-central-1.kiro.dev', 'q.eu-central-1.amazonaws.com',
    'telemetry.eu-central-1.kiro.dev', 'client-telemetry.us-east-1.amazonaws.com', 'prod.download.cli.kiro.dev',
    'mcp-registry.example.internal', 'example.com', 'api.github.com']) {
    assert.ok(shouldDecrypt(c, h, 443), `${h} should be decrypted`);
  }
});

test('lookalike hosts are not mistaken for tunnel-listed credential endpoints', () => {
  const c = cfg();
  assert.ok(shouldDecrypt(c, 'oidc.us-east-1.amazonaws.com.evil.com', 443));
  assert.ok(shouldDecrypt(c, 'xoidc.us-east-1.amazonaws.com', 443));
  assert.ok(shouldDecrypt(c, 'sts.a.b.amazonaws.com', 443));
});

test('only HTTPS on port 443 and real DNS names are ever decrypted', () => {
  const c = cfg({ argv: ['--tunnel-hosts='] });
  assert.ok(shouldDecrypt(c, 'example.com', 443));
  assert.ok(!shouldDecrypt(c, 'example.com', 8443), 'other ports are tunnelled');
  assert.ok(!shouldDecrypt(c, 'example.com', 80));
  assert.ok(!shouldDecrypt(c, '127.0.0.1', 443), 'no certificate can be issued for an IPv4 address');
  assert.ok(!shouldDecrypt(c, '::1', 443));
  assert.ok(!shouldDecrypt(c, '[2001:db8::1]', 443));
});

test('an empty tunnelHosts tunnels nothing (decrypts literally everything)', () => {
  const none = cfg({ argv: ['--tunnel-hosts='] });
  assert.deepEqual(none.tunnelHosts, []);
  assert.ok(shouldDecrypt(none, 'cognito-identity.us-east-1.amazonaws.com', 443));
});

test('the old MITM_HOSTS env var is rejected with an explanation', () => {
  assert.throws(() => loadConfig({ argv: [], configFile: 'nope.json', env: { MITM_HOSTS: 'runtime.*.kiro.dev' } }), /MITM_HOSTS is no longer used.*tunnelHosts/);
});
