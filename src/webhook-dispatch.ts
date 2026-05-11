/**
 * Webhook dispatch with retry logic.
 *
 * Retries up to MAX_RETRIES times with exponential backoff.
 * Logs success/failure per attempt.
 */

import { createHmac } from 'node:crypto';
import { metrics } from './metrics';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1s, 2s, 4s

export interface WebhookPayload {
  url: string;
  headers: Record<string, string>;
  body: string;
  agentKey: string; // for logging
  agentId?: string; // for metrics
  roomId?: string;
}

/**
 * Sign a webhook body with HMAC-SHA256 over `${timestamp}.${body}` using
 * UTF-8 bytes. Returns the signature header value in the format
 * `t=<ts>,v1=<hex>`, plus the raw timestamp so the caller can emit a
 * matching `X-Triologue-Timestamp` header.
 *
 * Verifiers on the receiver side:
 *   1. Parse `t` and `v1` from the signature header.
 *   2. Reject if `|now - t| > 5 minutes` (replay window).
 *   3. Recompute HMAC over `${t}.${rawBody}` with their copy of the
 *      agent secret and compare in constant time.
 *
 * UTF-8 is the canonical encoding for both the timestamp and the body
 * before HMAC; non-ASCII bodies must serialize the same way on both
 * ends (JSON.stringify output is UTF-8 by default in Node/V8).
 */
export interface WebhookSignature {
  timestamp: string; // unix milliseconds as decimal string
  signature: string; // `t=<ts>,v1=<hex>`
}

export function signWebhook(
  secret: string,
  body: string,
  timestampMs: number = Date.now(),
): WebhookSignature {
  const t = String(timestampMs);
  const mac = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return { timestamp: t, signature: `t=${t},v1=${mac}` };
}

/**
 * Build the outbound HTTP header set for a webhook dispatch.
 *
 * If the agent has no webhookSecret (null or empty string) the
 * Signature/Timestamp/legacy-Secret headers are omitted entirely.
 * Signing with an empty key is cryptographically meaningless (the
 * MAC becomes a public function of the body), so receivers must
 * either accept unsigned deliveries or refuse them — we don't ship
 * a forgeable signature.
 */
export function buildDispatchHeaders(
  agent: { mentionKey: string; webhookSecret: string | null },
  payload: string,
  timestampMs?: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Triologue-Agent': agent.mentionKey,
  };
  const secret = agent.webhookSecret;
  if (secret && secret.length > 0) {
    const { timestamp, signature } = signWebhook(secret, payload, timestampMs);
    headers['X-Triologue-Secret'] = secret; // deprecated; removed 2026-10
    headers['X-Triologue-Timestamp'] = timestamp;
    headers['X-Triologue-Signature'] = signature;
  }
  return headers;
}

export async function dispatchWebhook(payload: WebhookPayload): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(payload.url, {
        method: 'POST',
        headers: payload.headers,
        body: payload.body,
        signal: AbortSignal.timeout(10_000), // 10s timeout per attempt
      });

      if (res.ok) {
        if (attempt > 0) {
          console.log(`[webhook:${payload.agentKey}] ✅ (retry #${attempt})`);
        } else {
          console.log(`[webhook:${payload.agentKey}] ✅`);
        }
        if (payload.agentId && payload.roomId) {
          metrics.recordMessageSent(payload.agentId, payload.roomId);
        }
        return true;
      }

      // Non-retryable status codes
      if (res.status >= 400 && res.status < 500) {
        console.warn(`[webhook:${payload.agentKey}] ⚠️ ${res.status} (not retrying)`);
        return false;
      }

      // 5xx — retryable
      console.warn(`[webhook:${payload.agentKey}] ⚠️ ${res.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      if (payload.agentId) {
        metrics.recordMessageRetry(payload.agentId, attempt + 1);
      }
    } catch (err: any) {
      console.warn(`[webhook:${payload.agentKey}] ⚠️ ${err.message} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      if (payload.agentId) {
        metrics.recordMessageRetry(payload.agentId, attempt + 1);
      }
    }

    // Wait before retry (skip on last attempt)
    if (attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.error(`[webhook:${payload.agentKey}] ❌ Failed after ${MAX_RETRIES + 1} attempts`);
  
  // Record message loss
  if (payload.agentId && payload.roomId) {
    metrics.recordMessageLost(payload.agentId, payload.roomId, 'max retries exceeded');
  }
  
  return false;
}
