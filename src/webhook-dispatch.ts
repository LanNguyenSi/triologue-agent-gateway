/**
 * Webhook dispatch with retry logic.
 * 
 * Retries up to MAX_RETRIES times with exponential backoff.
 * Logs success/failure per attempt.
 */

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
