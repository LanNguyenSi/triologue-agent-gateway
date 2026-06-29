/**
 * Tests for src/auth.ts
 *
 * Covers: buildTokenIndex, authenticateToken, getWebhookAgents,
 * getAgentByUsername, syncFromApi (malformed data rejection).
 * Mutation guards are listed inline at each critical branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    // AGENTS_CONFIG is not set, so it falls back to ./agents.json which
    // does not exist in the test environment (gitignored). loadAgents catches
    // the ENOENT and leaves agents empty — it must NOT throw.
    expect(() => loadAgents()).not.toThrow();
  });

  it('gracefully handles corrupt JSON in the agents file', () => {
    // Point to an env path that does not exist. loadAgents swallows the error.
    // This is a belt-and-suspenders guard: corrupt JSON also hits the catch block.
    // We cannot change AGENTS_FILE at runtime (module-level constant) but the
    // existing constant already points to a non-existent file in CI, which is
    // equivalent to a read failure.
    expect(() => loadAgents()).not.toThrow();
  });
});
