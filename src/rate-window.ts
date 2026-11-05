/**
 * Sliding-window counter shared by the gateway's per-agent limiters (message
 * sends, token rotation, session calls). Records the call when allowed; when
 * not, reports the seconds until the oldest entry leaves the window (never
 * less than 1 second).
 */
export interface WindowVerdict {
  allowed: boolean;
  retryAfter: number;
  remaining: number;
}

export function consumeWindow(
  store: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number,
  maxRequests: number,
): WindowVerdict {
  if (!store.has(key)) store.set(key, []);
  const timestamps = store.get(key)!;

  // Remove old entries
  while (timestamps.length > 0 && timestamps[0] < now - windowMs) {
    timestamps.shift();
  }

  if (timestamps.length >= maxRequests) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000)), remaining: 0 };
  }

  timestamps.push(now);
  return { allowed: true, retryAfter: 0, remaining: maxRequests - timestamps.length };
}
