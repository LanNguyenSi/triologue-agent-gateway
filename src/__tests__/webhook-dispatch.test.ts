import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signWebhook } from '../webhook-dispatch.js';

describe('signWebhook', () => {
  const secret = 'test-agent-secret-abc123';
  const body = JSON.stringify({ messageId: 'm1', room: 'r1', content: 'hello' });

  it('returns timestamp as decimal-string ms', () => {
    const fixedTs = 1_700_000_000_123;
    const { timestamp } = signWebhook(secret, body, fixedTs);
    expect(timestamp).toBe('1700000000123');
  });

  it('produces the `t=<ts>,v1=<hex>` signature header shape', () => {
    const fixedTs = 1_700_000_000_123;
    const { signature } = signWebhook(secret, body, fixedTs);
    expect(signature).toMatch(/^t=1700000000123,v1=[0-9a-f]{64}$/);
  });

  it('is deterministic for identical (secret, body, ts)', () => {
    const fixedTs = 1_700_000_000_000;
    const a = signWebhook(secret, body, fixedTs);
    const b = signWebhook(secret, body, fixedTs);
    expect(a.signature).toBe(b.signature);
    expect(a.timestamp).toBe(b.timestamp);
  });

  it('matches an independent HMAC-SHA256 computation over `${ts}.${body}`', () => {
    const fixedTs = 1_700_000_000_000;
    const { signature } = signWebhook(secret, body, fixedTs);
    const expected = createHmac('sha256', secret).update(`${fixedTs}.${body}`, 'utf8').digest('hex');
    expect(signature).toBe(`t=${fixedTs},v1=${expected}`);
  });

  it('produces different signatures for different bodies (same secret + ts)', () => {
    const fixedTs = 1_700_000_000_000;
    const a = signWebhook(secret, '{"x":1}', fixedTs);
    const b = signWebhook(secret, '{"x":2}', fixedTs);
    expect(a.signature).not.toBe(b.signature);
  });

  it('produces different signatures for different secrets (same body + ts)', () => {
    const fixedTs = 1_700_000_000_000;
    const a = signWebhook('secret-1', body, fixedTs);
    const b = signWebhook('secret-2', body, fixedTs);
    expect(a.signature).not.toBe(b.signature);
  });

  it('produces different signatures for different timestamps (replay defense)', () => {
    const a = signWebhook(secret, body, 1_700_000_000_000);
    const b = signWebhook(secret, body, 1_700_000_000_001);
    expect(a.signature).not.toBe(b.signature);
  });

  it('handles UTF-8 multibyte bodies correctly', () => {
    const fixedTs = 1_700_000_000_000;
    const utf8Body = JSON.stringify({ content: 'héllo 🌍 日本語' });
    const { signature } = signWebhook(secret, utf8Body, fixedTs);
    // Independent verify using the same UTF-8 byte stream.
    const expected = createHmac('sha256', secret)
      .update(`${fixedTs}.${utf8Body}`, 'utf8')
      .digest('hex');
    expect(signature).toBe(`t=${fixedTs},v1=${expected}`);
  });

  it('handles empty body', () => {
    const { signature } = signWebhook(secret, '', 1_700_000_000_000);
    expect(signature).toMatch(/^t=1700000000000,v1=[0-9a-f]{64}$/);
  });

  it('defaults timestamp to Date.now() when omitted', () => {
    const before = Date.now();
    const { timestamp } = signWebhook(secret, body);
    const after = Date.now();
    const ts = Number(timestamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('an attacker who swaps the timestamp in the header cannot match the MAC', () => {
    // Simulates: sender signs at t=T, an on-wire attacker rewrites
    // X-Triologue-Timestamp to t=T' but keeps the original v1=hash.
    const realTs = 1_700_000_000_000;
    const fakeTs = 1_700_000_999_999;
    const { signature } = signWebhook(secret, body, realTs);
    // Verifier recomputes over the (rewritten) timestamp:
    const attackerAttempt = createHmac('sha256', secret)
      .update(`${fakeTs}.${body}`, 'utf8')
      .digest('hex');
    expect(signature.endsWith(`,v1=${attackerAttempt}`)).toBe(false);
  });
});
