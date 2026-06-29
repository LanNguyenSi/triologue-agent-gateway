/**
 * Tests for src/loop-guard.ts
 *
 * shouldDeliver is pure-deterministic; vi.useFakeTimers() controls Date.now().
 *
 * Architecture note on the 5/min cap:
 *   The 30-second cooldown and the 60-second window are mutually exclusive for
 *   the same pair: with 30s gaps, at most 3 deliveries fit within any 60s
 *   window before it resets (at t=0, 30s, 60s — then the 61s call resets the
 *   window).  The 5/min cap is therefore unreachable through the public API
 *   for a single pair.  The _testState seam lets us pre-populate the internal
 *   Maps to exercise the `ex.count >= 5` branch directly.
 *
 * Mutation guards (each marked at the relevant test):
 *   M1: invert self-loop check (`senderId !== targetId`) → self-loop tests fail
 *   M2: change cap from `>= 5` to `>= 6` → 6th-message cap test fails
 *   M3: change cooldown threshold from 30_000 → 0 → cooldown test fails
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldDeliver, _testState } from '../loop-guard.js';

// ── Timer setup ──────────────────────────────────────────────────────────────

/** Start of epoch used as the stable anchor for all tests */
const BASE_TIME = new Date('2025-01-01T00:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  // Clear module-level state between tests (maps are exported via _testState)
  _testState.lastExchange.clear();
  _testState.exchangeCount.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Self-loop guard (M1) ──────────────────────────────────────────────────────

describe('self-loop block', () => {
  it('blocks delivery when sender and recipient are the same ID', () => {
    // MUTATION GUARD M1: invert `senderId === targetId` → returns true; fails
    expect(shouldDeliver('elevated', true, 'agent-X', 'agent-X')).toBe(false);
  });

  it('blocks even when senderIsAgent is false (human self-loop)', () => {
    // M1: same check applies for non-agent senders
    expect(shouldDeliver('standard', false, 'human-X', 'human-X')).toBe(false);
  });

  it('allows delivery when sender and recipient are different', () => {
    expect(shouldDeliver('elevated', false, 'agent-A', 'agent-B')).toBe(true);
  });
});

// ── Human sender (no cooldowns apply) ────────────────────────────────────────

describe('human sender', () => {
  it('delivers any number of human messages without cooldown', () => {
    for (let i = 0; i < 10; i++) {
      expect(shouldDeliver('standard', false, 'human-1', 'agent-1')).toBe(true);
    }
  });

  it('delivers human messages even under standard trust level', () => {
    expect(shouldDeliver('standard', false, 'human-2', 'agent-2')).toBe(true);
  });
});

// ── 30-second pair cooldown (M3) ─────────────────────────────────────────────

describe('30s cooldown between same agent pair', () => {
  it('allows the first delivery from a new agent pair', () => {
    expect(shouldDeliver('elevated', true, 'bot-A', 'bot-B')).toBe(true);
  });

  it('blocks a second delivery within 30s of the first', () => {
    shouldDeliver('elevated', true, 'bot-cd-A', 'bot-cd-B');
    vi.advanceTimersByTime(10_000); // only 10s later
    // MUTATION GUARD M3: change 30_000 → 0 → returns true; test fails
    expect(shouldDeliver('elevated', true, 'bot-cd-A', 'bot-cd-B')).toBe(false);
  });

  it('allows a delivery again once 30s have elapsed', () => {
    shouldDeliver('elevated', true, 'bot-wait-A', 'bot-wait-B');
    vi.advanceTimersByTime(30_000); // exactly 30s
    expect(shouldDeliver('elevated', true, 'bot-wait-A', 'bot-wait-B')).toBe(true);
  });

  it('pair key is order-independent (A→B and B→A share the same cooldown)', () => {
    shouldDeliver('elevated', true, 'bot-ord-A', 'bot-ord-B');
    vi.advanceTimersByTime(5_000); // within cooldown window
    // B→A uses same pair key, so also blocked
    expect(shouldDeliver('elevated', true, 'bot-ord-B', 'bot-ord-A')).toBe(false);
  });
});

// ── 5-per-minute cap (M2) ─────────────────────────────────────────────────────

describe('5-per-minute cap', () => {
  it('5th delivery is allowed (count just below cap)', () => {
    const pair = ['cap5-A', 'cap5-B'].sort().join('↔');
    // Pre-set state: 4 exchanges in the current window, cooldown cleared
    _testState.exchangeCount.set(pair, { count: 4, reset: BASE_TIME + 60_000 });
    _testState.lastExchange.set(pair, BASE_TIME - 30_000); // 30s ago → cooldown satisfied

    expect(shouldDeliver('elevated', true, 'cap5-A', 'cap5-B')).toBe(true);
  });

  it('6th delivery is blocked once count reaches 5', () => {
    const pair = ['cap6-A', 'cap6-B'].sort().join('↔');
    // Pre-set state: 5 exchanges already in window, cooldown cleared
    _testState.exchangeCount.set(pair, { count: 5, reset: BASE_TIME + 60_000 });
    _testState.lastExchange.set(pair, BASE_TIME - 30_000);

    // MUTATION GUARD M2: change `>= 5` to `>= 6` → returns true; test fails
    expect(shouldDeliver('elevated', true, 'cap6-A', 'cap6-B')).toBe(false);
  });

  it('window resets and allows delivery after 60s', () => {
    const pair = ['cap-reset-A', 'cap-reset-B'].sort().join('↔');
    // Start with an exhausted window that expires in 1s
    _testState.exchangeCount.set(pair, { count: 5, reset: BASE_TIME + 1_000 });
    _testState.lastExchange.set(pair, BASE_TIME - 30_000);

    // Confirm blocked while window is active
    expect(shouldDeliver('elevated', true, 'cap-reset-A', 'cap-reset-B')).toBe(false);

    // Advance past the window reset time + cooldown
    vi.advanceTimersByTime(31_000);
    // New window starts → delivery allowed
    expect(shouldDeliver('elevated', true, 'cap-reset-A', 'cap-reset-B')).toBe(true);
  });
});

// ── Distinct pairs are independent ───────────────────────────────────────────

describe('distinct pairs are independent', () => {
  it('cooldown on pair A does not affect pair B (different target)', () => {
    shouldDeliver('elevated', true, 'bot-indep-A', 'bot-indep-B');
    // Same sender, different target → different pair key → not blocked
    expect(shouldDeliver('elevated', true, 'bot-indep-A', 'bot-indep-C')).toBe(true);
  });

  it('exchange count for pair A does not bleed into pair B', () => {
    const pairA = ['bleed-A1', 'bleed-A2'].sort().join('↔');
    _testState.exchangeCount.set(pairA, { count: 5, reset: BASE_TIME + 60_000 });
    _testState.lastExchange.set(pairA, BASE_TIME - 30_000);

    // Pair A is blocked
    expect(shouldDeliver('elevated', true, 'bleed-A1', 'bleed-A2')).toBe(false);
    // Fresh pair B is not blocked
    expect(shouldDeliver('elevated', true, 'bleed-B1', 'bleed-B2')).toBe(true);
  });
});
