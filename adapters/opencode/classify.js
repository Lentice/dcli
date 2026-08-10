/**
 * Backend error classification for opencode error payloads.
 *
 * Study §4: opencode reports credit exhaustion as HTTP 401 with
 * `responseBody.error.type == "CreditsError"`. Classifying that as `auth`
 * would send the operator to re-authenticate a working login, so the
 * discriminator is the structured error type, never the bare status code
 * (docs/engineering/backend-pitfalls.md).
 *
 * Returns a class hint string, or null when the payload matches nothing — the
 * caller must not guess.
 */
function classifyBackendError(structuredPayload) {
  if (!structuredPayload || typeof structuredPayload !== 'object') return null;
  // HTTP error body shape: { error: { type: "CreditsError" } } (study §4).
  if (structuredPayload.error && structuredPayload.error.type === 'CreditsError') {
    return 'quota_or_rate_limit';
  }
  const responseBody = structuredPayload.responseBody || structuredPayload.body || null;
  if (responseBody && typeof responseBody === 'object') {
    const errorType = responseBody.error && responseBody.error.type;
    if (errorType === 'CreditsError') return 'quota_or_rate_limit';
  }
  if (structuredPayload.name === 'CreditsError') return 'quota_or_rate_limit';
  return null;
}

module.exports = { classifyBackendError };
