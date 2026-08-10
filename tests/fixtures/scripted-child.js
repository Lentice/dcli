/**
 * Fixture: a scripted fake child process for the adapter `_spawn` seam.
 *
 * The codex and claude adapters spawn one child per job and drive everything
 * downstream of the process boundary from its events: stdout data is framed
 * into facts, stderr is classified, exit is observed, and the drain waits for
 * the streams to close. A real backend would make all of that untestable in
 * CI; the `_spawn` seam instead lets a test hand the adapter one of these and
 * script the exact ordering it needs — including the two orderings a real
 * child can produce but a stub usually cannot: a partial line split across two
 * chunks, and stdout data arriving *after* the exit event.
 *
 * Shape follows a real ChildProcess as far as the adapters rely on it:
 * EventEmitter with pid, kill() and killed, plus stdout/stderr/stdin streams
 * that support setEncoding and 'data'/'close' events. Pushing happens through
 * the streams (async 'data' delivery, like a real pipe); exit and close are
 * scripted explicitly so a test controls the ordering.
 */
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

class ScriptedChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.pid = 4242;
    this.killed = false;
    this.killCalls = [];
  }

  kill(signal) {
    this.killCalls.push(signal === undefined ? 'SIGTERM' : signal);
    this.killed = true;
    return true;
  }

  pushStdout(chunk) {
    this.stdout.write(chunk);
  }

  pushStderr(chunk) {
    this.stderr.write(chunk);
  }

  emitExit(code, signal) {
    this.emit('exit', code, signal);
  }

  /** Close both pipes, as a real child's streams do once nothing holds them. */
  closeStreams() {
    this.stdout.end();
    this.stderr.end();
  }
}

module.exports = { ScriptedChild };
