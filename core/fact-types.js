const { validateInteractionOutcome } = require('./interaction-outcome');

const FACT_TYPES = Object.freeze([
  'started',
  'assistant_text',
  'reasoning',
  'tool_invoked',
  'tool_result',
  'interaction_pending',
  'interaction_resolved',
  'usage_reported',
  'backend_status',
  'backend_error',
  'process_exited',
  'stream_closed',
]);

const FACT_TYPES_SET = new Set(FACT_TYPES);

function validateFact(fact) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    throw new Error(`Fact must be a non-null object, got ${typeof fact}`);
  }
  const type = fact.type;
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error(`Fact must have a non-empty string field "type", got ${typeof type}`);
  }
  if (!FACT_TYPES_SET.has(type)) {
    throw new Error(
      `Unknown fact type "${type}". Allowed types: ${[...FACT_TYPES_SET].sort().join(', ')}`
    );
  }

  switch (type) {
    case 'started':
      if (fact.backend_pid !== undefined && fact.backend_pid !== null && typeof fact.backend_pid !== 'number')
        throw new Error('started.backend_pid must be a number, null, or undefined');
      if (fact.backend_session_id !== undefined && fact.backend_session_id !== null && typeof fact.backend_session_id !== 'string')
        throw new Error('started.backend_session_id must be a string, null, or undefined');
      break;

    case 'assistant_text':
      if (typeof fact.message_id !== 'string') throw new Error('assistant_text.message_id must be a string');
      if (typeof fact.text !== 'string') throw new Error('assistant_text.text must be a string');
      break;

    case 'reasoning':
      if (typeof fact.message_id !== 'string') throw new Error('reasoning.message_id must be a string');
      break;

    case 'tool_invoked':
      if (typeof fact.call_id !== 'string') throw new Error('tool_invoked.call_id must be a string');
      if (typeof fact.tool !== 'string') throw new Error('tool_invoked.tool must be a string');
      if (typeof fact.summary !== 'string') throw new Error('tool_invoked.summary must be a string');
      break;

    case 'tool_result':
      if (typeof fact.call_id !== 'string') throw new Error('tool_result.call_id must be a string');
      if (typeof fact.ok !== 'boolean') throw new Error('tool_result.ok must be a boolean');
      if (typeof fact.summary !== 'string') throw new Error('tool_result.summary must be a string');
      break;

    case 'interaction_pending':
      if (typeof fact.interaction_id !== 'string') throw new Error('interaction_pending.interaction_id must be a string');
      if (!['permission', 'question'].includes(fact.kind))
        throw new Error(`interaction_pending.kind must be "permission" or "question", got "${fact.kind}"`);
      if (typeof fact.detail !== 'string') throw new Error('interaction_pending.detail must be a string');
      break;

    case 'interaction_resolved':
      if (typeof fact.interaction_id !== 'string') throw new Error('interaction_resolved.interaction_id must be a string');
      validateInteractionOutcome(fact.outcome);
      break;

    case 'usage_reported':
      if (!fact.tokens || typeof fact.tokens !== 'object' || Array.isArray(fact.tokens))
        throw new Error('usage_reported.tokens must be an object');
      if (typeof fact.tokens.input !== 'number') throw new Error('usage_reported.tokens.input must be a number');
      if (typeof fact.tokens.output !== 'number') throw new Error('usage_reported.tokens.output must be a number');
      if (fact.tokens.total !== undefined && fact.tokens.total !== null && typeof fact.tokens.total !== 'number')
        throw new Error('usage_reported.tokens.total must be a number, null, or undefined');
      if (fact.cost !== undefined && fact.cost !== null && typeof fact.cost !== 'number')
        throw new Error('usage_reported.cost must be a number, null, or undefined');
      break;

    case 'backend_status':
      if (!['busy', 'idle', 'retrying'].includes(fact.state))
        throw new Error(`backend_status.state must be "busy", "idle", or "retrying", got "${fact.state}"`);
      break;

    case 'backend_error':
      if (fact.class_hint !== undefined && fact.class_hint !== null && typeof fact.class_hint !== 'string')
        throw new Error('backend_error.class_hint must be a string, null, or undefined');
      if (fact.structured_payload !== undefined && fact.structured_payload !== null && typeof fact.structured_payload !== 'object')
        throw new Error('backend_error.structured_payload must be an object, null, or undefined');
      break;

    case 'process_exited':
      if (typeof fact.code !== 'number') throw new Error('process_exited.code must be a number');
      break;

    case 'stream_closed':
      if (typeof fact.reason !== 'string') throw new Error('stream_closed.reason must be a string');
      break;
  }
}

function isKnownFactType(type) {
  return FACT_TYPES_SET.has(type);
}

module.exports = { FACT_TYPES, validateFact, isKnownFactType };
