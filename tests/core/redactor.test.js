const assert = require('node:assert');

let Redactor;
function loadModules() {
  Redactor = require('../../core/redactor').Redactor;
}

// ===========================================================================
// 1. Redactor module exports a Redactor class
// ===========================================================================

{
  loadModules();
  assert.ok(Redactor, 'core/redactor.js must export a Redactor class');
  assert.strictEqual(typeof Redactor, 'function', 'Redactor must be a constructor');
}

console.log('PASS: Redactor module exists');

// ===========================================================================
// 2. Register a secret and redact it from plain text
// ===========================================================================

{
  loadModules();
  const r = new Redactor();
  r.registerSecret('api_key', 'sk-1234567890abcdef');
  const result = r.redactText('My key is sk-1234567890abcdef and it is secret');
  assert.strictEqual(result, 'My key is \u00abredacted:api_key\u00bb and it is secret',
    'Secret value must be replaced with placeholder');
}

console.log('PASS: redactText replaces registered secret');

// ===========================================================================
// 3. Register a secret and redact it from an object value
// ===========================================================================

{
  loadModules();
  const r = new Redactor();
  r.registerSecret('openai_key', 'sk-openai-xyz');
  const obj = { key: 'sk-openai-xyz', name: 'test' };
  const redacted = r.redactValue(obj);
  assert.strictEqual(redacted.key, '\u00abredacted:openai_key\u00bb');
  assert.strictEqual(redacted.name, 'test');
}

console.log('PASS: redactValue replaces registered secret in objects');

// ===========================================================================
// 4. Multiple secrets are all redacted
// ===========================================================================

{
  loadModules();
  const r = new Redactor();
  r.registerSecret('password', 'supersecret123');
  r.registerSecret('token', 'ghp_abc123def456');
  const result = r.redactText('password=supersecret123&token=ghp_abc123def456');
  assert.strictEqual(result, 'password=\u00abredacted:password\u00bb&token=\u00abredacted:token\u00bb');
}

console.log('PASS: multiple secrets all redacted');

// ===========================================================================
// 5. Stable placeholder format
// ===========================================================================

{
  loadModules();
  const r = new Redactor();
  r.registerSecret('my_secret', 'value123');
  const result = r.redactText('this contains value123');
  assert.ok(result.includes('\u00abredacted:my_secret\u00bb'),
    `Placeholder must contain redacted:my_secret, got: ${result}`);
  assert.ok(!result.includes('value123'), 'Original value must be absent');
}

console.log('PASS: stable placeholder format');

// ===========================================================================
// 6. Key-name pattern matching — values under matching keys are redacted
// ===========================================================================

{
  loadModules();
  const r = new Redactor();
  const obj = {
    authorization: 'Bearer sk-real-bearer-token',
    name: 'public-name',
    api_key: 'sk-real-key',
    deep: {
      token: 'real-token-value',
      secret: 'hidden-value',
      password: 'real-password',
      normal: 'keep-this',
    },
  };
  const redacted = r.redactValue(obj);
  assert.strictEqual(redacted.authorization, '\u00abredacted:authorization\u00bb');
  assert.strictEqual(redacted.api_key, '\u00abredacted:api_key\u00bb');
  assert.strictEqual(redacted.name, 'public-name');
  assert.strictEqual(redacted.deep.token, '\u00abredacted:token\u00bb');
  assert.strictEqual(redacted.deep.secret, '\u00abredacted:secret\u00bb');
  assert.strictEqual(redacted.deep.password, '\u00abredacted:password\u00bb');
  assert.strictEqual(redacted.deep.normal, 'keep-this');
}

console.log('PASS: key-name pattern matching redacts values under matching keys');

// ===========================================================================
// 7. Key patterns are case-insensitive
// ===========================================================================

{
  loadModules();
  const r = new Redactor();
  const obj = {
    Authorization: 'Bearer token-A',
    API_KEY: 'value-api',
    TOKEN: 'value-token',
  };
  const redacted = r.redactValue(obj);
  assert.strictEqual(redacted.Authorization, '\u00abredacted:authorization\u00bb');
  assert.strictEqual(redacted.API_KEY, '\u00abredacted:api_key\u00bb');
  assert.strictEqual(redacted.TOKEN, '\u00abredacted:token\u00bb');
}

console.log('PASS: key patterns case-insensitive');

// ===========================================================================
// 8. No corruption of non-matching content
// ===========================================================================

{
  loadModules();
  const r = new Redactor();
  r.registerSecret('secret', 'hidden');
  const obj = {
    normal: 'hello world',
    number: 42,
    flag: true,
    empty: '',
    nested: { a: { b: 'keep' } },
  };
  const redacted = r.redactValue(obj);
  assert.deepStrictEqual(redacted, obj, 'Non-matching content must be unchanged');
}

console.log('PASS: non-matching content unchanged');

// ===========================================================================
// 9. null and undefined values handled
// ===========================================================================

{
  loadModules();
  const r = new Redactor();
  assert.strictEqual(r.redactText(null), null, 'null text must return null');
  assert.strictEqual(r.redactText(undefined), undefined, 'undefined text must return undefined');
  const obj = r.redactValue(null);
  assert.strictEqual(obj, null, 'null value must return null');
}

console.log('PASS: null/undefined handled');

// ===========================================================================
// 10. Arrays are redacted
// ===========================================================================

{
  loadModules();
  const r = new Redactor();
  r.registerSecret('token', 'secret-value');
  const arr = ['public', 'secret-value', { token: 'secret-value' }];
  const redacted = r.redactValue(arr);
  assert.strictEqual(redacted[0], 'public');
  assert.strictEqual(redacted[1], '\u00abredacted:token\u00bb');
  assert.strictEqual(redacted[2].token, '\u00abredacted:token\u00bb');
}

console.log('PASS: arrays redacted');

// ===========================================================================
// 12. redactText is plain-text only — does not parse JSON structure
// ===========================================================================

{
  loadModules();
  const r = new Redactor();
  // redactText does not understand JSON structure; it only replaces exact values
  // Structured redaction happens through redactValue
  const text = JSON.stringify({ api_key: 'should-be-redacted', normal: 'keep' });
  const redacted = r.redactText(text);
  // Since 'should-be-redacted' is not a registered secret, text passes through
  assert.strictEqual(redacted, text, 'redactText without registered secrets must pass through');
  // redactValue does understand structure and key patterns
  const obj = { api_key: 'should-be-redacted', normal: 'keep' };
  const redactedObj = r.redactValue(obj);
  assert.strictEqual(redactedObj.api_key, '\u00abredacted:api_key\u00bb');
  assert.strictEqual(redactedObj.normal, 'keep');
}

console.log('PASS: redactText is plain-text only, redactValue handles structure');

// ===========================================================================
// Summary
// ===========================================================================

console.log('\nAll redactor tests passed.');
