'use strict';

const zlib = require('node:zlib');
const { decodeEvents } = require('./eventstream');

// Turns a stored raw body into something the UI can render.
// Returns { format, data, note? } where format is one of:
//   'empty' | 'json' | 'eventstream' | 'text' | 'binary'

const HEX_PREVIEW_BYTES = 512;

function decompress(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  // Z_SYNC_FLUSH lets a body that was cut by the capture cap still decode.
  const opts = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, opts);
  if (enc === 'deflate') return zlib.inflateSync(buf, opts);
  if (enc === 'br') return zlib.brotliDecompressSync(buf);
  return buf;
}

function looksLikeText(buf) {
  const sample = buf.subarray(0, 4096);
  let bad = 0;
  for (const b of sample) {
    if (b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13)) bad++;
  }
  return sample.length === 0 || bad / sample.length < 0.02;
}

function decodeBody(input, { contentType = '', contentEncoding = '', truncated = false } = {}) {
  if (!input || input.length === 0) return { format: 'empty', data: null };
  let buf = Buffer.from(input);
  const notes = [];
  const note = () => (notes.length ? notes.join('; ') : undefined);
  if (truncated) notes.push('body was truncated by the capture cap');

  try {
    const out = decompress(buf, contentEncoding);
    if (out !== buf) notes.push(`decompressed ${contentEncoding}`);
    buf = out;
  } catch (e) {
    notes.push(`could not decompress (${contentEncoding}): ${e.message}`);
  }

  const ct = String(contentType).toLowerCase();

  if (ct.includes('vnd.amazon.eventstream')) {
    const { events, error } = decodeEvents(buf);
    if (events.length > 0) {
      let text = '';
      for (const e of events) {
        if (e.type === 'assistantResponseEvent' && e.payload && typeof e.payload.content === 'string') text += e.payload.content;
      }
      if (error) notes.push(`event-stream stopped early: ${error}`);
      return { format: 'eventstream', data: { text, events }, note: note() };
    }
    if (error) notes.push(`event-stream decode failed: ${error}`);
  }

  if (looksLikeText(buf)) {
    const text = buf.toString('utf8');
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return { format: 'json', data: JSON.parse(text), note: note() }; } catch { /* fall through to text */ }
    }
    return { format: 'text', data: text, note: note() };
  }

  return {
    format: 'binary',
    data: { bytes: buf.length, hexPreview: buf.subarray(0, HEX_PREVIEW_BYTES).toString('hex') },
    note: note(),
  };
}

// Classifies a row's `error` for display. A TCP reset on a tunnel that was
// already established (status 200) is something the remote end does to a
// long-lived connection, e.g. a keep-alive race with the server's idle timeout.
// It is routine, so it is shown as 'reset' rather than 'error'. Everything else
// (failed connects, upstream or TLS failures on decrypted traffic, ...) is 'error'.
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE']);

function errorKind(row) {
  if (!row || !row.error) return null;
  if (row.kind === 'tunnel' && row.status === 200 && RESET_CODES.has(row.error)) return 'reset';
  return 'error';
}

module.exports = { decodeBody, errorKind };
