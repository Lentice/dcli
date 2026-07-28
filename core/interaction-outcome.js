const InteractionOutcome = Object.freeze({
  PRE_AUTHORIZED: 'pre_authorized',
  DENIED_BY_POLICY: 'denied_by_policy',
  AWAITING_AUTHORIZED_RESPONDER: 'awaiting_authorized_responder',
  REJECTED_UNATTENDED: 'rejected_unattended',
});

const VALID_OUTCOMES = new Set(Object.values(InteractionOutcome));

function validateInteractionOutcome(value) {
  if (!VALID_OUTCOMES.has(value)) {
    throw new Error(
      `Invalid interaction outcome: "${String(value)}". Must be one of: ${[...VALID_OUTCOMES].sort().join(', ')}`
    );
  }
}

module.exports = { InteractionOutcome, validateInteractionOutcome };
