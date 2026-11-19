'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { operationName, extractRequest, extractResponse } = require('../src/extract');
const { decodeBody, errorKind } = require('../src/view');
const { eventFrame } = require('./helpers');

const cfg = { fieldMaxLength: 20 };

const requestBody = Buffer.from(JSON.stringify({
  conversationState: {
    conversationId: 'conv-1',
    history: [{ userInputMessage: { content: 'old' } }, { userInputMessage: { content: 'older' } }],
    currentMessage: {
      userInputMessage: {
        content: 'x'.repeat(50),
        modelId: 'auto',
        userInputMessageContext: {
          envState: { operatingSystem: 'linux', currentWorkingDirectory: '/home/me/proj' },
          tools: [{}, {}, {}],
        },
      },
    },
  },
  profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC',
}));

test('operationName uses the part after the last dot of x-amz-target', () => {
  assert.equal(operationName({ 'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse' }), 'GenerateAssistantResponse');
  assert.equal(operationName({ 'x-amz-target': 'Plain' }), 'Plain');
  assert.equal(operationName({}), null);
  assert.equal(operationName(undefined), null);
});

test('extracts GenerateAssistantResponse request fields', () => {
  const f = extractRequest('GenerateAssistantResponse', requestBody, cfg);
  assert.equal(f.conversation_id, 'conv-1');
  assert.equal(f.model_id, 'auto');
  assert.equal(f.history_count, 2);
  assert.equal(f.tools_count, 3);
  assert.equal(f.cwd, '/home/me/proj');
  assert.equal(f.last_user_message, 'x'.repeat(20)); // truncated to fieldMaxLength
  assert.ok(!JSON.stringify(f).includes('123456789012'), 'profileArn must not be copied into a column');
});

test('request extraction is empty for unknown operations, bad JSON and empty bodies', () => {
  assert.deepEqual(extractRequest('Other', requestBody, cfg), {});
  assert.deepEqual(extractRequest('GenerateAssistantResponse', Buffer.from('{not json'), cfg), {});
  assert.deepEqual(extractRequest('GenerateAssistantResponse', Buffer.alloc(0), cfg), {});
});

test('extracts assembled text, event counts, usage and metering from the response', () => {
  const body = Buffer.concat([
    eventFrame('initial-response', { conversationId: '' }),
    eventFrame('assistantResponseEvent', { content: 'H' }),
    eventFrame('assistantResponseEvent', { content: 'i!' }),
    eventFrame('contextUsageEvent', { contextUsagePercentage: 1.5 }),
    eventFrame('meteringEvent', { unit: 'credit', usage: 0.01 }),
  ]);
  const f = extractResponse('GenerateAssistantResponse', body, cfg);
  assert.equal(f.res_text, 'Hi!');
  assert.deepEqual(JSON.parse(f.res_events), { 'initial-response': 1, assistantResponseEvent: 2, contextUsageEvent: 1, meteringEvent: 1 });
  assert.deepEqual(JSON.parse(f.context_usage), { contextUsagePercentage: 1.5 });
  assert.deepEqual(JSON.parse(f.metering), { unit: 'credit', usage: 0.01 });
});

test('response extraction survives a body truncated mid-frame', () => {
  const full = Buffer.concat([eventFrame('assistantResponseEvent', { content: 'ab' }), eventFrame('assistantResponseEvent', { content: 'cd' })]);
  const f = extractResponse('GenerateAssistantResponse', full.subarray(0, full.length - 3), cfg);
  assert.equal(f.res_text, 'ab');
});

test('errorKind: only a reset on an established tunnel is a routine reset', () => {
  assert.equal(errorKind({ kind: 'tunnel', status: 200, error: 'ECONNRESET' }), 'reset');
  assert.equal(errorKind({ kind: 'tunnel', status: 200, error: 'EPIPE' }), 'reset');
  assert.equal(errorKind({ kind: 'tunnel', status: 502, error: 'ECONNRESET' }), 'error', 'never connected');
  assert.equal(errorKind({ kind: 'tunnel', status: 200, error: 'ETIMEDOUT' }), 'error');
  assert.equal(errorKind({ kind: 'mitm', status: 200, error: 'ECONNRESET' }), 'error', 'decrypted traffic keeps its error');
  assert.equal(errorKind({ kind: 'tunnel', status: 200, error: null }), null);
  assert.equal(errorKind(null), null);
});

test('decodeBody: json, text, empty, binary', () => {
  assert.equal(decodeBody(null).format, 'empty');
  assert.deepEqual(decodeBody(Buffer.from('{"a":1}')), { format: 'json', data: { a: 1 }, note: undefined });
  assert.equal(decodeBody(Buffer.from('hello world')).format, 'text');
  const bin = decodeBody(Buffer.from([0, 1, 2, 3, 0, 0, 255]));
  assert.equal(bin.format, 'binary');
  assert.equal(bin.data.bytes, 7);
  assert.equal(bin.data.hexPreview, '000102030000ff');
});

test('decodeBody: event-stream yields assistant text and events', () => {
  const body = Buffer.concat([eventFrame('assistantResponseEvent', { content: 'Hel' }), eventFrame('assistantResponseEvent', { content: 'lo' })]);
  const out = decodeBody(body, { contentType: 'application/vnd.amazon.eventstream' });
  assert.equal(out.format, 'eventstream');
  assert.equal(out.data.text, 'Hello');
  assert.equal(out.data.events.length, 2);
});

test('decodeBody: gunzips and reports truncation', () => {
  const gz = zlib.gzipSync(Buffer.from('{"ok":true}'));
  const out = decodeBody(gz, { contentEncoding: 'gzip', truncated: true });
  assert.equal(out.format, 'json');
  assert.deepEqual(out.data, { ok: true });
  assert.match(out.note, /truncated/);
  assert.match(out.note, /decompressed gzip/);
});

test('decodeBody: broken gzip falls back instead of throwing', () => {
  const out = decodeBody(Buffer.from('definitely not gzip'), { contentEncoding: 'gzip' });
  assert.ok(['text', 'binary'].includes(out.format));
  assert.match(out.note, /could not decompress/);
});
