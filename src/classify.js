'use strict';

// Classifies a transaction into a coarse request category. The category is
// computed once, when a row is written (and once more for rows that predate
// the column), stored in the `category` column and indexed, so filters never
// need to pattern match on host names at query time.
//
// `kind` (mitm / tunnel) says how the traffic was captured; `category` says
// what it was for.
//
// Categories, with the hosts observed from kiro-cli 2.x:
//   chat        the conversation itself: runtime.*.kiro.dev GenerateAssistantResponse
//   telemetry   usage metrics and telemetry events: telemetry.*.kiro.dev,
//               client-telemetry.*.amazonaws.com, q.*.amazonaws.com (SendTelemetryEvent)
//   auth        credentials: cognito-identity.*.amazonaws.com
//   management  management.*.kiro.dev
//   api         other non-chat runtime.*.kiro.dev operations
//   mcp         MCP registry lookups (host starts with "mcp")
//   update      CLI update checks and downloads (*.download.cli.kiro.dev)
//   other       anything else

const CATEGORIES = ['chat', 'telemetry', 'auth', 'management', 'api', 'mcp', 'update', 'other'];

const CHAT_OPERATION = 'GenerateAssistantResponse';

function classifyRequest({ kind, host, operation } = {}) {
  const h = String(host || '').toLowerCase();

  if (h.includes('telemetry')) return 'telemetry';

  if (/^runtime\.[a-z0-9-]+\.kiro\.dev$/.test(h)) {
    // A blind tunnel to the runtime host cannot show the operation, but it is the chat service.
    if (kind === 'tunnel' || operation === CHAT_OPERATION) return 'chat';
    return 'api';
  }
  if (/^management\.[a-z0-9-]+\.kiro\.dev$/.test(h)) return 'management';
  if (/^cognito-/.test(h) || /^(oidc|sso)\./.test(h)) return 'auth';
  if (/^q\.[a-z0-9-]+\.amazonaws\.com$/.test(h)) return 'telemetry';
  if (/^mcp[-.]/.test(h)) return 'mcp';
  if (/download\.cli\.kiro\.dev$/.test(h)) return 'update';
  return 'other';
}

module.exports = { classifyRequest, CATEGORIES };
