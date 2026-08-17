/**
 * Tests for src/read-tracker.ts - persisted last-seen-message state.
 *
 * `fs` is mocked so no real file at .read-tracker.json is read or
 * written - TRACKER_FILE is computed from `__dirname` at module load
 * with no injectable seam (out of scope for this task).
 *
 * Mutation guards (marked inline):
 *   M1: loadReadTracker stops guarding with existsSync (would throw on
 *       first run instead of leaving state empty)
 *   M2: loadReadTracker stops swallowing a JSON.parse failure
 *   M3: markMessageSeen stops persisting via saveReadTracker
 *   M4: getLastSeenMessageId stops returning null for an unknown pair
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// read-tracker.ts imports `* as fs`, so the mock factory must expose these
// as top-level named exports (not nested under `default`).
const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('fs', () => fsMocks);

const { loadReadTracker, getLastSeenMessageId, markMessageSeen, getLastSeenTimestamp } =
  await import('../read-tracker.js');

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  // Reset persisted state to empty for each test by loading against a
  // "file does not exist" fs mock.
  loadReadTracker();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadReadTracker', () => {
  it('leaves state empty without reading the file when it does not exist (M1)', () => {
    fsMocks.existsSync.mockReturnValue(false);
    // MUTATION GUARD M1: drop the `existsSync` guard → readFileSync would
    // be called against a nonexistent path and throw ENOENT (still caught
    // below, but this asserts the guarded, non-throwing branch runs).
    expect(() => loadReadTracker()).not.toThrow();
    expect(fsMocks.readFileSync).not.toHaveBeenCalled();
    expect(getLastSeenMessageId('agent-1', 'room-1')).toBeNull();
  });

  it('loads persisted state from a valid JSON file', () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ 'agent-1': { 'room-1': { lastMessageId: 'm42', lastSeenAt: 12345 } } }),
    );

    loadReadTracker();

    expect(getLastSeenMessageId('agent-1', 'room-1')).toBe('m42');
    expect(getLastSeenTimestamp('agent-1', 'room-1')).toBe(12345);
  });

  it('resets to empty state and does not throw on corrupt JSON (M2)', () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue('{ not valid json');

    // MUTATION GUARD M2: drop the try/catch around JSON.parse → this
    // throws instead of resetting state to {}.
    expect(() => loadReadTracker()).not.toThrow();
    expect(getLastSeenMessageId('agent-1', 'room-1')).toBeNull();
  });

  it('resets in-memory state even if it previously had entries (corrupt reload clears stale data)', () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ 'agent-1': { 'room-1': { lastMessageId: 'm1', lastSeenAt: 1 } } }),
    );
    loadReadTracker();
    expect(getLastSeenMessageId('agent-1', 'room-1')).toBe('m1');

    fsMocks.readFileSync.mockReturnValue('{ broken');
    loadReadTracker();

    expect(getLastSeenMessageId('agent-1', 'room-1')).toBeNull();
  });
});

describe('getLastSeenMessageId / getLastSeenTimestamp - unknown pairs (M4)', () => {
  it('returns null for an agent with no tracked rooms', () => {
    // MUTATION GUARD M4: if the optional-chaining fallback (`?? null`) is
    // dropped, this would throw instead of returning null.
    expect(getLastSeenMessageId('unknown-agent', 'room-1')).toBeNull();
    expect(getLastSeenTimestamp('unknown-agent', 'room-1')).toBeNull();
  });

  it('returns null for a known agent but an untracked room', () => {
    markMessageSeen('agent-x', 'room-known', 'm1');
    expect(getLastSeenMessageId('agent-x', 'room-other')).toBeNull();
  });
});

describe('markMessageSeen - mutation + persistence', () => {
  it('creates a new agent/room entry on first call', () => {
    markMessageSeen('agent-y', 'room-y', 'm100');
    expect(getLastSeenMessageId('agent-y', 'room-y')).toBe('m100');
  });

  it('overwrites lastMessageId and lastSeenAt on repeated calls for the same pair', () => {
    markMessageSeen('agent-z', 'room-z', 'm1');
    const firstTs = getLastSeenTimestamp('agent-z', 'room-z');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5000);
    markMessageSeen('agent-z', 'room-z', 'm2');
    vi.useRealTimers();

    expect(getLastSeenMessageId('agent-z', 'room-z')).toBe('m2');
    expect(getLastSeenTimestamp('agent-z', 'room-z')).toBeGreaterThanOrEqual(firstTs! + 5000);
  });

  it('tracks multiple rooms independently for the same agent', () => {
    markMessageSeen('agent-multi', 'room-a', 'ma1');
    markMessageSeen('agent-multi', 'room-b', 'mb1');

    expect(getLastSeenMessageId('agent-multi', 'room-a')).toBe('ma1');
    expect(getLastSeenMessageId('agent-multi', 'room-b')).toBe('mb1');
  });

  it('persists to disk via writeFileSync on every call (M3)', () => {
    fsMocks.writeFileSync.mockClear();
    markMessageSeen('agent-persist', 'room-persist', 'mp1');

    // MUTATION GUARD M3: drop the saveReadTracker() call → writeFileSync
    // would never be invoked and state would be lost on restart; fails.
    expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(1);
    const [, contents] = fsMocks.writeFileSync.mock.calls[0];
    const written = JSON.parse(contents as string);
    expect(written['agent-persist']['room-persist'].lastMessageId).toBe('mp1');
  });

  it('does not throw when the disk write fails (best-effort persistence)', () => {
    fsMocks.writeFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => markMessageSeen('agent-fail', 'room-fail', 'mf1')).not.toThrow();
    // In-memory state still updates even though the write failed.
    expect(getLastSeenMessageId('agent-fail', 'room-fail')).toBe('mf1');
  });
});
