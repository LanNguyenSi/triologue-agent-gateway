// ============================================================================
// Agent sessions — registry and /byoa/sessions API
// ============================================================================
// A session is one running agent runtime (a Claude Code terminal, a Codex
// app-server thread, an opencode server) that speaks for an agent token.
// The registry remembers each session's host, working directory, status and
// the rooms and threads it is bound to, so that later changes can route a
// room or thread message to the one session that owns it and show the
// session's presence in Triologue. Sessions are flighty gateway state in
// Redis: a session that stops sending heartbeats expires after
// SESSION_TTL_SECONDS and is swept out together with its bindings.
//
// Routes (all under /byoa/sessions, bearer-authenticated like /byoa/sse):
//   POST   /connect                 register (or refresh) a session
//   GET    /                        the agent's live sessions
//   POST   /:sessionId/heartbeat    keep the session alive
//   POST   /:sessionId/presence     status: online | working | waiting_approval | error | offline
//   POST   /:sessionId/bind         bind rooms and threads
//   DELETE /:sessionId/bind         unbind rooms and threads
//   DELETE /:sessionId              end the session
// ============================================================================

import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';
import { EventEmitter } from 'node:events';
import { authenticateToken } from './auth.js';
import { consumeWindow } from './rate-window.js';
import { metrics } from './metrics.js';
import type { AgentInfo } from './types.js';

export const SESSION_TTL_SECONDS = 90;
export const HEARTBEAT_SECONDS = 30;
export const SWEEP_INTERVAL_MS = 30_000;
/** Rooms plus threads one session may be bound to at once. */
export const MAX_SESSION_BINDINGS = 200;

export const SESSION_STATUSES = ['online', 'working', 'waiting_approval', 'error'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * The Redis surface the registry uses (an ioredis client satisfies it; the
 * tests pass an in-memory stand-in). Writes that must land together go
 * through `multi()`, so a hash can never exist without its TTL.
 */
export interface SessionPipeline {
  hset(key: string, fields: Record<string, string>): SessionPipeline;
  expire(key: string, seconds: number): SessionPipeline;
  sadd(key: string, ...members: string[]): SessionPipeline;
  srem(key: string, ...members: string[]): SessionPipeline;
  del(...keys: string[]): SessionPipeline;
  exec(): Promise<unknown>;
}

export interface SessionStore {
  hset(key: string, fields: Record<string, string>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  multi(): SessionPipeline;
}

export interface AgentSession {
  sessionId: string;
  agentId: string;
  runtime: string;
  host: string;
  cwd: string;
  project: string | null;
  claudeSessionId: string | null;
  status: SessionStatus;
  detail: string | null;
  startedAt: string;
  lastHeartbeat: string;
  rooms: string[];
  threads: string[];
}

export interface ConnectInput {
  sessionId?: string;
  runtime: string;
  host: string;
  cwd: string;
  project?: string | null;
  claudeSessionId?: string | null;
  rooms?: string[];
  threads?: string[];
}

export interface PresenceEvent {
  agentId: string;
  sessionId: string;
  status: SessionStatus | 'offline';
  detail: string | null;
  /** The session as it was when the event fired; null once it is gone. */
  session: AgentSession | null;
}

/** Thrown by bind() and connect() when a session would exceed MAX_SESSION_BINDINGS. */
export class BindingLimitError extends Error {
  constructor() {
    super(`a session may hold at most ${MAX_SESSION_BINDINGS} room and thread bindings`);
    this.name = 'BindingLimitError';
  }
}

// ── Keys ──
// session:<agentId>:<sessionId>   HASH, TTL  the session's metadata and status
// sessions:<agentId>              SET        sessionIds of that agent (pruned lazily and by sweep)
// sessions:agents                 SET        agentIds that ever had a session, for the sweep
// sessbind:<agentId>:<sessionId>  SET        "room:<id>" / "thread:<id>" members, no TTL
// bind:room:<roomId>:<agentId>    SET        sessionIds bound to the room
// bind:thread:<threadId>:<agentId> SET       sessionIds bound to the thread

const sessionKey = (agentId: string, sessionId: string) => `session:${agentId}:${sessionId}`;
const sessionsKey = (agentId: string) => `sessions:${agentId}`;
const AGENTS_KEY = 'sessions:agents';
const sessBindKey = (agentId: string, sessionId: string) => `sessbind:${agentId}:${sessionId}`;
const roomBindKey = (roomId: string, agentId: string) => `bind:room:${roomId}:${agentId}`;
const threadBindKey = (threadId: string, agentId: string) => `bind:thread:${threadId}:${agentId}`;

export class SessionRegistry extends EventEmitter {
  constructor(
    private readonly store: SessionStore,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  /**
   * Register a session, or refresh one that reconnects with its own
   * sessionId. A refresh keeps the recorded start time and status and adds
   * the given rooms and threads to the existing bindings. A sessionId whose
   * hash has expired starts over: whatever bindings its predecessor left
   * behind are dropped first.
   */
  async connect(agentId: string, input: ConnectInput): Promise<AgentSession> {
    const sessionId = input.sessionId ?? crypto.randomUUID();
    const key = sessionKey(agentId, sessionId);
    const existing = await this.store.hgetall(key);
    if (!existing.sessionId) await this.dropBindings(agentId, sessionId);

    const nowIso = new Date(this.now()).toISOString();
    const startedAt = existing.startedAt ?? nowIso;
    const status: SessionStatus = isStatus(existing.status) ? existing.status : 'online';

    await this.store
      .multi()
      .hset(key, {
        sessionId,
        agentId,
        runtime: input.runtime,
        host: input.host,
        cwd: input.cwd,
        project: input.project ?? '',
        claudeSessionId: input.claudeSessionId ?? '',
        status,
        detail: existing.detail ?? '',
        startedAt,
        lastHeartbeat: nowIso,
      })
      .expire(key, SESSION_TTL_SECONDS)
      .sadd(sessionsKey(agentId), sessionId)
      .sadd(AGENTS_KEY, agentId)
      .exec();

    if (input.rooms?.length || input.threads?.length) {
      await this.bind(agentId, sessionId, input.rooms ?? [], input.threads ?? []);
    }

    const session = (await this.get(agentId, sessionId))!;
    this.emit('presence', { agentId, sessionId, status: session.status, detail: session.detail, session } satisfies PresenceEvent);
    return session;
  }

  /** Extend the session's TTL. False when the session is unknown or expired. */
  async heartbeat(agentId: string, sessionId: string): Promise<boolean> {
    return this.touch(agentId, sessionId, { lastHeartbeat: new Date(this.now()).toISOString() });
  }

  /** Set the status; counts as a heartbeat. False when the session is unknown. */
  async setPresence(agentId: string, sessionId: string, status: SessionStatus, detail: string | null = null): Promise<boolean> {
    const alive = await this.touch(agentId, sessionId, {
      status,
      detail: detail ?? '',
      lastHeartbeat: new Date(this.now()).toISOString(),
    });
    if (!alive) return false;
    const session = await this.get(agentId, sessionId);
    this.emit('presence', { agentId, sessionId, status, detail, session } satisfies PresenceEvent);
    return true;
  }

  /**
   * Bind rooms and threads to the session. Null when the session is unknown
   * (or ended while the bindings were written: they are dropped again);
   * throws BindingLimitError when the session would exceed MAX_SESSION_BINDINGS.
   */
  async bind(agentId: string, sessionId: string, rooms: string[], threads: string[]): Promise<{ rooms: string[]; threads: string[] } | null> {
    const key = sessionKey(agentId, sessionId);
    if (!(await this.store.exists(key))) return null;

    const members = [...rooms.map((r) => `room:${r}`), ...threads.map((t) => `thread:${t}`)];
    if (members.length > 0) {
      const current = new Set(await this.store.smembers(sessBindKey(agentId, sessionId)));
      const added = members.filter((m) => !current.has(m));
      if (current.size + added.length > MAX_SESSION_BINDINGS) throw new BindingLimitError();

      const pipe = this.store.multi();
      for (const roomId of rooms) pipe.sadd(roomBindKey(roomId, agentId), sessionId);
      for (const threadId of threads) pipe.sadd(threadBindKey(threadId, agentId), sessionId);
      pipe.sadd(sessBindKey(agentId, sessionId), ...members);
      await pipe.exec();

      // The session may have ended while we wrote: do not leave bindings
      // behind that no sweep would visit.
      if (!(await this.store.exists(key))) {
        await this.dropBindings(agentId, sessionId);
        return null;
      }
    }
    return this.bindings(agentId, sessionId);
  }

  /** Remove bindings from the session. Null when the session is unknown. */
  async unbind(agentId: string, sessionId: string, rooms: string[], threads: string[]): Promise<{ rooms: string[]; threads: string[] } | null> {
    if (!(await this.store.exists(sessionKey(agentId, sessionId)))) return null;
    const members = [...rooms.map((r) => `room:${r}`), ...threads.map((t) => `thread:${t}`)];
    if (members.length > 0) {
      const pipe = this.store.multi();
      for (const roomId of rooms) pipe.srem(roomBindKey(roomId, agentId), sessionId);
      for (const threadId of threads) pipe.srem(threadBindKey(threadId, agentId), sessionId);
      pipe.srem(sessBindKey(agentId, sessionId), ...members);
      await pipe.exec();
    }
    return this.bindings(agentId, sessionId);
  }

  /** End the session: drop its hash and every binding. False when it was already gone. */
  async remove(agentId: string, sessionId: string): Promise<boolean> {
    const existed = (await this.store.exists(sessionKey(agentId, sessionId))) > 0;
    await this.store.multi().del(sessionKey(agentId, sessionId)).srem(sessionsKey(agentId), sessionId).exec();
    await this.dropBindings(agentId, sessionId);
    if (existed) {
      this.emit('presence', { agentId, sessionId, status: 'offline', detail: null, session: null } satisfies PresenceEvent);
    }
    return existed;
  }

  async get(agentId: string, sessionId: string): Promise<AgentSession | null> {
    const raw = await this.store.hgetall(sessionKey(agentId, sessionId));
    if (!raw.sessionId) return null;
    const { rooms, threads } = await this.bindings(agentId, sessionId);
    return {
      sessionId: raw.sessionId,
      agentId: raw.agentId,
      runtime: raw.runtime,
      host: raw.host,
      cwd: raw.cwd,
      project: raw.project || null,
      claudeSessionId: raw.claudeSessionId || null,
      status: isStatus(raw.status) ? raw.status : 'online',
      detail: raw.detail || null,
      startedAt: raw.startedAt,
      lastHeartbeat: raw.lastHeartbeat,
      rooms,
      threads,
    };
  }

  /** The agent's live sessions; expired ones are pruned on the way. */
  async list(agentId: string): Promise<AgentSession[]> {
    const ids = await this.store.smembers(sessionsKey(agentId));
    const sessions: AgentSession[] = [];
    for (const sessionId of ids.sort()) {
      const session = await this.get(agentId, sessionId);
      if (session) sessions.push(session);
      else await this.expire(agentId, sessionId);
    }
    return sessions;
  }

  /** Every agent that has or had a session (the sweep's and the presence push's scope). */
  async agents(): Promise<string[]> {
    return (await this.store.smembers(AGENTS_KEY)).sort();
  }

  /** Live sessions of the agent bound to the room (expired ones pruned). */
  async sessionsForRoom(agentId: string, roomId: string): Promise<string[]> {
    return this.liveMembers(agentId, roomBindKey(roomId, agentId));
  }

  /** Live sessions of the agent bound to the thread (expired ones pruned). */
  async sessionsForThread(agentId: string, threadId: string): Promise<string[]> {
    return this.liveMembers(agentId, threadBindKey(threadId, agentId));
  }

  /**
   * Drop every session whose hash has expired; returns how many were
   * dropped. `sessions:agents` is never shrunk: it is bounded by the number
   * of agents, and shrinking it would race a concurrent connect.
   */
  async sweep(): Promise<number> {
    let expired = 0;
    for (const agentId of await this.agents()) {
      for (const sessionId of await this.store.smembers(sessionsKey(agentId))) {
        if (!(await this.store.exists(sessionKey(agentId, sessionId)))) {
          if (await this.expire(agentId, sessionId)) expired += 1;
        }
      }
    }
    return expired;
  }

  // ── internals ──

  /**
   * Write fields into a live session's hash and refresh its TTL. A hash
   * that expired between the check and the write would come back as a
   * one-field hash; that is detected and removed, and false is returned.
   */
  private async touch(agentId: string, sessionId: string, fields: Record<string, string>): Promise<boolean> {
    const key = sessionKey(agentId, sessionId);
    if (!(await this.store.exists(key))) return false;
    await this.store.multi().hset(key, fields).expire(key, SESSION_TTL_SECONDS).exec();
    const raw = await this.store.hgetall(key);
    if (!raw.sessionId) {
      await this.store.del(key);
      await this.expire(agentId, sessionId);
      return false;
    }
    return true;
  }

  private async bindings(agentId: string, sessionId: string): Promise<{ rooms: string[]; threads: string[] }> {
    const members = await this.store.smembers(sessBindKey(agentId, sessionId));
    const rooms = members.filter((m) => m.startsWith('room:')).map((m) => m.slice(5)).sort();
    const threads = members.filter((m) => m.startsWith('thread:')).map((m) => m.slice(7)).sort();
    return { rooms, threads };
  }

  private async dropBindings(agentId: string, sessionId: string): Promise<void> {
    const { rooms, threads } = await this.bindings(agentId, sessionId);
    const pipe = this.store.multi();
    for (const roomId of rooms) pipe.srem(roomBindKey(roomId, agentId), sessionId);
    for (const threadId of threads) pipe.srem(threadBindKey(threadId, agentId), sessionId);
    pipe.del(sessBindKey(agentId, sessionId));
    await pipe.exec();
  }

  /**
   * A session whose hash is gone: clean up and announce offline. Re-checks
   * the hash right before the removals, so a session that reconnected with
   * the same id in the meantime keeps its fresh bindings. Returns whether
   * anything was expired.
   */
  private async expire(agentId: string, sessionId: string): Promise<boolean> {
    if (await this.store.exists(sessionKey(agentId, sessionId))) return false;
    await this.dropBindings(agentId, sessionId);
    await this.store.srem(sessionsKey(agentId), sessionId);
    this.emit('presence', { agentId, sessionId, status: 'offline', detail: null, session: null } satisfies PresenceEvent);
    return true;
  }

  private async liveMembers(agentId: string, key: string): Promise<string[]> {
    const live: string[] = [];
    for (const sessionId of (await this.store.smembers(key)).sort()) {
      if (await this.store.exists(sessionKey(agentId, sessionId))) live.push(sessionId);
      else await this.expire(agentId, sessionId);
    }
    return live;
  }
}

function isStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value);
}

// ── HTTP API ──

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BINDING_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BINDINGS_PER_CALL = 50;
const WINDOW_MS = 60_000;
const MAX_CALLS_PER_WINDOW = 120;

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function optionalString(value: unknown, name: string, max: number): ParseResult<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    return { ok: false, error: `${name} must be a non-empty string of at most ${max} characters` };
  }
  return { ok: true, value: value.trim() };
}

function requiredString(value: unknown, name: string, max: number): ParseResult<string> {
  const parsed = optionalString(value, name, max);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return { ok: false, error: `${name} is required` };
  return { ok: true, value: parsed.value };
}

function idList(value: unknown, name: string): ParseResult<string[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (
    !Array.isArray(value) ||
    value.length > MAX_BINDINGS_PER_CALL ||
    value.some((v) => typeof v !== 'string' || !BINDING_ID_RE.test(v))
  ) {
    return {
      ok: false,
      error: `${name} must be an array of at most ${MAX_BINDINGS_PER_CALL} ids matching [A-Za-z0-9_-]{1,128}`,
    };
  }
  return { ok: true, value: [...new Set(value as string[])] };
}

function parseConnect(body: unknown): ParseResult<ConnectInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  const sessionId = optionalString(b.sessionId, 'sessionId', 64);
  if (!sessionId.ok) return sessionId;
  if (sessionId.value !== null && !SESSION_ID_RE.test(sessionId.value)) {
    return { ok: false, error: 'sessionId must match [A-Za-z0-9_-]{1,64}' };
  }
  const runtime = requiredString(b.runtime, 'runtime', 32);
  if (!runtime.ok) return runtime;
  const host = requiredString(b.host, 'host', 255);
  if (!host.ok) return host;
  const cwd = requiredString(b.cwd, 'cwd', 1024);
  if (!cwd.ok) return cwd;
  const project = optionalString(b.project, 'project', 255);
  if (!project.ok) return project;
  const claudeSessionId = optionalString(b.claudeSessionId, 'claudeSessionId', 128);
  if (!claudeSessionId.ok) return claudeSessionId;
  const rooms = idList(b.rooms, 'rooms');
  if (!rooms.ok) return rooms;
  const threads = idList(b.threads, 'threads');
  if (!threads.ok) return threads;
  return {
    ok: true,
    value: {
      sessionId: sessionId.value ?? undefined,
      runtime: runtime.value,
      host: host.value,
      cwd: cwd.value,
      project: project.value,
      claudeSessionId: claudeSessionId.value,
      rooms: rooms.value,
      threads: threads.value,
    },
  };
}

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

/**
 * Express 4 does not catch a rejected async handler: the rejection would be
 * unhandled and end the process. Every route goes through this wrapper, so
 * a Redis failure answers 500 (or 400 for a binding limit) instead.
 */
function guarded(handler: AsyncHandler) {
  return (req: Request, res: Response, _next: NextFunction) => {
    handler(req, res).catch((err: unknown) => {
      if (err instanceof BindingLimitError) {
        if (!res.headersSent) res.status(400).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sessions] ${req.method} ${req.originalUrl} failed: ${message}`);
      if (!res.headersSent) res.status(500).json({ error: 'Session store unavailable' });
    });
  };
}

export function createSessionsRouter(registry: SessionRegistry): Router {
  const router = Router();
  const windows = new Map<string, number[]>();

  function authenticate(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const agent = authenticateToken(authHeader.slice(7));
    if (!agent) {
      metrics.recordAuthFailure('Sessions: Invalid token');
      return res.status(401).json({ error: 'Invalid or inactive token' });
    }
    if (agent.status && agent.status !== 'active') {
      metrics.recordAuthFailure('Sessions: Agent not active');
      return res.status(403).json({ error: 'Agent not active' });
    }
    // Heartbeats and presence are frequent; their budget is separate from
    // the message limiter and generous, so a chatty session never loses
    // its heartbeat behind a burst of status changes.
    const limit = consumeWindow(windows, agent.userId, Date.now(), WINDOW_MS, MAX_CALLS_PER_WINDOW);
    res.set('X-RateLimit-Limit', String(MAX_CALLS_PER_WINDOW));
    res.set('X-RateLimit-Remaining', String(limit.remaining));
    if (!limit.allowed) {
      res.set('Retry-After', String(limit.retryAfter));
      return res.status(429).json({ error: 'RATE_LIMITED', retryAfter: limit.retryAfter });
    }
    (req as Request & { agent: AgentInfo }).agent = agent;
    next();
  }

  const agentOf = (req: Request): AgentInfo => (req as Request & { agent: AgentInfo }).agent;

  function sessionIdOf(req: Request, res: Response): string | null {
    const sessionId = String(req.params.sessionId ?? '');
    if (!SESSION_ID_RE.test(sessionId)) {
      res.status(404).json({ error: 'Unknown session' });
      return null;
    }
    return sessionId;
  }

  router.post('/connect', authenticate, guarded(async (req, res) => {
    const parsed = parseConnect(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const session = await registry.connect(agentOf(req).userId, parsed.value);
    res.status(201).json({ sessionId: session.sessionId, heartbeatSeconds: HEARTBEAT_SECONDS, ttlSeconds: SESSION_TTL_SECONDS, session });
  }));

  router.get('/', authenticate, guarded(async (req, res) => {
    res.json({ sessions: await registry.list(agentOf(req).userId) });
  }));

  router.post('/:sessionId/heartbeat', authenticate, guarded(async (req, res) => {
    const sessionId = sessionIdOf(req, res);
    if (!sessionId) return;
    const alive = await registry.heartbeat(agentOf(req).userId, sessionId);
    if (!alive) return res.status(404).json({ error: 'Unknown session' });
    res.status(204).end();
  }));

  router.post('/:sessionId/presence', authenticate, guarded(async (req, res) => {
    const sessionId = sessionIdOf(req, res);
    if (!sessionId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = body.status;
    const detail = optionalString(body.detail, 'detail', 500);
    if (!detail.ok) return res.status(400).json({ error: detail.error });
    if (status === 'offline') {
      const existed = await registry.remove(agentOf(req).userId, sessionId);
      if (!existed) return res.status(404).json({ error: 'Unknown session' });
      return res.status(204).end();
    }
    if (!isStatus(status)) {
      return res.status(400).json({ error: `status must be one of ${[...SESSION_STATUSES, 'offline'].join(', ')}` });
    }
    const alive = await registry.setPresence(agentOf(req).userId, sessionId, status, detail.value);
    if (!alive) return res.status(404).json({ error: 'Unknown session' });
    res.status(204).end();
  }));

  async function changeBindings(req: Request, res: Response, apply: 'bind' | 'unbind') {
    const sessionId = sessionIdOf(req, res);
    if (!sessionId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rooms = idList(body.rooms, 'rooms');
    if (!rooms.ok) return res.status(400).json({ error: rooms.error });
    const threads = idList(body.threads, 'threads');
    if (!threads.ok) return res.status(400).json({ error: threads.error });
    const result = await registry[apply](agentOf(req).userId, sessionId, rooms.value, threads.value);
    if (!result) return res.status(404).json({ error: 'Unknown session' });
    res.json(result);
  }

  router.post('/:sessionId/bind', authenticate, guarded((req, res) => changeBindings(req, res, 'bind')));
  router.delete('/:sessionId/bind', authenticate, guarded((req, res) => changeBindings(req, res, 'unbind')));

  router.delete('/:sessionId', authenticate, guarded(async (req, res) => {
    const sessionId = sessionIdOf(req, res);
    if (!sessionId) return;
    const existed = await registry.remove(agentOf(req).userId, sessionId);
    if (!existed) return res.status(404).json({ error: 'Unknown session' });
    res.status(204).end();
  }));

  return router;
}
