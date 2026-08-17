/**
 * Tests for src/loop-guard.ts
 *
 * shouldDeliver is pure-deterministic; vi.useFakeTimers() controls Date.now().
 * All tests drive the function purely through its public API - no internal
 * state seam.
 *
 * Seam note: an earlier version of this file also enforced a 5-exchange
 * per-minute cap, tested via an exported `_testState` seam that pre-populated
 * internal Maps (the cap's `>= 5` branch was unreachable through the public
 * API given the 30s cooldown - see loop-guard.ts). The cap was removed as
 * dead code; this file now only covers the cooldown behavior that remains.
 *
 * Mutation guards (each marked at the relevant test):
 *   M1: invert self-loop check (`senderId !== targetId`) → self-loop tests fail
 *   M3: change cooldown threshold from 30_000 → 0 → cooldown test fails
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldDeliver } from '../loop-guard.js';

// ── Timer setup ──────────────────────────────────────────────────────────────

/** Start of epoch used as the stable anchor for all tests */
const BASE_TIME = new Date('2025-01-01T00:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
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

  it('repeated deliveries at exactly the cooldown boundary stay allowed', () => {
    // Drives the same pair across several 30s-spaced calls - the scenario
    // that used to make the (now-removed) 5/min cap unreachable.
    const sender = 'bot-cadence-A';
    const target = 'bot-cadence-B';
    expect(shouldDeliver('elevated', true, sender, target)).toBe(true);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30_000);
      expect(shouldDeliver('elevated', true, sender, target)).toBe(true);
    }
  });
});

// ── Distinct pairs are independent ───────────────────────────────────────────

describe('distinct pairs are independent', () => {
  it('cooldown on pair A does not affect pair B (different target)', () => {
    shouldDeliver('elevated', true, 'bot-indep-A', 'bot-indep-B');
    // Same sender, different target → different pair key → not blocked
    expect(shouldDeliver('elevated', true, 'bot-indep-A', 'bot-indep-C')).toBe(true);
  });

  it('cooldown state for pair A does not bleed into pair B', () => {
    shouldDeliver('elevated', true, 'bleed-A1', 'bleed-A2');
    vi.advanceTimersByTime(5_000); // within pair A's cooldown

    // Pair A is still blocked
    expect(shouldDeliver('elevated', true, 'bleed-A1', 'bleed-A2')).toBe(false);
    // Fresh pair B is not blocked
    expect(shouldDeliver('elevated', true, 'bleed-B1', 'bleed-B2')).toBe(true);
  });
});
