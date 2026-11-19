'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeFrames, decodeEvents } = require('../src/eventstream');
const { eventFrame } = require('./helpers');

test('decodes consecutive frames with headers and JSON payloads', () => {
  const buf = Buffer.concat([
    eventFrame('initial-response', { conversationId: '' }),
    eventFrame('assistantResponseEvent', { content: 'Hi' }),
  ]);
  const { events, error } = decodeEvents(buf);
  assert.equal(error, null);
  assert.deepEqual(events.map(e => e.type), ['initial-response', 'assistantResponseEvent']);
  assert.deepEqual(events[1].payload, { content: 'Hi' });
  assert.equal(events[1].messageType, 'event');
});

test('returns plain text for non-JSON payloads', () => {
  const { events } = decodeEvents(eventFrame('x', 'not json'));
  assert.equal(events[0].payload, 'not json');
});

test('ignores an incomplete trailing frame without error', () => {
  const full = eventFrame('a', { n: 1 });
  const buf = Buffer.concat([full, full.subarray(0, full.length - 5)]);
  const { frames, consumed, error } = decodeFrames(buf);
  assert.equal(frames.length, 1);
  assert.equal(consumed, full.length);
  assert.equal(error, null);
});

test('stops at a frame with a corrupt message CRC and keeps earlier frames', () => {
  const good = eventFrame('a', { n: 1 });
  const bad = Buffer.from(eventFrame('b', { n: 2 }));
  bad[bad.length - 1] ^= 0xff;
  const { frames, error } = decodeFrames(Buffer.concat([good, bad]));
  assert.equal(frames.length, 1);
  assert.match(error, /message CRC/);
});

test('rejects a corrupt prelude CRC', () => {
  const bad = Buffer.from(eventFrame('a', { n: 1 }));
  bad[8] ^= 0xff;
  const { frames, error } = decodeFrames(bad);
  assert.equal(frames.length, 0);
  assert.match(error, /prelude CRC/);
});

test('empty and garbage input do not throw', () => {
  assert.deepEqual(decodeEvents(Buffer.alloc(0)).events, []);
  const { events, error } = decodeEvents(Buffer.from('this is definitely not an event stream'));
  assert.deepEqual(events, []);
  assert.ok(error);
});
