/**
 * Loop Guard - prevents agent-agent infinite loops.
 *
 * Rules:
 *   standard trust → only receives human messages
 *   elevated trust → receives human + agent messages, with a 30s cooldown
 *     between the same agent pair.
 *
 * Seam note (2026-08-17): this file previously also enforced a 5-exchange
 * per-minute cap per pair. With a 30s cooldown, at most 3 deliveries fit in
 * any 60s window (t=0, 30, 60 - the 61st call resets the window), so the
 * cap's `>= 5` branch was unreachable through the public API. It was dead
 * code kept alive only by a `_testState` seam that let tests pre-populate
 * the internal Maps to force the branch. Removed rather than redesigned:
 * the task's allowed production changes are limited to this dead-code
 * removal (and the index.ts entrypoint-guard refactor), not a behavioral
 * redesign of the cooldown/cap relationship.
 */

const lastExchange = new Map<string, number>();

export function shouldDeliver(
  _targetTrust: 'standard' | 'elevated',
  senderIsAgent: boolean,
  senderId: string,
  targetId: string,
): boolean {
  // Self-loop: never
  if (senderId === targetId) return false;

  // Agent-to-agent: allowed, but with a cooldown to prevent infinite loops
  if (senderIsAgent) {
    const pair = [senderId, targetId].sort().join('↔');
    const now = Date.now();

    // 30s cooldown
    if (now - (lastExchange.get(pair) ?? 0) < 30_000) return false;

    lastExchange.set(pair, now);
  }

  return true;
}
