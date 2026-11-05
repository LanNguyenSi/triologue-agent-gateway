/**
 * Tests for src/sessions.ts: the SessionRegistry against an in-memory Redis
 * stand-in with a test-controlled clock, and the /byoa/sessions router on an
 * ephemeral express server with `authenticateToken` mocked.
 *
 * Mutation guards (each named test fails if the guard is dropped):
 *   M-ttl: connect/heartbeat/presence stop calling expire -> "expires without
 *     heartbeat" and "heartbeat extends" fail (a session would live forever
 *     or die at once)
 *   M-rebind: remove/expire stop dropping the reverse bindings ->
 *     "remove drops bindings" and "sweep" fail (a dead session stays routable)
 *   M-own-sessions: the router stops scoping by the token's agent ->
 *     "another agent cannot see or touch" fails
 *   M-offline-event: expire/remove stop emitting presence offline ->
 *     the event assertions fail
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentInfo } from '../types.js';

const authenticateTokenMock = vi.fn<(token: string) => AgentInfo | null>();
vi.mock('../auth', () => ({
  authenticateToken: (token: string) => authenticateTokenMock(token),
}));

vi.mock('../metrics', () => ({
  metrics: { recordAuthFailure: vi.fn() },
}));

const {
  SessionRegistry,
  createSessionsRouter,
  SESSION_TTL_SECONDS,
  HEARTBEAT_SECONDS,
} = await import('../sessions.js');
type Registry = InstanceType<typeof SessionRegistry>;
type PresenceEvent = import('../sessions.js').PresenceEvent;
type SessionStore = import('../sessions.js').SessionStore;

// ── In-memory Redis with a controllable clock ─────────────────────────────────

class FakeRedis {
  now = 1_000_000;
  private hashes = new Map<string, Record<string, string>>();
  private sets = new Map<string, Set<string>>();
  private expiries = new Map<string, number>();

  tick(ms: number): void {
    this.now += ms;
    for (const key of [...this.expiries.keys()]) this.reap(key);
  }

  private reap(key: string): void {
    const at = this.expiries.get(key);
    if (at !== undefined && at <= this.now) {
      this.hashes.delete(key);
      this.sets.delete(key);
      this.expiries.delete(key);
    }
  }

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    this.reap(key);
    const h = this.hashes.get(key) ?? {};
    Object.assign(h, fields);
    this.hashes.set(key, h);
    return Object.keys(fields).length;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.reap(key);
    return { ...(this.hashes.get(key) ?? {}) };
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.reap(key);
    if (!this.hashes.has(key) && !this.sets.has(key)) return 0;
    this.expiries.set(key, this.now + seconds * 1000);
    return 1;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    this.reap(key);
    const s = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) if (!s.has(m)) { s.add(m); added += 1; }
    this.sets.set(key, s);
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    this.reap(key);
    const s = this.sets.get(key);
    if (!s) return 0;
    let removed = 0;
    for (const m of members) if (s.delete(m)) removed += 1;
    if (s.size === 0) this.sets.delete(key);
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    this.reap(key);
    return [...(this.sets.get(key) ?? [])];
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) {
      if (this.hashes.delete(key) || this.sets.delete(key)) n += 1;
      this.expiries.delete(key);
    }
    return n;
  }

  async exists(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) {
      this.reap(key);
      if (this.hashes.has(key) || this.sets.has(key)) n += 1;
    }
    return n;
  }

  /** Test helper: every key currently stored. */
  keys(): string[] {
    return [...new Set([...this.hashes.keys(), ...this.sets.keys()])].sort();
  }
}

function makeRegistry(): { redis: FakeRedis; registry: Registry; events: PresenceEvent[] } {
  const redis = new FakeRedis();
  const registry = new SessionRegistry(redis as unknown as SessionStore, () => redis.now);
  const events: PresenceEvent[] = [];
  registry.on('presence', (e: PresenceEvent) => events.push(e));
  return { redis, registry, events };
}

const connectInput = { runtime: 'claude', host: 'mac-studio-01', cwd: '/projects/evidence-api', project: 'evidence-api' };

// ── Registry ──────────────────────────────────────────────────────────────────

describe('SessionRegistry', () => {
  it('connect registers a session with status online and lists it', async () => {
    const { registry, events } = makeRegistry();

    const session = await registry.connect('agent-a', { ...connectInput, rooms: ['room-1'] });

    expect(session).toMatchObject({
      agentId: 'agent-a', runtime: 'claude', host: 'mac-studio-01', cwd: '/projects/evidence-api',
      project: 'evidence-api', claudeSessionId: null, status: 'online', detail: null,
      rooms: ['room-1'], threads: [],
    });
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await registry.list('agent-a')).toEqual([session]);
    expect(await registry.sessionsForRoom('agent-a', 'room-1')).toEqual([session.sessionId]);
    expect(events).toEqual([expect.objectContaining({ agentId: 'agent-a', sessionId: session.sessionId, status: 'online' })]);
  });

  it('connect with a known sessionId refreshes metadata and keeps startedAt and status', async () => {
    const { redis, registry } = makeRegistry();
    const first = await registry.connect('agent-a', { ...connectInput, sessionId: 'sess-1' });
    await registry.setPresence('agent-a', 'sess-1', 'working', 'npm test');
    redis.tick(10_000);

    const again = await registry.connect('agent-a', { ...connectInput, sessionId: 'sess-1', host: 'mac-studio-02', threads: ['t-1'] });

    expect(again.sessionId).toBe('sess-1');
    expect(again.startedAt).toBe(first.startedAt);
    expect(again.status).toBe('working');
    expect(again.host).toBe('mac-studio-02');
    expect(again.threads).toEqual(['t-1']);
    expect(await registry.list('agent-a')).toHaveLength(1);
  });

  it('expires without heartbeat after SESSION_TTL_SECONDS and announces offline (M-ttl, M-offline-event)', async () => {
    const { redis, registry, events } = makeRegistry();
    await registry.connect('agent-a', { ...connectInput, sessionId: 'sess-1', rooms: ['room-1'] });
    events.length = 0;

    redis.tick(SESSION_TTL_SECONDS * 1000 - 1);
    expect(await registry.list('agent-a')).toHaveLength(1);

    redis.tick(1);
    expect(await registry.list('agent-a')).toEqual([]);
    expect(await registry.sessionsForRoom('agent-a', 'room-1')).toEqual([]);
    expect(events).toEqual([{ agentId: 'agent-a', sessionId: 'sess-1', status: 'offline', detail: null, session: null }]);
    // Nothing of the session is left behind.
    expect(redis.keys().filter((k) => k.includes('sess-1'))).toEqual([]);
  });

  it('heartbeat extends the TTL (M-ttl)', async () => {
    const { redis, registry } = makeRegistry();
    await registry.connect('agent-a', { ...connectInput, sessionId: 'sess-1' });

    redis.tick(80_000);
    expect(await registry.heartbeat('agent-a', 'sess-1')).toBe(true);
    redis.tick(80_000);

    expect(await registry.list('agent-a')).toHaveLength(1);
    expect(await registry.heartbeat('agent-a', 'nope')).toBe(false);
  });

  it('setPresence stores status and detail, counts as a heartbeat and emits the event', async () => {
    const { redis, registry, events } = makeRegistry();
    await registry.connect('agent-a', { ...connectInput, sessionId: 'sess-1' });
    events.length = 0;

    redis.tick(80_000);
    expect(await registry.setPresence('agent-a', 'sess-1', 'waiting_approval', 'Bash: rm -rf dist')).toBe(true);
    redis.tick(80_000);

    const [session] = await registry.list('agent-a');
    expect(session).toMatchObject({ status: 'waiting_approval', detail: 'Bash: rm -rf dist' });
    expect(events).toEqual([expect.objectContaining({ status: 'waiting_approval', detail: 'Bash: rm -rf dist', session: expect.objectContaining({ sessionId: 'sess-1' }) })]);
    expect(await registry.setPresence('agent-a', 'nope', 'online')).toBe(false);
  });

  it('bind and unbind keep both the session view and the reverse lookups in step', async () => {
    const { registry } = makeRegistry();
    await registry.connect('agent-a', { ...connectInput, sessionId: 'sess-1' });
    await registry.connect('agent-a', { ...connectInput, sessionId: 'sess-2' });

    expect(await registry.bind('agent-a', 'sess-1', ['room-1', 'room-2'], ['t-1'])).toEqual({ rooms: ['room-1', 'room-2'], threads: ['t-1'] });
    expect(await registry.bind('agent-a', 'sess-2', ['room-1'], [])).toEqual({ rooms: ['room-1'], threads: [] });
    expect(await registry.sessionsForRoom('agent-a', 'room-1')).toEqual(['sess-1', 'sess-2']);
    expect(await registry.sessionsForThread('agent-a', 't-1')).toEqual(['sess-1']);

    expect(await registry.unbind('agent-a', 'sess-1', ['room-1'], ['t-1'])).toEqual({ rooms: ['room-2'], threads: [] });
    expect(await registry.sessionsForRoom('agent-a', 'room-1')).toEqual(['sess-2']);
    expect(await registry.sessionsForThread('agent-a', 't-1')).toEqual([]);
    expect(await registry.bind('agent-a', 'nope', ['room-1'], [])).toBeNull();
    expect(await registry.unbind('agent-a', 'nope', ['room-1'], [])).toBeNull();
  });

  it('remove drops the session and its bindings and announces offline (M-rebind, M-offline-event)', async () => {
    const { redis, registry, events } = makeRegistry();
    await registry.connect('agent-a', { ...connectInput, sessionId: 'sess-1', rooms: ['room-1'], threads: ['t-1'] });
    events.length = 0;

    expect(await registry.remove('agent-a', 'sess-1')).toBe(true);

    expect(await registry.list('agent-a')).toEqual([]);
    expect(await registry.sessionsForRoom('agent-a', 'room-1')).toEqual([]);
    expect(await registry.sessionsForThread('agent-a', 't-1')).toEqual([]);
    expect(redis.keys().filter((k) => k.includes('sess-1'))).toEqual([]);
    expect(events).toEqual([{ agentId: 'agent-a', sessionId: 'sess-1', status: 'offline', detail: null, session: null }]);
    expect(await registry.remove('agent-a', 'sess-1')).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('sweep drops expired sessions with their bindings and keeps live ones (M-rebind)', async () => {
    const { redis, registry, events } = makeRegistry();
    await registry.connect('agent-a', { ...connectInput, sessionId: 'old', rooms: ['room-1'] });
    await registry.connect('agent-b', { ...connectInput, sessionId: 'gone', rooms: ['room-1'] });
    redis.tick(60_000);
    await registry.connect('agent-a', { ...connectInput, sessionId: 'fresh', rooms: ['room-1'] });
    events.length = 0;

    redis.tick(40_000); // 'old' and 'gone' are past the TTL, 'fresh' is not
    expect(await registry.sweep()).toBe(2);

    expect((await registry.list('agent-a')).map((s) => s.sessionId)).toEqual(['fresh']);
    expect(await registry.list('agent-b')).toEqual([]);
    expect(await registry.sessionsForRoom('agent-a', 'room-1')).toEqual(['fresh']);
    expect(await registry.sessionsForRoom('agent-b', 'room-1')).toEqual([]);
    expect(events.map((e) => `${e.agentId}/${e.sessionId}/${e.status}`).sort()).toEqual(['agent-a/old/offline', 'agent-b/gone/offline']);
    expect(await registry.sweep()).toBe(0);
    // agent-b has no sessions left, so a later sweep no longer visits it.
    expect(await redis.smembers('sessions:agents')).toEqual(['agent-a']);
  });
});

// ── Router ────────────────────────────────────────────────────────────────────

const agentA: AgentInfo = {
  id: 'agent-a', name: 'A', userId: 'agent-a', username: 'agent_a', mentionKey: 'a',
  webhookUrl: null, webhookSecret: null, trustLevel: 'standard', emoji: '🅰️', color: null,
  connectionType: 'both', receiveMode: 'mentions', status: 'active',
};
const agentB: AgentInfo = { ...agentA, id: 'agent-b', userId: 'agent-b', username: 'agent_b', mentionKey: 'b' };
const pendingAgent: AgentInfo = { ...agentA, id: 'agent-p', userId: 'agent-p', status: 'pending' };

let server: http.Server;
let port: number;
let redis: FakeRedis;
let registry: Registry;

beforeAll(async () => {
  redis = new FakeRedis();
  registry = new SessionRegistry(redis as unknown as SessionStore, () => redis.now);
  const app = express();
  app.use(express.json());
  app.use('/byoa/sessions', createSessionsRouter(registry));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  authenticateTokenMock.mockReset().mockImplementation((token) => {
    if (token === 'tok-a') return agentA;
    if (token === 'tok-b') return agentB;
    if (token === 'tok-pending') return pendingAgent;
    return null;
  });
});

function call(
  method: string,
  path: string,
  token: string | null,
  payload?: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path, method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

describe('/byoa/sessions auth', () => {
  it('answers 401 without a bearer, 401 for an unknown token and 403 for an inactive agent', async () => {
    expect((await call('GET', '/byoa/sessions', null)).status).toBe(401);
    expect((await call('GET', '/byoa/sessions', 'nope')).status).toBe(401);
    expect((await call('GET', '/byoa/sessions', 'tok-pending')).status).toBe(403);
  });
});

describe('POST /byoa/sessions/connect', () => {
  it('registers a session and answers the heartbeat contract', async () => {
    const res = await call('POST', '/byoa/sessions/connect', 'tok-a', { ...connectInput, rooms: ['room-1'] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ heartbeatSeconds: HEARTBEAT_SECONDS, ttlSeconds: SESSION_TTL_SECONDS });
    expect(res.body.session).toMatchObject({ sessionId: res.body.sessionId, agentId: 'agent-a', status: 'online', rooms: ['room-1'] });
    expect(res.headers['x-ratelimit-limit']).toBe('120');
  });

  it.each([
    ['runtime missing', { host: 'h', cwd: '/x' }, 'runtime is required'],
    ['cwd empty', { runtime: 'claude', host: 'h', cwd: '  ' }, 'cwd must be a non-empty string of at most 1024 characters'],
    ['sessionId with a slash', { ...connectInput, sessionId: 'a/b' }, 'sessionId must match [A-Za-z0-9_-]{1,64}'],
    ['rooms not an array', { ...connectInput, rooms: 'room-1' }, 'rooms must be an array of at most 50 non-empty strings'],
    ['threads with an empty id', { ...connectInput, threads: [''] }, 'threads must be an array of at most 50 non-empty strings'],
  ])('answers 400 when %s', async (_label, body, error) => {
    const res = await call('POST', '/byoa/sessions/connect', 'tok-a', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
  });
});

describe('session lifecycle over HTTP', () => {
  it('heartbeat, presence, bind, unbind, list and delete for the owning agent', async () => {
    const { body: created } = await call('POST', '/byoa/sessions/connect', 'tok-a', { ...connectInput, sessionId: 'http-1' });
    expect(created.sessionId).toBe('http-1');

    expect((await call('POST', '/byoa/sessions/http-1/heartbeat', 'tok-a')).status).toBe(204);

    expect((await call('POST', '/byoa/sessions/http-1/presence', 'tok-a', { status: 'working', detail: 'tests' })).status).toBe(204);
    expect((await registry.get('agent-a', 'http-1'))).toMatchObject({ status: 'working', detail: 'tests' });
    const bad = await call('POST', '/byoa/sessions/http-1/presence', 'tok-a', { status: 'sleeping' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('status must be one of online, working, waiting_approval, error, offline');

    const bound = await call('POST', '/byoa/sessions/http-1/bind', 'tok-a', { rooms: ['room-1'], threads: ['t-1'] });
    expect(bound.status).toBe(200);
    expect(bound.body).toEqual({ rooms: ['room-1'], threads: ['t-1'] });
    const unbound = await call('DELETE', '/byoa/sessions/http-1/bind', 'tok-a', { threads: ['t-1'] });
    expect(unbound.body).toEqual({ rooms: ['room-1'], threads: [] });

    const list = await call('GET', '/byoa/sessions', 'tok-a');
    expect(list.body.sessions.map((s: { sessionId: string }) => s.sessionId)).toContain('http-1');

    expect((await call('DELETE', '/byoa/sessions/http-1', 'tok-a')).status).toBe(204);
    expect((await call('DELETE', '/byoa/sessions/http-1', 'tok-a')).status).toBe(404);
    expect((await call('POST', '/byoa/sessions/http-1/heartbeat', 'tok-a')).status).toBe(404);
  });

  it('presence offline ends the session', async () => {
    await call('POST', '/byoa/sessions/connect', 'tok-a', { ...connectInput, sessionId: 'http-off' });

    expect((await call('POST', '/byoa/sessions/http-off/presence', 'tok-a', { status: 'offline' })).status).toBe(204);
    expect(await registry.get('agent-a', 'http-off')).toBeNull();
    expect((await call('POST', '/byoa/sessions/http-off/presence', 'tok-a', { status: 'offline' })).status).toBe(404);
  });

  it('another agent cannot see or touch the session (M-own-sessions)', async () => {
    await call('POST', '/byoa/sessions/connect', 'tok-a', { ...connectInput, sessionId: 'http-own' });

    const listB = await call('GET', '/byoa/sessions', 'tok-b');
    expect(listB.body.sessions.map((s: { sessionId: string }) => s.sessionId)).not.toContain('http-own');
    expect((await call('POST', '/byoa/sessions/http-own/heartbeat', 'tok-b')).status).toBe(404);
    expect((await call('POST', '/byoa/sessions/http-own/presence', 'tok-b', { status: 'working' })).status).toBe(404);
    expect((await call('POST', '/byoa/sessions/http-own/bind', 'tok-b', { rooms: ['r'] })).status).toBe(404);
    expect((await call('DELETE', '/byoa/sessions/http-own', 'tok-b')).status).toBe(404);
    expect(await registry.get('agent-a', 'http-own')).not.toBeNull();
  });

  it('answers 404 for a malformed session id without touching the store', async () => {
    const res = await call('POST', '/byoa/sessions/has%20space/heartbeat', 'tok-a');
    expect(res.status).toBe(404);
  });

  it('rate-limits a chatty agent at 120 calls per minute with Retry-After', async () => {
    const chatty: AgentInfo = { ...agentA, id: 'agent-chatty', userId: 'agent-chatty' };
    authenticateTokenMock.mockImplementation((token) => (token === 'tok-chatty' ? chatty : null));
    await call('POST', '/byoa/sessions/connect', 'tok-chatty', { ...connectInput, sessionId: 'chat-1' });

    let last = { status: 0, headers: {} as http.IncomingHttpHeaders, body: null as any };
    for (let i = 0; i < 120; i++) {
      last = await call('POST', '/byoa/sessions/chat-1/heartbeat', 'tok-chatty');
    }

    expect(last.status).toBe(429);
    expect(last.body.error).toBe('RATE_LIMITED');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });
});
