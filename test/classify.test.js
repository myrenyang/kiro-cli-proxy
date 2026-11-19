'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRequest, CATEGORIES } = require('../src/classify');

// Every host/operation seen in real kiro-cli 2.x traffic.
const OBSERVED = [
  [{ kind: 'mitm', host: 'runtime.eu-central-1.kiro.dev', operation: 'GenerateAssistantResponse' }, 'chat'],
  [{ kind: 'tunnel', host: 'telemetry.eu-central-1.kiro.dev' }, 'telemetry'],
  [{ kind: 'tunnel', host: 'client-telemetry.us-east-1.amazonaws.com' }, 'telemetry'],
  [{ kind: 'tunnel', host: 'management.eu-central-1.kiro.dev' }, 'management'],
  [{ kind: 'tunnel', host: 'cognito-identity.us-east-1.amazonaws.com' }, 'auth'],
  [{ kind: 'tunnel', host: 'q.eu-central-1.amazonaws.com' }, 'telemetry'],
  [{ kind: 'tunnel', host: 'mcp-registry.example.internal' }, 'mcp'],
  [{ kind: 'tunnel', host: 'prod.download.cli.kiro.dev' }, 'update'],
];

test('classifies every observed host', () => {
  for (const [input, expected] of OBSERVED) assert.equal(classifyRequest(input), expected, JSON.stringify(input));
});

test('the runtime host is chat for the chat operation and for blind tunnels, api for other operations', () => {
  const host = 'runtime.us-east-1.kiro.dev';
  assert.equal(classifyRequest({ kind: 'mitm', host, operation: 'GenerateAssistantResponse' }), 'chat');
  assert.equal(classifyRequest({ kind: 'tunnel', host }), 'chat');
  assert.equal(classifyRequest({ kind: 'mitm', host, operation: 'ListAvailableModels' }), 'api');
  assert.equal(classifyRequest({ kind: 'mitm', host }), 'api');
});

test('telemetry wins over every other rule, whatever the kind', () => {
  assert.equal(classifyRequest({ kind: 'mitm', host: 'runtime-telemetry.example.com', operation: 'GenerateAssistantResponse' }), 'telemetry');
  assert.equal(classifyRequest({ kind: 'mitm', host: 'TELEMETRY.EU-CENTRAL-1.KIRO.DEV' }), 'telemetry');
});

test('lookalike hosts do not get a specific category', () => {
  assert.equal(classifyRequest({ kind: 'mitm', host: 'runtime.eu-central-1.kiro.dev.evil.com', operation: 'GenerateAssistantResponse' }), 'other');
  assert.equal(classifyRequest({ kind: 'tunnel', host: 'evil-runtime.eu-central-1.kiro.dev' }), 'other');
  assert.equal(classifyRequest({ kind: 'tunnel', host: 'example.com' }), 'other');
  assert.equal(classifyRequest({ kind: 'tunnel', host: 'myq.eu-central-1.amazonaws.com' }), 'other');
});

test('missing or odd input falls back to other and never throws', () => {
  assert.equal(classifyRequest(), 'other');
  assert.equal(classifyRequest({}), 'other');
  assert.equal(classifyRequest({ host: null }), 'other');
});

test('every category the classifier can return is declared in CATEGORIES', () => {
  const produced = new Set([...OBSERVED.map(([, t]) => t), 'other', 'api']);
  for (const t of produced) assert.ok(CATEGORIES.includes(t), t);
  assert.equal(new Set(CATEGORIES).size, CATEGORIES.length);
});
