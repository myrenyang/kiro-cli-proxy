'use strict';

const zlib = require('node:zlib');

// Encode one AWS event-stream frame with string headers.
function encodeFrame(headers, payload) {
  const hdr = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name);
    const v = Buffer.from(String(value));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(v.length);
    hdr.push(Buffer.from([n.length]), n, Buffer.from([7]), len, v);
  }
  const headerBuf = Buffer.concat(hdr);
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const total = 12 + headerBuf.length + body.length + 4;
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(headerBuf.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(zlib.crc32(prelude));
  const head = Buffer.concat([prelude, preludeCrc, headerBuf, body]);
  const msgCrc = Buffer.alloc(4);
  msgCrc.writeUInt32BE(zlib.crc32(head));
  return Buffer.concat([head, msgCrc]);
}

function eventFrame(eventType, payload) {
  return encodeFrame({ ':event-type': eventType, ':content-type': 'application/json', ':message-type': 'event' }, payload);
}

module.exports = { encodeFrame, eventFrame };
