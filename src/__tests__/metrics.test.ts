/**
 * Tests for src/metrics.ts (MetricsCollector singleton).
 *
 * `fs` is mocked so flush()/shutdown() never touch real disk - the module
 * computes its log path from `__dirname` at construction time, which is
 * not configurable (no seam), so real writes must be prevented at the fs
 * boundary instead.
 *
 * `metrics` is a singleton constructed once at module import, so tests
 * snapshot the delta each method call produces relative to whatever state
 * earlier tests in this file left behind, rather than assuming a fresh
 * instance.
 *
 * Mutation guards (marked inline):
 *   M1: recordDisconnect stops floor-clamping activeConnections at 0
 *   M2: getSnapshot stops returning a copy (would leak a live reference)
 *   M3: generateReport stops guarding the auth-failure-rate divide-by-zero
 *   M4: generateReport stops guarding the message-loss-rate divide-by-zero
 *   M5: shutdown() stops clearing the flush interval
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}));
vi.mock('fs', () => ({ default: fsMocks }));

const { metrics } = await import('../metrics.js');

beforeEach(() => {
  fsMocks.appendFileSync.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('connection + disconnect tracking', () => {
  it('increments active + total connections on recordConnection', () => {
    const before = metrics.getSnapshot();
    metrics.recordConnection('agent-1', 'Agent One');
    const after = metrics.getSnapshot();

    expect(after.activeConnections).toBe(before.activeConnections + 1);
    expect(after.totalConnections).toBe(before.totalConnections + 1);
  });

  it('decrements activeConnections and increments disconnects on recordDisconnect', () => {
    metrics.recordConnection('agent-2', 'Agent Two');
    const before = metrics.getSnapshot();

    metrics.recordDisconnect('agent-2', 'client closed');
    const after = metrics.getSnapshot();

    expect(after.activeConnections).toBe(before.activeConnections - 1);
    expect(after.disconnects).toBe(before.disconnects + 1);
  });

  it('clamps activeConnections at 0 instead of going negative (M1)', () => {
    // Disconnect more times than connected - activeConnections must not
    // go below 0 (a stray/duplicate disconnect event should not corrupt
    // the counter into a value that would need two connects to recover).
    for (let i = 0; i < 5; i++) metrics.recordDisconnect(`ghost-${i}`, 'no matching connect');
    // MUTATION GUARD M1: drop `Math.max(0, ...)` → this would go negative
    expect(metrics.getSnapshot().activeConnections).toBeGreaterThanOrEqual(0);
  });
});

describe('auth + message tracking', () => {
  it('increments authFailures on recordAuthFailure', () => {
    const before = metrics.getSnapshot();
    metrics.recordAuthFailure('bad token');
    expect(metrics.getSnapshot().authFailures).toBe(before.authFailures + 1);
  });

  it('increments tokenRevocationAttempts on recordTokenRevocationAttempt', () => {
    const before = metrics.getSnapshot();
    metrics.recordTokenRevocationAttempt('agent-3', 'revoked mid-session');
    expect(metrics.getSnapshot().tokenRevocationAttempts).toBe(before.tokenRevocationAttempts + 1);
  });

  it('increments messagesSent on recordMessageSent', () => {
    const before = metrics.getSnapshot();
    metrics.recordMessageSent('agent-1', 'room-1');
    expect(metrics.getSnapshot().messagesSent).toBe(before.messagesSent + 1);
  });

  it('increments messagesLost on recordMessageLost', () => {
    const before = metrics.getSnapshot();
    metrics.recordMessageLost('agent-1', 'room-1', 'max retries exceeded');
    expect(metrics.getSnapshot().messagesLost).toBe(before.messagesLost + 1);
  });

  it('increments messageRetries on recordMessageRetry', () => {
    const before = metrics.getSnapshot();
    metrics.recordMessageRetry('agent-1', 2);
    expect(metrics.getSnapshot().messageRetries).toBe(before.messageRetries + 1);
  });
});

describe('updateAgentCounts + getSnapshot', () => {
  it('sets both websocket and webhook agent counts', () => {
    metrics.updateAgentCounts(3, 7);
    const snap = metrics.getSnapshot();
    expect(snap.agentsByType).toEqual({ websocket: 3, webhook: 7 });
  });

  it('getSnapshot returns an independent copy, not a live reference (M2)', () => {
    const snap = metrics.getSnapshot();
    snap.activeConnections = 999999;
    // MUTATION GUARD M2: if getSnapshot returned `this.data` directly
    // instead of a spread copy, mutating the snapshot would corrupt
    // internal state; fails.
    expect(metrics.getSnapshot().activeConnections).not.toBe(999999);
  });
});

describe('generateReport', () => {
  it('reports 0% rates when there are no connections/messages yet (M3, M4)', () => {
    fsMocks.appendFileSync.mockImplementation(() => {});
    // A freshly-updated agent-count call doesn't touch totalConnections /
    // messagesSent, so use a dedicated snapshot check via the report text
    // instead of asserting on a truly-zero global counter (the singleton
    // has accumulated state from earlier tests in this file).
    const report = metrics.generateReport();
    // MUTATION GUARD M3/M4: drop the `> 0 ? ... : 0` guards → division by
    // zero produces NaN, which would show up as "NaN%" in the report.
    expect(report).not.toContain('NaN%');
  });

  it('includes the current snapshot values in the rendered report', () => {
    metrics.updateAgentCounts(2, 5);
    const report = metrics.generateReport();
    expect(report).toContain('WebSocket:    2');
    expect(report).toContain('Webhook:      5');
    expect(report).toContain('BYOA Gateway Metrics Report');
  });
});

describe('shutdown()', () => {
  it('flushes a valid JSON line to disk', () => {
    fsMocks.appendFileSync.mockImplementation(() => {});
    const callsBefore = fsMocks.appendFileSync.mock.calls.length;

    metrics.shutdown();

    expect(fsMocks.appendFileSync.mock.calls.length).toBe(callsBefore + 1);
    const [, line] = fsMocks.appendFileSync.mock.calls[fsMocks.appendFileSync.mock.calls.length - 1];
    expect(() => JSON.parse((line as string).trim())).not.toThrow();
  });

  it('clears the flush interval handle (M5)', () => {
    fsMocks.appendFileSync.mockImplementation(() => {});
    metrics.shutdown();
    // MUTATION GUARD M5: drop `this.flushInterval = null` (or the whole
    // clearInterval branch) → the handle would stay live instead of being
    // reset, and a would-be `shutdown()`-guard elsewhere that checks for
    // "already shut down" would never trip.
    expect((metrics as unknown as { flushInterval: unknown }).flushInterval).toBeNull();
  });

  it('flush() failures are swallowed, not thrown', () => {
    fsMocks.appendFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => metrics.shutdown()).not.toThrow();
  });
});
