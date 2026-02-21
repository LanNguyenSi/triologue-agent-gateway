/**
 * Loop Guard — prevents agent-agent infinite loops.
 *
 * Rules:
 *   standard trust → only receives human messages
 *   elevated trust → receives human + agent messages, with cooldowns:
 *     - 30s cooldown between same agent pair
 *     - Max 5 exchanges per minute per pair
 */

const lastExchange = new Map<string, number>();
const exchangeCount = new Map<string, { count: number; reset: number }>();

export function shouldDeliver(
  targetTrust: 'standard' | 'elevated',
  senderIsAgent: boolean,
  senderId: string,
  targetId: string,
): boolean {
  // Standard agents: no agent messages
  if (targetTrust === 'standard' && senderIsAgent) return false;

  // Self-loop: never
  if (senderId === targetId) return false;

  if (senderIsAgent) {
    const pair = [senderId, targetId].sort().join('↔');
    const now = Date.now();

    // 30s cooldown
    if (now - (lastExchange.get(pair) ?? 0) < 30_000) return false;

    // Max 5/min
    let ex = exchangeCount.get(pair);
    if (!ex || now > ex.reset) ex = { count: 0, reset: now + 60_000 };
    if (ex.count >= 5) return false;

    ex.count++;
    exchangeCount.set(pair, ex);
    lastExchange.set(pair, now);
  }

  return true;
}
