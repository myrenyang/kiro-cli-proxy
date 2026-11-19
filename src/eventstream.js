'use strict';

// Decoder for the AWS event-stream binary framing
// (Content-Type: application/vnd.amazon.eventstream).
//
// Frame layout (big endian):
//   total length (4) | headers length (4) | prelude CRC32 (4)
//   headers (headers length bytes) | payload | message CRC32 (4)
//
// The decoder is deliberately forgiving: it returns every complete, valid
// frame it can read and stops at the first malformed or truncated one, so a
// body that was cut by the capture cap still yields its leading events.

const zlib = require('node:zlib');

const PRELUDE = 12;
const MIN_FRAME = PRELUDE + 4;
const MAX_FRAME = 16 * 1024 * 1024; // AWS caps an event-stream message at 16 MB

function readHeaders(buf) {
  const headers = {};
  let o = 0;
  while (o < buf.length) {
    const nameLen = buf[o++];
    const name = buf.toString('utf8', o, o + nameLen);
    o += nameLen;
    const type = buf[o++];
    let value;
    switch (type) {
      case 0: value = true; break;
      case 1: value = false; break;
      case 2: value = buf.readInt8(o); o += 1; break;
      case 3: value = buf.readInt16BE(o); o += 2; break;
      case 4: value = buf.readInt32BE(o); o += 4; break;
      case 5: value = buf.readBigInt64BE(o).toString(); o += 8; break;
      case 6: { const l = buf.readUInt16BE(o); o += 2; value = buf.subarray(o, o + l).toString('base64'); o += l; break; }
      case 7: { const l = buf.readUInt16BE(o); o += 2; value = buf.toString('utf8', o, o + l); o += l; break; }
      case 8: value = buf.readBigInt64BE(o).toString(); o += 8; break;
      case 9: value = buf.subarray(o, o + 16).toString('hex'); o += 16; break;
      default: throw new Error(`unknown header type ${type}`);
    }
    headers[name] = value;
  }
  return headers;
}

// Returns { frames: [{ headers, payload: Buffer }], consumed, error? }.
function decodeFrames(buf) {
  const frames = [];
  let o = 0;
  let error = null;
  while (o + MIN_FRAME <= buf.length) {
    const total = buf.readUInt32BE(o);
    const headersLen = buf.readUInt32BE(o + 4);
    if (total < MIN_FRAME || total > MAX_FRAME || headersLen > total - MIN_FRAME) { error = 'invalid frame lengths'; break; }
    if (o + total > buf.length) break; // incomplete trailing frame
    if (zlib.crc32(buf.subarray(o, o + 8)) !== buf.readUInt32BE(o + 8)) { error = 'prelude CRC mismatch'; break; }
    if (zlib.crc32(buf.subarray(o, o + total - 4)) !== buf.readUInt32BE(o + total - 4)) { error = 'message CRC mismatch'; break; }
    try {
      const headers = readHeaders(buf.subarray(o + PRELUDE, o + PRELUDE + headersLen));
      const payload = buf.subarray(o + PRELUDE + headersLen, o + total - 4);
      frames.push({ headers, payload });
    } catch (e) {
      error = e.message;
      break;
    }
    o += total;
  }
  return { frames, consumed: o, error };
}

function parsePayload(payload) {
  const text = payload.toString('utf8');
  try { return JSON.parse(text); } catch { return text; }
}

// Convenience view used by the extractor and the UI.
function decodeEvents(buf) {
  const { frames, error } = decodeFrames(buf);
  const events = frames.map(f => ({
    type: f.headers[':event-type'] || f.headers[':exception-type'] || f.headers[':message-type'] || 'unknown',
    messageType: f.headers[':message-type'] || null,
    payload: parsePayload(f.payload),
  }));
  return { events, error };
}

module.exports = { decodeFrames, decodeEvents };
