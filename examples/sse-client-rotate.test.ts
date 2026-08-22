/**
 * Tests for examples/sse-client.ts's TriologueAgent.rotateToken() 501
 * handling.
 *
 * The gateway's POST /byoa/sse/tokens/rotate route currently answers 501
 * (see src/byoa-sse.ts and BYOA.md's Token Rotation section): the gateway
 * has no durable per-token store, so rotateToken() must surface that as
 * TokenRotationNotSupportedError instead of trying to read a `token` field
 * off a body that has none.
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
