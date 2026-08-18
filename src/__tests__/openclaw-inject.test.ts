/**
 * Tests for src/openclaw-inject.ts.
 *
 * GATEWAY_TOKEN and DEVICE are computed once at module load from
 * hard-coded paths (/root/.openclaw/...) via top-level IIFEs - unlike
 * openclaw-bridge.ts's OpenClawBridge class, this file has no injectable
 * config seam, and adding one is out of scope for this task (the allowed
 * production changes are limited to the three named seam refactors). In
 * this test environment (and in CI) /root/.openclaw does not exist, so
 * DEVICE resolves to `null` and GATEWAY_TOKEN to `''` - the same fallback
 * path a real non-OpenClaw host hits. That gives us a real, unmocked
 * failure-path to test: the connect.challenge handler dereferences
 * `DEVICE.deviceId`, which throws against a null DEVICE and is caught by
 * injectToSession's own try/catch, which closes the socket and rejects.
 * `ws` itself is mocked so no real network I/O happens.
 *
 * The success path (full signed handshake) is exercised for the same
 * protocol logic in openclaw-bridge.test.ts, where devicePath/configPath
 * are constructor parameters and a real temp device identity can be
 * supplied - that seam does not exist here.
 *
 * Mutation guards (marked inline):
 *   M1: injectToSession stops rejecting on a socket 'error' event
 *   M2: injectToSession stops clearing/rejecting on the 8s TIMEOUT_MS
 *   M3: injectToSession stops catching a JSON.parse failure
 *   M4: the module-is-main guard stops gating the bottom CLI block
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];
  send = vi.fn();
  close = vi.fn();

  constructor(public url: string) {
    super();
    MockWebSocket.instances.push(this);
  }
}

vi.mock('ws', () => ({ default: MockWebSocket }));

const { injectToSession } = await import('../openclaw-inject.js');

// Captured immediately after import, before the `beforeEach` below resets
// MockWebSocket.instances - so it can't mask a side effect that happened
// at import time (see the module-is-main guard test further down).
const webSocketInstancesRightAfterImport = MockWebSocket.instances.length;

beforeEach(() => {
  MockWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('module-is-main entrypoint guard', () => {
  it('does not open a WebSocket merely by importing this module for its injectToSession export (M4, baseline)', () => {
    // Baseline sanity check only - NOT a mutation guard by itself. In this
    // vitest fork worker, process.argv is [node,
    // .../vitest/dist/workers/forks.js] (no third element), so
    // process.argv[2] is undefined regardless of what the `isMainModule &&`
    // guard is replaced with; a mutant here would still leave this
    // assertion green. The actual M4 guard is the test below, which sets
    // process.argv[2] itself before re-importing the module fresh.
    expect(webSocketInstancesRightAfterImport).toBe(0);
  });

  it('does not open a WebSocket at import time even with a truthy process.argv[2] (M4)', async () => {
    // MUTATION GUARD M4: this is the actual discriminator for the
    // `if (isMainModule && process.argv[2])` guard at the bottom of
    // openclaw-inject.ts. The test above can't drive process.argv[2] to a
    // truthy value (it's whatever vitest's own worker process happens to be
    // invoked with), so it can't distinguish the fixed guard from either the
    // pre-fix `if (process.argv[2])` (drops `isMainModule &&`) or a
    // hardcoded `const isMainModule = true`. Here we force argv[2] to a
    // truthy value ourselves, reset the module registry, and re-import the
    // module fresh:
    //  - with the real guard: process.argv[1] (this vitest worker's own
    //    entrypoint) never equals fileURLToPath(import.meta.url) for
    //    openclaw-inject.ts, so isMainModule is false and the CLI block is
    //    skipped regardless of argv[2] - no WebSocket is constructed.
    //  - with `if (process.argv[2])` (isMainModule check dropped): argv[2]
    //    alone is truthy, so injectToSession() runs at import time and
    //    constructs a WebSocket.
    //  - with `const isMainModule = true`: same outcome, since
    //    `true && process.argv[2]` is also truthy.
    // Verified locally against both mutants (each turned this assertion
    // red) and reverted; see the task's acceptance criteria for the mutant
    // diffs used.
    const originalArgv = process.argv;
    try {
      process.argv = [...originalArgv];
      process.argv[2] = 'probe message';
      vi.resetModules();
      await import('../openclaw-inject.js');
      expect(MockWebSocket.instances.length).toBe(0);
    } finally {
      process.argv = originalArgv;
    }
  });
});

describe('injectToSession - failure paths (no OpenClaw identity present)', () => {
  it('rejects once the connect.challenge handshake fails against a null DEVICE', async () => {
    const resultPromise = injectToSession('hello');

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0];
    ws.emit('message', Buffer.from(JSON.stringify({ event: 'connect.challenge', payload: { nonce: 'n1' } })));

    await expect(resultPromise).rejects.toThrow();
    expect(ws.close).toHaveBeenCalled();
  });

  it('rejects when the socket emits an error (M1)', async () => {
    const resultPromise = injectToSession('hello');

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0];
    // MUTATION GUARD M1: drop `ws.on('error', ...)` → this promise would
    // never settle and the test times out instead of failing cleanly.
    ws.emit('error', new Error('ECONNREFUSED'));

    await expect(resultPromise).rejects.toThrow('ECONNREFUSED');
  });

  it('rejects when the server sends malformed JSON (M3)', async () => {
    const resultPromise = injectToSession('hello');

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0];
    ws.emit('message', Buffer.from('{ this is not json'));

    // MUTATION GUARD M3: drop the try/catch around JSON.parse → an
    // unhandled synchronous throw inside an event listener instead of a
    // clean promise rejection; fails.
    await expect(resultPromise).rejects.toThrow();
    expect(ws.close).toHaveBeenCalled();
  });

  it('rejects with a timeout error after 8s of silence (M2)', async () => {
    vi.useFakeTimers();
    const resultPromise = injectToSession('hello');

    const assertion = expect(resultPromise).rejects.toThrow('OpenClaw inject timeout');
    // MUTATION GUARD M2: drop the setTimeout(..., TIMEOUT_MS) → this
    // promise never settles and advancing fake timers has nothing to fire.
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
  });
});
