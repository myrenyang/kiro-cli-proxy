'use strict';

const { decodeEvents } = require('./eventstream');

// Per-operation extractors, dispatched on the x-amz-target header
// (e.g. "AmazonCodeWhispererStreamingService.GenerateAssistantResponse").
// An extractor never throws: a body it cannot understand yields null fields.

function operationName(headers) {
  const target = headers && headers['x-amz-target'];
  if (!target || typeof target !== 'string') return null;
  const i = target.lastIndexOf('.');
  return i >= 0 ? target.slice(i + 1) : target;
}

function truncate(value, max) {
  if (typeof value !== 'string') return null;
  return value.length > max ? value.slice(0, max) : value;
}

function parseJson(buf) {
  if (!buf || buf.length === 0) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

const generateAssistantResponse = {
  request(buf, cfg) {
    const body = parseJson(buf);
    const state = body && body.conversationState;
    if (!state || typeof state !== 'object') return {};
    const current = state.currentMessage && state.currentMessage.userInputMessage;
    const ctx = current && current.userInputMessageContext;
    return {
      conversation_id: typeof state.conversationId === 'string' ? state.conversationId : null,
      model_id: current && typeof current.modelId === 'string' ? current.modelId : null,
      history_count: Array.isArray(state.history) ? state.history.length : null,
      tools_count: ctx && Array.isArray(ctx.tools) ? ctx.tools.length : null,
      cwd: ctx && ctx.envState && typeof ctx.envState.currentWorkingDirectory === 'string'
        ? ctx.envState.currentWorkingDirectory : null,
      last_user_message: current ? truncate(current.content, cfg.fieldMaxLength) : null,
    };
  },

  response(buf, cfg) {
    if (!buf || buf.length === 0) return {};
    const { events } = decodeEvents(buf);
    if (events.length === 0) return {};
    const counts = {};
    let text = '';
    let contextUsage = null;
    const metering = [];
    for (const e of events) {
      counts[e.type] = (counts[e.type] || 0) + 1;
      if (e.type === 'assistantResponseEvent' && e.payload && typeof e.payload.content === 'string') text += e.payload.content;
      else if (e.type === 'contextUsageEvent') contextUsage = e.payload;
      else if (e.type === 'meteringEvent') metering.push(e.payload);
    }
    return {
      res_text: text ? truncate(text, Math.max(cfg.fieldMaxLength, 100000)) : null,
      res_events: JSON.stringify(counts),
      context_usage: contextUsage === null ? null : JSON.stringify(contextUsage),
      metering: metering.length === 0 ? null : JSON.stringify(metering.length === 1 ? metering[0] : metering),
    };
  },
};

const EXTRACTORS = {
  GenerateAssistantResponse: generateAssistantResponse,
};

function extractRequest(operation, buf, cfg) {
  const x = EXTRACTORS[operation];
  if (!x) return {};
  try { return x.request(buf, cfg); } catch { return {}; }
}

function extractResponse(operation, buf, cfg) {
  const x = EXTRACTORS[operation];
  if (!x) return {};
  try { return x.response(buf, cfg); } catch { return {}; }
}

module.exports = { operationName, extractRequest, extractResponse };
