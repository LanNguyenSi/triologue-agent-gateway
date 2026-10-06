/**
 * Tests for examples/sse-client.ts's TriologueAgent.rotateToken().
 *
 * The gateway's POST /byoa/sse/tokens/rotate route answers 200 with the new
 * token for the current token and 403 `stale_token` for an already replaced
 * one (see BYOA.md's Token Rotation section). rotateToken() hands a 200's
 * token to onTokenRotated so the caller can persist it, and surfaces a 403 as
 * a plain error without touching the configured token. The 501 handling below
 * only covers older gateways that predate upstream-backed rotation: there
 * rotateToken() must throw TokenRotationNotSupportedError instead of reading
 * a `token` field off a body that has none.
 *
 * Importing examples/sse-client.ts must not run main() (it reads
 * process.env.BYOA_TOKEN! and connects to a real gateway) - the module's
 * process.argv[1]-realpath entrypoint guard at the bottom of that file is
 * what makes that safe; if that guard regressed, importing this module
 * from a test process (argv[1] is vitest's own entry, never
 * sse-client.ts) would throw instead of loading cleanly.
 *
 * No network access: fetch is stubbed for every case below.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TriologueAgent,
  TokenRotationNotSupportedError,
  parseRotateIntervalMs,
  MAX_TIMER_MS,
} from './sse-client.js';

function makeAgent(token = 'byoa_test_token') {
  return new TriologueAgent({
    token,
    gatewayUrl: 'https://gateway.example',
    onMessage: async () => null,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TriologueAgent.rotateToken() - 501 handling', () => {
  it('throws TokenRotationNotSupportedError on a 501 response and leaves the configured token untouched', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 501,
      json: async () => ({ error: 'not_implemented' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const agent = makeAgent('byoa_original');

    await expect(agent.rotateToken()).rejects.toBeInstanceOf(TokenRotationNotSupportedError);

    // MUTATION GUARD: if the 501 check were dropped, this would call
    // `${gatewayUrl}/byoa/sse/tokens/rotate` and then try `await
    // response.json()` on a body without a `token` field, replacing the
    // agent's real token with `undefined` instead of throwing.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example/byoa/sse/tokens/rotate',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer byoa_original' },
      })
    );
  });

  it('still throws a plain Error for a non-501 failure (MUTATION GUARD: the 501 branch must not swallow other statuses)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 } as unknown as Response)
    );

    const agent = makeAgent();

    let caught: unknown;
    try {
      await agent.rotateToken();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TokenRotationNotSupportedError);
    expect((caught as Error).message).toBe('Token rotation failed: 500');
  });
});

describe('TriologueAgent.rotateToken() - 200 and stale_token flow', () => {
  it('passes the new token to onTokenRotated on a 200 and reconnects with it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: 'byoa_new', previousTokenExpiresAt: '2030-01-01T00:05:00.000Z', graceSeconds: 300 }),
      } as unknown as Response)
      // The reconnect's stream request: answer 401 so connect() returns at once.
      .mockResolvedValueOnce({ ok: false, status: 401 } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const stored: string[] = [];
    const agent = new TriologueAgent({
      token: 'byoa_original',
      gatewayUrl: 'https://gateway.example',
      onMessage: async () => null,
      onTokenRotated: (t) => {
        stored.push(t);
      },
    });

    await expect(agent.rotateToken()).resolves.toBe('byoa_new');
    expect(stored).toEqual(['byoa_new']);
    const streamInit = fetchMock.mock.calls[1][1] as { headers: Record<string, string> };
    expect(streamInit.headers.Authorization).toBe('Bearer byoa_new');
  });

  it('throws a plain Error on 403 stale_token and never calls onTokenRotated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'stale_token' }) } as unknown as Response)
    );
    const onTokenRotated = vi.fn();
    const agent = new TriologueAgent({
      token: 'byoa_old',
      gatewayUrl: 'https://gateway.example',
      onMessage: async () => null,
      onTokenRotated,
    });

    const err = await agent.rotateToken().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TokenRotationNotSupportedError);
    expect((err as Error).message).toBe('Token rotation failed: 403');
    expect(onTokenRotated).not.toHaveBeenCalled();
  });
});

describe('parseRotateIntervalMs()', () => {
  afterEach(() => vi.restoreAllMocks());

  it('disables rotation for unset, zero, negative and non-numeric values', () => {
    for (const raw of [undefined, '', '0', '-5', 'abc', 'Infinity']) {
      expect(parseRotateIntervalMs(raw)).toBeNull();
    }
  });

  it('converts hours to milliseconds below the timer limit', () => {
    expect(parseRotateIntervalMs('24')).toBe(24 * 3_600_000);
    expect(parseRotateIntervalMs('0.5')).toBe(1_800_000);
  });

  it('clamps a value above the setInterval limit instead of overflowing, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 600 h = 2.16e9 ms > 2^31-1, which setInterval would turn into a 1 ms loop.
    expect(parseRotateIntervalMs('600')).toBe(MAX_TIMER_MS);
    expect(parseRotateIntervalMs('1000000')).toBe(MAX_TIMER_MS);
    expect(warn).toHaveBeenCalled();
    // Exactly at the limit is not clamped.
    expect(parseRotateIntervalMs(String(MAX_TIMER_MS / 3_600_000))).toBe(MAX_TIMER_MS);
  });
});
