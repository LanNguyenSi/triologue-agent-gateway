/**
 * Tests for src/auth.ts
 *
 * Covers: buildTokenIndex, authenticateToken, getWebhookAgents,
 * getAgentByUsername, syncFromApi (malformed data rejection), rotateToken
 * (new-token mint, grace-window expiry, permanent post-grace block even
 * against a re-synced upstream, idempotent replay, and a two-hop rotation
 * chain).
 * Mutation guards are listed inline at each critical branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRawAgent(overrides: Record<string, unknown> = {}) {
  return {
    token: 'byoa_test_token_001',
    name: 'TestBot',
    username: 'testbot',
    userId: 'user-001',
    mentionKey: 'testbot',
    webhookUrl: 'https://example.com/hook',
    webhookSecret: 'secret-abc',
    trustLevel: 'standard' as const,
    emoji: '🤖',
    color: '#ff0000',
    connectionType: 'both' as const,
    receiveMode: 'mentions' as const,
    delivery: 'webhook' as const,
    ...overrides,
  };
}

import {
  authenticateToken,
  getWebhookAgents,
  getAgentByUsername,
  syncFromApi,
  loadAgents,
  buildTokenIndex,
  rotateToken,
  TOKEN_ROTATE_GRACE_MS,
} from '../auth.js';

// ── State reset helpers ──────────────────────────────────────────────────────

/**
 * Populate auth state via syncFromApi with a controlled fetch mock so we can
 * test buildTokenIndex / authenticateToken without touching disk.
 */
async function seedAgents(rawAgents: ReturnType<typeof makeRawAgent>[]): Promise<void> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ agents: rawAgents, generatedAt: new Date().toISOString() }),
  } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  await syncFromApi();
  vi.unstubAllGlobals();
}

/** Clear all agents so subsequent tests start from a blank slate. */
async function clearAgents(): Promise<void> {
  await seedAgents([]);
}

beforeEach(async () => {
  await clearAgents();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── authenticateToken + buildTokenIndex ──────────────────────────────────────

describe('authenticateToken + buildTokenIndex', () => {
  it('returns null when token map is empty', () => {
    expect(authenticateToken('byoa_unknown')).toBeNull();
  });

  it('maps a byoa_ token to the correct AgentInfo identity', async () => {
    const raw = makeRawAgent({ token: 'byoa_exact_token' });
    await seedAgents([raw]);

    const info = authenticateToken('byoa_exact_token');
    expect(info).not.toBeNull();
    expect(info!.userId).toBe('user-001');
    expect(info!.username).toBe('testbot');
    expect(info!.name).toBe('TestBot');
    expect(info!.mentionKey).toBe('testbot');
    expect(info!.trustLevel).toBe('standard');
    expect(info!.emoji).toBe('🤖');
    expect(info!.webhookUrl).toBe('https://example.com/hook');
    expect(info!.webhookSecret).toBe('secret-abc');
    expect(info!.color).toBe('#ff0000');
  });

  it('returns null for an unrecognised token', async () => {
    await seedAgents([makeRawAgent({ token: 'byoa_known' })]);
    expect(authenticateToken('byoa_other')).toBeNull();
  });

  it('elevated trust level is preserved correctly', async () => {
    await seedAgents([makeRawAgent({ token: 'byoa_elev', trustLevel: 'elevated' })]);
    const info = authenticateToken('byoa_elev');
    expect(info!.trustLevel).toBe('elevated');
  });

  it('applies default connectionType "both" when field is absent', async () => {
    const raw = makeRawAgent({ token: 'byoa_defaults' });
    delete (raw as any).connectionType;
    await seedAgents([raw]);

    const info = authenticateToken('byoa_defaults');
    // MUTATION GUARD: change `?? 'both'` to `?? 'webhook'` → this test fails
    expect(info!.connectionType).toBe('both');
  });

  it('applies default receiveMode "mentions" when field is absent', async () => {
    const raw = makeRawAgent({ token: 'byoa_recv_def' });
    delete (raw as any).receiveMode;
    await seedAgents([raw]);

    const info = authenticateToken('byoa_recv_def');
    expect(info!.receiveMode).toBe('mentions');
  });

  it('applies default delivery "webhook" when field is absent', async () => {
    const raw = makeRawAgent({ token: 'byoa_del_def' });
    delete (raw as any).delivery;
    await seedAgents([raw]);

    const info = authenticateToken('byoa_del_def');
    expect(info!.delivery).toBe('webhook');
  });

  it('coerces null webhookUrl/webhookSecret/color when absent', async () => {
    const raw = makeRawAgent({ token: 'byoa_nulls' });
    delete (raw as any).webhookUrl;
    delete (raw as any).webhookSecret;
    delete (raw as any).color;
    await seedAgents([raw]);

    const info = authenticateToken('byoa_nulls');
    expect(info!.webhookUrl).toBeNull();
    expect(info!.webhookSecret).toBeNull();
    expect(info!.color).toBeNull();
  });

  it('handles token collision — last writer wins (second agent overwrites first)', async () => {
    const firstAgent = makeRawAgent({ token: 'byoa_shared', userId: 'user-A', name: 'AgentA' });
    const secondAgent = makeRawAgent({ token: 'byoa_shared', userId: 'user-B', name: 'AgentB' });
    await seedAgents([firstAgent, secondAgent]);

    const info = authenticateToken('byoa_shared');
    // MUTATION GUARD: if the collision logic changes direction, this flips
    expect(info!.name).toBe('AgentB');
    expect(info!.userId).toBe('user-B');
  });
});

// ── syncFromApi — malformed data rejection ───────────────────────────────────

describe('syncFromApi — malformed / invalid API responses', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when the API returns a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ agents: [makeRawAgent()] }),
    } as unknown as Response));

    const ok = await syncFromApi();
    // MUTATION GUARD: remove `if (!res.ok)` → returns true; this test fails
    expect(ok).toBe(false);
  });

  it('returns false when response body has no "agents" key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ something_else: [] }),
    } as unknown as Response));

    const ok = await syncFromApi();
    // MUTATION GUARD: remove the `!data.agents` guard → returns true; fails
    expect(ok).toBe(false);
  });

  it('returns false when "agents" is not an array (string)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ agents: 'not-an-array' }),
    } as unknown as Response));

    const ok = await syncFromApi();
    // MUTATION GUARD: remove `!Array.isArray(data.agents)` → returns true; fails
    expect(ok).toBe(false);
  });

  it('returns false when "agents" is an object, not an array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ agents: { length: 0 } }),
    } as unknown as Response));

    const ok = await syncFromApi();
    expect(ok).toBe(false);
  });

  it('returns false and does not throw when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

    const ok = await syncFromApi();
    expect(ok).toBe(false);
  });

  it('returns true and updates agents when API response is valid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ agents: [makeRawAgent({ token: 'byoa_valid' })], generatedAt: '' }),
    } as unknown as Response));

    const ok = await syncFromApi();
    expect(ok).toBe(true);
    // Verify the agents were actually indexed
    expect(authenticateToken('byoa_valid')).not.toBeNull();
  });
});

// ── getWebhookAgents ─────────────────────────────────────────────────────────

describe('getWebhookAgents', () => {
  it('returns empty array when no agents are loaded', () => {
    expect(getWebhookAgents()).toEqual([]);
  });

  it('includes agents with connectionType "webhook" that have a webhookUrl', async () => {
    await seedAgents([
      makeRawAgent({ token: 'byoa_wh', connectionType: 'webhook', webhookUrl: 'https://hook.test/a' }),
    ]);
    const agents = getWebhookAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].connectionType).toBe('webhook');
  });

  it('includes agents with connectionType "both" that have a webhookUrl', async () => {
    await seedAgents([
      makeRawAgent({ token: 'byoa_both', connectionType: 'both', webhookUrl: 'https://hook.test/b' }),
    ]);
    const agents = getWebhookAgents();
    expect(agents.length).toBe(1);
  });

  it('excludes agents with connectionType "websocket"', async () => {
    await seedAgents([
      makeRawAgent({ token: 'byoa_ws_only', connectionType: 'websocket', webhookUrl: 'https://hook.test/c' }),
    ]);
    // MUTATION GUARD: remove the connectionType check → includes ws agents; fails
    expect(getWebhookAgents()).toHaveLength(0);
  });

  it('excludes agents with no webhookUrl and delivery != openclaw-inject', async () => {
    await seedAgents([
      makeRawAgent({ token: 'byoa_no_url', connectionType: 'webhook', webhookUrl: undefined as any, delivery: 'webhook' }),
    ]);
    // MUTATION GUARD: remove the webhookUrl || delivery=openclaw-inject check → includes; fails
    expect(getWebhookAgents()).toHaveLength(0);
  });

  it('includes openclaw-inject agents even without a webhookUrl', async () => {
    const raw = makeRawAgent({ token: 'byoa_oc', connectionType: 'both', delivery: 'openclaw-inject' });
    delete (raw as any).webhookUrl;
    await seedAgents([raw]);

    const agents = getWebhookAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].delivery).toBe('openclaw-inject');
  });
});

// ── getAgentByUsername ───────────────────────────────────────────────────────

describe('getAgentByUsername', () => {
  beforeEach(async () => {
    await seedAgents([
      makeRawAgent({ token: 'byoa_alice', username: 'alice', userId: 'u-alice' }),
      makeRawAgent({ token: 'byoa_bob', username: 'bob', userId: 'u-bob' }),
    ]);
  });

  it('finds an agent by exact username', () => {
    const agent = getAgentByUsername('alice');
    expect(agent).not.toBeNull();
    expect(agent!.userId).toBe('u-alice');
  });

  it('finds a different agent by username', () => {
    const agent = getAgentByUsername('bob');
    expect(agent!.userId).toBe('u-bob');
  });

  it('returns null for an unknown username', () => {
    // MUTATION GUARD: if username check is removed → returns a random agent; fails
    expect(getAgentByUsername('nobody')).toBeNull();
  });

  it('returns null when token map is empty', async () => {
    await clearAgents();
    expect(getAgentByUsername('alice')).toBeNull();
  });
});

// ── loadAgents (file fallback) ───────────────────────────────────────────────

describe('loadAgents', () => {
  it('does not throw when the agents file is missing or unreadable', () => {
    // AGENTS_CONFIG is not set, so the default-argument path falls back to
    // ./agents.json, which does not exist in the test environment
    // (gitignored). loadAgents catches the ENOENT and leaves agents empty -
    // it must NOT throw.
    expect(() => loadAgents()).not.toThrow();
  });

  it('does not throw for an explicit nonexistent path (ENOENT branch)', () => {
    expect(() => loadAgents('/nonexistent/dir/does-not-exist.json')).not.toThrow();
  });

  it('gracefully handles corrupt JSON in the agents file and empties the agent list', async () => {
    // Seed a known, authenticatable agent first so we can observe loadAgents'
    // catch branch actually resetting the internal `agents` array to [].
    await seedAgents([makeRawAgent({ token: 'byoa_pre_corrupt' })]);
    expect(authenticateToken('byoa_pre_corrupt')).not.toBeNull();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-corrupt-json-'));
    const corruptFile = path.join(tmpDir, 'agents.json');
    fs.writeFileSync(corruptFile, '{ this is not valid json');

    try {
      // MUTATION GUARD: this real corrupt-JSON temp file drives the actual
      // JSON.parse failure branch (not just an ENOENT read failure).
      expect(() => loadAgents(corruptFile)).not.toThrow();
      buildTokenIndex();
      // MUTATION GUARD: if the catch block stopped resetting `agents = []`,
      // the previously-seeded token would still authenticate here.
      expect(authenticateToken('byoa_pre_corrupt')).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads agents from a real, valid JSON file via the injectable path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-valid-json-'));
    const validFile = path.join(tmpDir, 'agents.json');
    fs.writeFileSync(validFile, JSON.stringify([makeRawAgent({ token: 'byoa_from_file' })]));

    try {
      loadAgents(validFile);
      buildTokenIndex();
      expect(authenticateToken('byoa_from_file')).not.toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── rotateToken / authenticateToken grace window ─────────────────────────────

describe('rotateToken', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for a token that was never valid', async () => {
    await clearAgents();
    expect(rotateToken('byoa_rot_unknown')).toBeNull();
  });

  it('mints a new token that authenticates, while the old token also still authenticates immediately after rotation', async () => {
    await seedAgents([makeRawAgent({ token: 'byoa_rot_basic', userId: 'user-rot-basic' })]);

    const result = rotateToken('byoa_rot_basic');
    expect(result).not.toBeNull();
    expect(result!.token).not.toBe('byoa_rot_basic');
    expect(result!.agent.userId).toBe('user-rot-basic');

    // New token valid immediately.
    expect(authenticateToken(result!.token)!.userId).toBe('user-rot-basic');
    // Old token still valid — inside the grace window.
    expect(authenticateToken('byoa_rot_basic')!.userId).toBe('user-rot-basic');
  });

  it('rejects the old token once the grace window elapses, new token stays valid (MUTATION GUARD: grace expiry)', async () => {
    vi.useFakeTimers();
    try {
      await seedAgents([makeRawAgent({ token: 'byoa_rot_grace', userId: 'user-rot-grace' })]);

      const result = rotateToken('byoa_rot_grace')!;
      expect(result).not.toBeNull();

      // Still inside the grace window: old token authenticates.
      vi.advanceTimersByTime(TOKEN_ROTATE_GRACE_MS - 1);
      expect(authenticateToken('byoa_rot_grace')).not.toBeNull();

      // Grace window has now elapsed: old token is rejected.
      vi.advanceTimersByTime(2);
      // MUTATION GUARD: if the `Date.now() < grace.expiresAt` check is
      // flipped or removed, this stays non-null and the test fails.
      expect(authenticateToken('byoa_rot_grace')).toBeNull();

      // New token remains valid throughout.
      expect(authenticateToken(result.token)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('permanently blocks a rotated-away token even if the upstream sync re-adds it (MUTATION GUARD: rotatedAwayTokens)', async () => {
    vi.useFakeTimers();
    try {
      await seedAgents([makeRawAgent({ token: 'byoa_rot_perm', userId: 'user-rot-perm' })]);
      rotateToken('byoa_rot_perm');

      vi.advanceTimersByTime(TOKEN_ROTATE_GRACE_MS + 1);
      expect(authenticateToken('byoa_rot_perm')).toBeNull();

      // Simulate the next periodic upstream resync bringing the same
      // (now rotated-away) token back into tokenMap, as it would if
      // Triologue's own DB still considers it the agent's current token.
      await seedAgents([makeRawAgent({ token: 'byoa_rot_perm', userId: 'user-rot-perm' })]);

      // MUTATION GUARD: without the rotatedAwayTokens block, this would
      // fall through to tokenMap.get() and authenticate again.
      expect(authenticateToken('byoa_rot_perm')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is idempotent within the grace window: rotating an already-rotated-away (but still-grace) token returns the same new token', async () => {
    vi.useFakeTimers();
    try {
      await seedAgents([makeRawAgent({ token: 'byoa_rot_idem', userId: 'user-rot-idem' })]);

      const first = rotateToken('byoa_rot_idem')!;
      vi.advanceTimersByTime(1000);
      const second = rotateToken('byoa_rot_idem')!;

      // MUTATION GUARD: if idempotent replay were removed, `second.token`
      // would differ from `first.token` and `oldTokenExpiresAt` would be
      // pushed forward instead of staying put.
      expect(second.token).toBe(first.token);
      expect(second.oldTokenExpiresAt).toBe(first.oldTokenExpiresAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles a rotation chain correctly: an old-old token stays valid until its own original grace elapses, unaffected by a later rotation', async () => {
    vi.useFakeTimers();
    try {
      await seedAgents([makeRawAgent({ token: 'byoa_rot_chain_a', userId: 'user-rot-chain' })]);

      // Rotate A -> B.
      const first = rotateToken('byoa_rot_chain_a')!;
      const tokenB = first.token;

      // Advance partway into A's grace window, then rotate B -> C using the
      // *current* token (not A), which is a fresh rotation with its own
      // fresh grace window for B.
      vi.advanceTimersByTime(TOKEN_ROTATE_GRACE_MS / 2);
      const second = rotateToken(tokenB)!;
      const tokenC = second.token;

      // All three should currently authenticate: A and B are both within
      // their own (independent) grace windows, C is the active token.
      expect(authenticateToken('byoa_rot_chain_a')).not.toBeNull();
      expect(authenticateToken(tokenB)).not.toBeNull();
      expect(authenticateToken(tokenC)).not.toBeNull();

      // Advance past A's original grace window (elapsed at
      // TOKEN_ROTATE_GRACE_MS from rotation of A, i.e. GRACE_MS/2 more from
      // here) but not yet past B's (whose grace started at GRACE_MS/2 and
      // extends to GRACE_MS/2 + TOKEN_ROTATE_GRACE_MS).
      vi.advanceTimersByTime(TOKEN_ROTATE_GRACE_MS / 2 + 1);

      // Old-old token A: invalid now that its own grace has elapsed.
      expect(authenticateToken('byoa_rot_chain_a')).toBeNull();
      // B: still inside its own, later-starting grace window.
      expect(authenticateToken(tokenB)).not.toBeNull();
      // C: the active token, always valid.
      expect(authenticateToken(tokenC)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
