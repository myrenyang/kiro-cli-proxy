'use strict';

const REDACTED = '[REDACTED]';

// Header names that always carry credentials, plus any name containing one of
// the fragments below (token, secret, cookie, ...).
const EXACT = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-amz-security-token',
  'x-amz-credential',
]);
const FRAGMENTS = ['token', 'secret', 'password', 'cookie', 'api-key', 'apikey'];

function isSensitiveHeader(name) {
  const n = String(name).toLowerCase();
  return EXACT.has(n) || FRAGMENTS.some(f => n.includes(f));
}

// Returns a plain object copy of the headers with sensitive values replaced.
function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = isSensitiveHeader(k) ? REDACTED : v;
  }
  return out;
}

module.exports = { redactHeaders, isSensitiveHeader, REDACTED };
