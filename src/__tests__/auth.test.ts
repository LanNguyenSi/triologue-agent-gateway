/**
 * Tests for src/auth.ts
 *
 * Covers: buildTokenIndex, authenticateToken, getWebhookAgents,
 * getAgentByUsername, syncFromApi (malformed data rejection).
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
  authenticateCurrentToken,
  rotateTokenUpstream,
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


// ── Rotation grace window ────────────────────────────────────────────────────

describe('previousToken grace window', () => {
  const T0 = Date.parse('2030-01-01T00:00:00.000Z');
  const expires = new Date(T0 + 300_000).toISOString();

  async function seedRotated(extra: Record<string, unknown> = {}) {
    await seedAgents([
      makeRawAgent({ token: 'byoa_new', previousToken: 'byoa_old', previousTokenExpiresAt: expires, ...extra }),
    ]);
  }

  it('accepts the previous token before the expiry and maps it to the same agent', async () => {
    await seedRotated();
    expect(authenticateToken('byoa_old', T0)?.userId).toBe('user-001');
    expect(authenticateToken('byoa_new', T0)?.userId).toBe('user-001');
  });

  it('rejects the previous token at the exact expiry instant and after', async () => {
    await seedRotated();
    expect(authenticateToken('byoa_old', T0 + 300_000 - 1)).not.toBeNull();
    expect(authenticateToken('byoa_old', T0 + 300_000)).toBeNull();
    expect(authenticateToken('byoa_old', T0 + 400_000)).toBeNull();
  });

  it('ignores a previous token with a missing, null or unparseable expiry', async () => {
    await seedRotated({ previousTokenExpiresAt: null });
    expect(authenticateToken('byoa_old', T0)).toBeNull();
    await seedRotated({ previousTokenExpiresAt: 'not-a-date' });
    expect(authenticateToken('byoa_old', T0)).toBeNull();
    await seedRotated({ previousTokenExpiresAt: undefined });
    expect(authenticateToken('byoa_old', T0)).toBeNull();
  });

  it('drops the previous token on the next sync that no longer reports it', async () => {
    await seedRotated();
    expect(authenticateToken('byoa_old', T0)).not.toBeNull();
    await seedAgents([makeRawAgent({ token: 'byoa_new', previousToken: null, previousTokenExpiresAt: null })]);
    expect(authenticateToken('byoa_old', T0)).toBeNull();
  });

  it('authenticateCurrentToken accepts only the current token, never the grace token', async () => {
    await seedRotated();
    expect(authenticateCurrentToken('byoa_new')?.userId).toBe('user-001');
    expect(authenticateCurrentToken('byoa_old')).toBeNull();
  });

  it('pins lookup order: a current token is matched before any grace entry', async () => {
    await seedAgents([
      makeRawAgent({ token: 'byoa_a', userId: 'user-a', username: 'a', mentionKey: 'a', previousToken: 'byoa_b', previousTokenExpiresAt: expires }),
      makeRawAgent({ token: 'byoa_b', userId: 'user-b', username: 'b', mentionKey: 'b' }),
    ]);
    expect(authenticateToken('byoa_b', T0)?.userId).toBe('user-b');
  });
});

// ── Upstream rotate ──────────────────────────────────────────────────────────

describe('rotateTokenUpstream', () => {
  // Each test uses its own user id: the AgentToken row id is cached per agent.
  const agentFor = (userId: string) => ({
    id: userId, name: 'TestBot', userId, username: 'testbot', mentionKey: 'testbot',
    webhookUrl: null, webhookSecret: null, trustLevel: 'standard' as const, emoji: '🤖', color: null,
    connectionType: 'both' as const, receiveMode: 'mentions' as const, delivery: 'webhook' as const,
  });
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const fail = (status: number) => ({ ok: false, status, json: async () => ({ error: 'secret detail' }) }) as unknown as Response;
  const ctx = (userId: string) => ok({ agent: { id: `row-${userId}`, userId } });
  const rotated = ok({
    agentId: 'row-1', token: 'byoa_fresh', previousTokenExpiresAt: '2030-01-01T00:05:00.000Z', graceSeconds: 300,
  });

  afterEach(() => vi.unstubAllGlobals());

  async function seedCurrent(userId: string) {
    await seedAgents([makeRawAgent({ token: 'byoa_cur', userId })]);
  }

  it('sends the gateway token as Authorization and the current token as X-Agent-Token, then applies the new token locally', async () => {
    await seedCurrent('user-r1');
    const fetchMock = vi.fn().mockResolvedValueOnce(ctx('user-r1')).mockResolvedValueOnce(rotated);
    vi.stubGlobal('fetch', fetchMock);

    const r = await rotateTokenUpstream(agentFor('user-r1'), 'byoa_cur');

    expect(r).toEqual({ ok: true, token: 'byoa_fresh', previousTokenExpiresAt: '2030-01-01T00:05:00.000Z', graceSeconds: 300 });
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toMatch(/\/api\/agents\/row-user-r1\/token\/rotate$/);
    expect(init.method).toBe('POST');
    expect(init.headers['X-Agent-Token']).toBe('byoa_cur');
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(authenticateCurrentToken('byoa_fresh')?.userId).toBe('user-r1');
    expect(authenticateCurrentToken('byoa_cur')).toBeNull();
    expect(authenticateToken('byoa_cur', Date.parse('2030-01-01T00:00:00.000Z'))?.userId).toBe('user-r1');
  });

  it.each([[403, 'forbidden'], [404, 'agent_not_found'], [409, 'rotation_conflict'], [500, 'upstream_error']])(
    'maps upstream %i to a fixed code without echoing the body',
    async (status, code) => {
      const uid = `user-s${status}`;
      await seedCurrent(uid);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ctx(uid)).mockResolvedValueOnce(fail(status)));
      const r = await rotateTokenUpstream(agentFor(uid), 'byoa_cur');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe(code);
        expect(r.status).toBe(status === 500 ? 502 : status);
        expect(JSON.stringify(r)).not.toContain('secret detail');
      }
    },
  );

  it('rejects an upstream token without the byoa_ prefix and leaves the token unchanged', async () => {
    await seedCurrent('user-m1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ctx('user-m1')).mockResolvedValueOnce(ok({ token: 'not-byoa', previousTokenExpiresAt: '2030-01-01T00:05:00.000Z' })));
    const r = await rotateTokenUpstream(agentFor('user-m1'), 'byoa_cur');
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(authenticateCurrentToken('byoa_cur')?.userId).toBe('user-m1');
    expect(authenticateCurrentToken('not-byoa')).toBeNull();
  });

  it('rejects a valid upstream token with an invalid expiry date and leaves the token unchanged', async () => {
    await seedCurrent('user-m2');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ctx('user-m2')).mockResolvedValueOnce(ok({ token: 'byoa_fresh', previousTokenExpiresAt: 'x' })));
    const r = await rotateTokenUpstream(agentFor('user-m2'), 'byoa_cur');
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(authenticateCurrentToken('byoa_cur')?.userId).toBe('user-m2');
    expect(authenticateCurrentToken('byoa_fresh')).toBeNull();
  });

  it('answers 502 and posts no rotate request when /me/context reports a different user', async () => {
    await seedCurrent('user-x1');
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ agent: { id: 'row-other', userId: 'someone-else' } }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await rotateTokenUpstream(agentFor('user-x1'), 'byoa_cur');
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authenticateCurrentToken('byoa_cur')?.userId).toBe('user-x1');
  });

  it('caches the agent row id: a second rotation skips /me/context and posts to the cached id', async () => {
    await seedCurrent('user-c1');
    const first = ok({ agentId: 'row-user-c1', token: 'byoa_second', previousTokenExpiresAt: '2030-01-01T00:05:00.000Z', graceSeconds: 300 });
    const second = ok({ agentId: 'row-user-c1', token: 'byoa_third', previousTokenExpiresAt: '2030-01-01T00:10:00.000Z', graceSeconds: 300 });
    const fetchMock = vi.fn().mockResolvedValueOnce(ctx('user-c1')).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    vi.stubGlobal('fetch', fetchMock);

    expect(await rotateTokenUpstream(agentFor('user-c1'), 'byoa_cur')).toMatchObject({ ok: true, token: 'byoa_second' });
    expect(await rotateTokenUpstream(agentFor('user-c1'), 'byoa_second')).toMatchObject({ ok: true, token: 'byoa_third' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.filter(u => u.endsWith('/api/agents/me/context'))).toHaveLength(1);
    expect(urls[2]).toMatch(/\/api\/agents\/row-user-c1\/token\/rotate$/);
  });

  it('drops the cached row id on an upstream 404 so the retry re-resolves via /me/context and succeeds', async () => {
    await seedCurrent('user-k1');
    const stale = ok({ agentId: 'row-user-k1', token: 'byoa_second', previousTokenExpiresAt: '2030-01-01T00:05:00.000Z', graceSeconds: 300 });
    const fresh = ok({ agentId: 'row-new', token: 'byoa_third', previousTokenExpiresAt: '2030-01-01T00:10:00.000Z', graceSeconds: 300 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ctx('user-k1'))      // resolve row id
      .mockResolvedValueOnce(stale)               // first rotation succeeds, id cached
      .mockResolvedValueOnce(fail(404))           // row replaced upstream
      .mockResolvedValueOnce(ok({ agent: { id: 'row-new', userId: 'user-k1' } })) // re-resolve
      .mockResolvedValueOnce(fresh);
    vi.stubGlobal('fetch', fetchMock);

    expect(await rotateTokenUpstream(agentFor('user-k1'), 'byoa_cur')).toMatchObject({ ok: true });
    expect(await rotateTokenUpstream(agentFor('user-k1'), 'byoa_second')).toMatchObject({ ok: false, status: 404 });
    expect(await rotateTokenUpstream(agentFor('user-k1'), 'byoa_second')).toMatchObject({ ok: true, token: 'byoa_third' });

    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.filter(u => u.endsWith('/api/agents/me/context'))).toHaveLength(2);
    expect(urls[4]).toMatch(/\/api\/agents\/row-new\/token\/rotate$/);
  });

  it('returns 502 when the agent row id cannot be resolved', async () => {
    await seedCurrent('user-n1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(401)));
    const r = await rotateTokenUpstream(agentFor('user-n1'), 'byoa_cur');
    expect(r).toMatchObject({ ok: false, status: 502 });
  });

  it('returns 502 when fetch throws', async () => {
    await seedCurrent('user-t1');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const r = await rotateTokenUpstream(agentFor('user-t1'), 'byoa_cur');
    expect(r).toMatchObject({ ok: false, status: 502 });
  });
});
