// @suite full
// Ticket 116. The codex and claude adapters used to retain stdout/stderr text
// and a partial-line buffer with no size bound — a noisy backend (or a single
// unbroken line) grew the retained stream until the job hard timeout, the
// exact memory-exhaustion shape the opencode adapter's caps exist to prevent.
//
// These tests drive both adapters through the scripted-child seam with streams
// larger than the retention caps and assert:
//   A. all three collectors stay bounded and a truncation marker is present;
//   B. JSONL events that completed before the cap still parse;
//   C. claude's result extraction still returns the result text from the tail
//      of an oversized stdout.
//
// The caps are imported from the shared helper so the tests assert against the
// real production values, never a test-local copy that could drift.
const assert = require('node:assert');
const { ScriptedChild } = require('../fixtures/scripted-child');
const {
  MAX_RETAINED_STREAM_BYTES,
  MAX_PARTIAL_LINE_BYTES,
  TRUNCATION_PREFIX,
} = require('../../adapters/shared/stream-retention');

const ADAPTERS = [
  {
    name: 'codex',
    mod: '../../adapters/codex/adapter',
    cls: 'CodexAdapter',
    event: (i) => `{"type":"assistant_text","content":"early-${i}"}\n`,
  },
  {
    name: 'claude',
    mod: '../../adapters/claude/adapter',
    cls: 'ClaudeAdapter',
    event: (i) => `{"type":"assistant","message":{"id":"m${i}","content":[{"type":"text","text":"early-${i}"}]}}\n`,
  },
];

function scripted(AdapterClass) {
  const adapter = new AdapterClass();
  const fake = new ScriptedChild();
  adapter._spawn = () => fake;
  return { adapter, fake };
}

async function tick() {
  await new Promise(r => setTimeout(r, 10));
}

function makeFiller() {
  // Non-JSON filler lines: too big to parse, so they exercise the retention
  // cap without polluting the fact stream. Slightly over the cap as a whole.
  const line = 'x'.repeat(200) + '\n';
  return line.repeat(Math.ceil((MAX_RETAINED_STREAM_BYTES * 1.2) / line.length));
}

async function main() {

// ===========================================================================
// 1. A >cap stdout/stderr stream leaves all three collectors bounded, the
//    truncation marker present, and events that completed before the cap
//    unchanged (criteria A + B).
// ===========================================================================
for (const spec of ADAPTERS) {
  const { adapter, fake } = scripted(require(spec.mod)[spec.cls]);
  try {
    await adapter.Start({});
    await adapter.SendPrompt({}, 'go');

    const early = Array.from({ length: 500 }, (_, i) => spec.event(i)).join('');
    fake.pushStdout(early);
    await tick();
    const filler = makeFiller();
    fake.pushStdout(filler);
    fake.pushStderr(filler);
    await tick();

    assert.ok(adapter._stdoutContent.length <= MAX_RETAINED_STREAM_BYTES,
      `${spec.name}: _stdoutContent must stay bounded after a >cap stream, ` +
      `got ${adapter._stdoutContent.length} bytes`);
    assert.ok(adapter._stdoutContent.startsWith(TRUNCATION_PREFIX),
      `${spec.name}: stdout must carry the truncation marker when bytes were dropped`);
    assert.ok(adapter._stderrContent.length <= MAX_RETAINED_STREAM_BYTES,
      `${spec.name}: _stderrContent must stay bounded after a >cap stream, ` +
      `got ${adapter._stderrContent.length} bytes`);
    assert.ok(adapter._stderrContent.startsWith(TRUNCATION_PREFIX),
      `${spec.name}: stderr must carry the truncation marker when bytes were dropped`);
    assert.ok(adapter._lineBuffer.length <= MAX_PARTIAL_LINE_BYTES,
      `${spec.name}: _lineBuffer must stay bounded, got ${adapter._lineBuffer.length} bytes`);

    fake.emitExit(0);
    fake.closeStreams();
    const facts = [];
    for await (const f of adapter.Observe({})) facts.push(f);

    const textFacts = facts.filter(f => f.type === 'assistant_text');
    assert.ok(textFacts.some(f => f.text === 'early-0'),
      `${spec.name}: the first event parsed before the cap must survive`);
    assert.ok(textFacts.some(f => f.text === 'early-499'),
      `${spec.name}: the last event parsed before the cap must survive`);
    assert.strictEqual(facts[facts.length - 1].type, 'process_exited');
    console.log(`PASS: ${spec.name} collectors bounded with marker, pre-cap events intact`);
  } finally {
    try { adapter.Dispose({}); } catch {}
  }
}

// ===========================================================================
// 2. A single unbroken line larger than the partial-line cap leaves the
//    line buffer bounded (the memory shape a multi-megabyte line produces).
// ===========================================================================
for (const spec of ADAPTERS) {
  const { adapter, fake } = scripted(require(spec.mod)[spec.cls]);
  try {
    await adapter.Start({});
    fake.pushStdout('a'.repeat(MAX_PARTIAL_LINE_BYTES * 2));
    await tick();
    assert.ok(adapter._lineBuffer.length <= MAX_PARTIAL_LINE_BYTES,
      `${spec.name}: an unbroken >cap line must not grow _lineBuffer, ` +
      `got ${adapter._lineBuffer.length} bytes`);
    assert.ok(adapter._stdoutContent.length <= MAX_RETAINED_STREAM_BYTES,
      `${spec.name}: an unbroken >cap line must not grow _stdoutContent`);
    console.log(`PASS: ${spec.name} oversized unbroken line stays bounded`);
  } finally {
    try { adapter.Dispose({}); } catch {}
  }
}

// ===========================================================================
// 3. Claude's result extraction must survive the cap: a large stdout preamble
//    followed by the result section. The cap is tail-keeping, so the result
//    text at the end of the stream must be intact (criterion C).
// ===========================================================================
{
  const { adapter, fake } = scripted(require('../../adapters/claude/adapter').ClaudeAdapter);
  try {
    await adapter.Start({});
    await adapter.SendPrompt({}, 'go');

    fake.pushStdout(makeFiller());
    fake.pushStdout('{"type":"assistant","message":{"id":"m-final","content":[{"type":"text","text":"THE RESULT"}]}}\n');
    fake.pushStdout('{"type":"result","usage":{"input_tokens":5,"output_tokens":7},"session_id":"sess-final"}\n');
    await tick();

    assert.ok(adapter._stdoutContent.startsWith(TRUNCATION_PREFIX),
      'claude: the oversized preamble must have triggered the marker');

    fake.emitExit(0);
    fake.closeStreams();
    for await (const f of adapter.Observe({})) { /* drain and classify */ }

    const result = adapter.CollectResult({});
    assert.strictEqual(result.text, 'THE RESULT',
      'claude: the result text after a large preamble must be intact');
    assert.strictEqual(result.result_status, 'present',
      'claude: the result event must still be seen');
    assert.strictEqual(result.usage.total, 12,
      'claude: usage from the result event must survive');
    assert.strictEqual(result.backend_session_id, 'sess-final',
      'claude: the session id from the result event must survive');
    console.log('PASS: claude result extraction survives the retention cap');
  } finally {
    try { adapter.Dispose({}); } catch {}
  }
}

console.log('stream-retention: all assertions passed');
}

main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });
