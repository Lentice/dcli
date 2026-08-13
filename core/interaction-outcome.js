// The responder seam is intentionally deferred: core has no caller today, so
// only rejected_unattended is currently emitted. Keep the other values for
// the future attended/backend-native responder described by ADR-002/ADR-007.
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
