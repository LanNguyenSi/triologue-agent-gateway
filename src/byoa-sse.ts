// ============================================================================
// BYOA SSE + REST Gateway — Triologue
// ============================================================================
// Prototype implementation alongside existing WebSocket gateway.
// 
// New routes:
//   - GET  /byoa/sse/stream (receive messages via SSE)
//   - POST /byoa/sse/messages (send messages via REST)
//   - POST /byoa/sse/tokens/rotate (token rotation via Triologue)
//   - GET  /byoa/sse/status (agent status)
//
// Redis dependency: npm install ioredis
// ============================================================================

import { Request, Response, NextFunction, Router } from 'express';
import crypto from 'crypto';
import { Redis } from 'ioredis';
import { metrics } from './metrics.js';
import type { AgentInfo } from './types.js';
import type { TriologueBridge } from './triologue-bridge.js';

// Use existing auth system
import { authenticateToken, authenticateCurrentToken, rotateTokenUpstream } from './auth.js';
import { consumeWindow } from './rate-window.js';
import { SESSION_ID_RE } from './sessions.js';
import { parseThreadId } from './thread-id.js';

// ── Bridge reference (injected from index.ts) ──
let bridge: TriologueBridge | null = null;

export function setBridge(b: TriologueBridge): void {
  bridge = b;
}

// ── Config ──

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const redisSub = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// ── Types ──

interface SSEClient {
  agentId: string;
  agentName: string;
  /** The agent session this stream belongs to (`?session=`), null for an untagged stream. */
  sessionId: string | null;
  res: Response;
  connectedAt: Date;
  lastEventId: number;
}

/** Streams one agent may hold per session, and untagged. */
const MAX_STREAMS_PER_SESSION = 2;

interface AgentMessage {
  id: string;
  room: string;
  roomName: string;
  threadId: string | null;
  sender: string;
  senderId: string | null;
  senderType: 'HUMAN' | 'AI';
  content: string;
  timestamp: string;
  context?: any[];
}

// ── State ──

const sseClients = new Map<string, SSEClient[]>(); // agentId → clients
const rateLimits = new Map<string, number[]>(); // agentId → timestamps
const rotateRateLimits = new Map<string, number[]>(); // agentId → rotate timestamps

// Rotation is a rare, deliberate operation (each call costs upstream requests,
// a compare-and-swap and an audit event), so its budget is far below the
// message budget: 5 per hour per agent leaves room for retries after a 409 or
// 502 while capping churn. Kept apart from the message limiter so rotation
// never eats message budget and vice versa.
const ROTATE_WINDOW_MS = 60 * 60_000;
const ROTATE_MAX_REQUESTS = 5;

// ── Router ──

export const sseRouter = Router();

// ── Middleware: Auth ──

async function authenticateSSE(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  const agent = authenticateToken(token);

  if (!agent) {
    metrics.recordAuthFailure('SSE: Invalid token');
    return res.status(401).json({ error: 'Invalid or inactive token' });
  }

  // Only check status if it's set (for backwards compatibility with agents.json)
  if (agent.status && agent.status !== 'active') {
    metrics.recordAuthFailure('SSE: Agent not active');
    return res.status(403).json({ error: 'Agent not active' });
  }

  (req as any).agent = agent;
  (req as any).token = token;
  next();
}

// ── 1) SSE Stream — Agent subscribes to receive messages ──

sseRouter.get('/stream', authenticateSSE, (req: Request, res: Response) => {
  const agent: AgentInfo = (req as any).agent;

  // A stream may belong to one registered agent session (see sessions.ts):
  // routing then prefers it for the rooms and threads that session is bound
  // to. The id is only a label here; its existence is the registry's business.
  const rawSession = req.query.session ?? req.headers['x-session-id'];
  let sessionId: string | null = null;
  if (rawSession !== undefined) {
    if (typeof rawSession !== 'string' || !SESSION_ID_RE.test(rawSession)) {
      return res.status(400).json({ error: 'session must match [A-Za-z0-9_-]{1,64}' });
    }
    sessionId = rawSession;
  }

  // SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Nginx compatibility
  });

  // Resume support via Last-Event-ID
  const lastEventId = parseInt(
    (req.headers['last-event-id'] as string) || '0',
    10
  );

  // Register SSE client
  const client: SSEClient = {
    agentId: agent.userId,
    agentName: agent.name,
    sessionId,
    res,
    connectedAt: new Date(),
    lastEventId,
  };

  if (!sseClients.has(agent.userId)) {
    sseClients.set(agent.userId, []);
  }

  const clients = sseClients.get(agent.userId)!;

  // Connection limit: max 2 concurrent streams per agent session, and max 2
  // untagged streams per agent (the limit before sessions existed).
  if (clients.filter((c) => c.sessionId === sessionId).length >= MAX_STREAMS_PER_SESSION) {
    res.write(
      formatSSE(0, 'error', {
        code: 'TOO_MANY_CONNECTIONS',
        message: sessionId
          ? `Max ${MAX_STREAMS_PER_SESSION} concurrent streams per session`
          : `Max ${MAX_STREAMS_PER_SESSION} concurrent streams per agent`,
      })
    );
    return res.end();
  }

  clients.push(client);

  // Metrics
  metrics.recordConnection(agent.userId, `${agent.name} (SSE)`);

  console.log(
    `✅ [SSE] ${agent.emoji} ${agent.name} connected (${clients.length} streams${sessionId ? `, session ${sessionId}` : ''}, lastEventId: ${lastEventId})`
  );

  // Send initial connection event
  res.write(
    formatSSE(0, 'connected', {
      agent: { id: agent.userId, name: agent.name, username: agent.username },
      trustLevel: agent.trustLevel,
      serverTime: new Date().toISOString(),
    })
  );

  // Deliver missed messages if lastEventId > 0 (resume after reconnect)
  if (lastEventId > 0) {
    replayMissedMessages(agent.userId, lastEventId, sessionId, res).catch((err) =>
      console.error(`[SSE] Replay failed for ${agent.name}: ${err.message}`)
    );
  }

  // Heartbeat every 25s (keeps connection alive through proxies)
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    const remaining = sseClients.get(agent.userId);
    if (remaining) {
      const idx = remaining.indexOf(client);
      if (idx !== -1) remaining.splice(idx, 1);
      if (remaining.length === 0) sseClients.delete(agent.userId);
    }
    metrics.recordDisconnect(agent.userId, 'SSE stream closed');
    console.log(`❌ [SSE] ${agent.emoji} ${agent.name} disconnected`);
  });
});

// ── 2) REST API — Agent sends messages (individually authenticated) ──

sseRouter.post('/messages', authenticateSSE, rateLimitMiddleware, async (req: Request, res: Response) => {
  const agent: AgentInfo = (req as any).agent;
  const token: string = (req as any).token;
  const { roomId, content, idempotencyKey, threadId } = req.body;

  // Validate
  if (!roomId || !content) {
    return res.status(400).json({ error: 'roomId and content required' });
  }

  if (typeof content !== 'string' || content.length > 4000) {
    return res.status(400).json({ error: 'content must be string, max 4000 chars' });
  }

  const thread = parseThreadId(threadId);
  if (!thread.ok) {
    return res.status(400).json({ error: thread.error });
  }

  // Idempotency check
  if (idempotencyKey) {
    const existing = await redis.get(`idempotency:${agent.userId}:${idempotencyKey}`);
    if (existing) {
      return res.status(200).json(JSON.parse(existing)); // Return cached response
    }
  }

  // Send to Triologue via bridge
  if (!bridge) {
    return res.status(503).json({ error: 'Bridge not connected' });
  }

  try {
    await bridge.sendAsAgent(token, roomId, content, thread.threadId);
  } catch (err: any) {
    console.error(`[SSE] Send failed for ${agent.name}: ${err.message}`);
    return res.status(502).json({ error: 'Failed to deliver message', detail: err.message });
  }

  const messageId = crypto.randomUUID();
  const response = { messageId, status: 'sent' };

  // Cache idempotency result (TTL 1 hour)
  if (idempotencyKey) {
    await redis.set(
      `idempotency:${agent.userId}:${idempotencyKey}`,
      JSON.stringify(response),
      'EX',
      3600
    );
  }

  metrics.recordMessageSent(agent.userId, roomId);
  console.log(`📤 [SSE] ${agent.emoji} ${agent.name} sent message to ${roomId}`);

  res.status(201).json(response);
});

// ── 3) Token Rotation ──
// Rotation is performed by Triologue (POST /api/agents/:id/token/rotate); the
// gateway only brokers it. The new token is returned solely to a caller that
// presents the agent's CURRENT token: a previous token that is still inside
// its grace window authenticates elsewhere but is refused here with 403, so
// a leaked old token can never mint or read the replacement. Triologue
// repeats the same check against its own row.

sseRouter.post('/tokens/rotate', authenticateSSE, async (req: Request, res: Response) => {
  const agent: AgentInfo = (req as any).agent;
  const token: string = (req as any).token;

  const current = authenticateCurrentToken(token);
  if (!current || current.userId !== agent.userId) {
    metrics.recordAuthFailure('SSE: Rotate with non-current token');
    return res.status(403).json({
      error: 'stale_token',
      message: 'Token rotation requires the current token; this token has been replaced.',
    });
  }

  // After the current-token check, so a leaked grace-window token cannot burn
  // the agent's rotate budget.
  const limit = consumeWindow(rotateRateLimits, agent.userId, Date.now(), ROTATE_WINDOW_MS, ROTATE_MAX_REQUESTS);
  res.set('X-RateLimit-Limit', String(ROTATE_MAX_REQUESTS));
  res.set('X-RateLimit-Remaining', String(limit.remaining));
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: 'RATE_LIMITED', retryAfter: limit.retryAfter });
  }

  const result = await rotateTokenUpstream(current, token);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }

  res.set('Cache-Control', 'no-store');
  return res.json({
    token: result.token,
    previousTokenExpiresAt: result.previousTokenExpiresAt,
    graceSeconds: result.graceSeconds,
  });
});

// ── 4) Status Endpoint ──

sseRouter.get('/status', authenticateSSE, (req: Request, res: Response) => {
  const agent: AgentInfo = (req as any).agent;
  const streams = sseClients.get(agent.userId)?.length || 0;

  res.json({
    agent: { id: agent.userId, name: agent.name, username: agent.username },
    connectedStreams: streams,
    trustLevel: agent.trustLevel,
    connectionType: 'SSE + REST',
    mentionKey: agent.mentionKey,
    receiveMode: agent.receiveMode,
  });
});

// ── 5) Health Check ──

sseRouter.get('/health', (_, res) => {
  const totalStreams = [...sseClients.values()].reduce((sum, arr) => sum + arr.length, 0);
  res.json({
    status: 'ok',
    sseStreams: totalStreams,
    uniqueAgents: sseClients.size,
  });
});

// ── Helpers ──

function formatSSE(id: number, event: string, data: any): string {
  const idLine = id > 0 ? `id: ${id}\n` : '';
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const agent: AgentInfo = (req as any).agent;
  const windowMs = 60_000; // 1 minute
  const maxRequests = agent.trustLevel === 'elevated' ? 30 : 10;

  const limit = consumeWindow(rateLimits, agent.userId, Date.now(), windowMs, maxRequests);
  res.set('X-RateLimit-Limit', String(maxRequests));
  res.set('X-RateLimit-Remaining', String(limit.remaining));

  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfter));
    return res.status(429).json({
      error: 'RATE_LIMITED',
      retryAfter: limit.retryAfter,
    });
  }
  next();
}

// ── Resume: Replay missed messages from Redis ──

/**
 * Which stored events a reconnecting stream gets back. An event fanned out
 * to specific sessions (`targets`) is replayed only to a stream of one of
 * them; an event that went to every stream (no `targets`) is replayed to
 * every stream, tagged or not. Exported for the unit test.
 */
export function selectReplayEvents(
  entries: string[],
  sessionId: string | null,
): Array<{ eventId: number; event: Record<string, unknown> }> {
  const selected: Array<{ eventId: number; event: Record<string, unknown> }> = [];
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(entry) as Record<string, unknown>;
      if (typeof parsed.eventId !== 'number') continue;
      const targets = Array.isArray(parsed.targets) ? (parsed.targets as string[]) : null;
      if (targets && (sessionId === null || !targets.includes(sessionId))) continue;
      const { targets: _dropped, ...event } = parsed;
      selected.push({ eventId: parsed.eventId, event });
    } catch { /* skip malformed */ }
  }
  return selected.sort((a, b) => a.eventId - b.eventId);
}

async function replayMissedMessages(agentId: string, afterEventId: number, sessionId: string | null, res: Response): Promise<void> {
  // Scope replay to this agent's own stream only. The per-recipient key is
  // written by fanoutToSSEClient, which runs once per authorized recipient
  // after the full receiveMode/@mention/shouldDeliver filter (see index.ts).
  // Never scan other agents' keys: that would leak cross-room/cross-tenant.

  // Get messages with score > afterEventId (score = eventId)
  const entries = await redis.zrangebyscore(`sse:replay:${agentId}`, afterEventId + 1, '+inf');
  const missed = selectReplayEvents(entries, sessionId);

  if (missed.length > 0) {
    console.log(`[SSE] Replaying ${missed.length} missed messages for agent ${agentId} (after eventId ${afterEventId})`);
  }

  for (const m of missed) {
    try {
      const sseData = formatSSE(m.eventId, 'message', m.event);
      if (res.writable && !res.writableEnded) {
        res.write(sseData);
      }
    } catch { /* skip */ }
  }
}

// ── Message Fanout (called from index.ts message routing) ──

export function getSSEClientAgentIds(): string[] {
  return [...sseClients.keys()];
}

export function hasSSEClient(agentId: string): boolean {
  const clients = sseClients.get(agentId);
  return !!clients && clients.length > 0;
}

/** The session ids of the agent's open streams (untagged streams excluded). */
export function getSSESessionIds(agentId: string): string[] {
  const ids = new Set<string>();
  for (const client of sseClients.get(agentId) ?? []) {
    if (client.sessionId) ids.add(client.sessionId);
  }
  return [...ids];
}

/**
 * Deliver a message to the agent's streams. With `targetSessionIds`, only
 * streams of those sessions receive it, provided at least one of them is
 * open; otherwise (no targets, or none of the targeted sessions has a
 * stream) every stream of the agent receives it, as before sessions
 * existed, so a binding to a session that lost its stream never swallows
 * a message. Returns the session ids the message was written for, or null
 * when it went to every stream.
 */
export async function fanoutToSSEClient(
  agentId: string,
  message: AgentMessage,
  targetSessionIds?: string[],
): Promise<string[] | null> {
  const clients = sseClients.get(agentId);
  if (!clients || clients.length === 0) return null;

  let recipients = clients;
  let targets: string[] | null = null;
  if (targetSessionIds && targetSessionIds.length > 0) {
    const wanted = new Set(targetSessionIds);
    const matching = clients.filter((c) => c.sessionId !== null && wanted.has(c.sessionId));
    if (matching.length > 0) {
      recipients = matching;
      targets = [...new Set(matching.map((c) => c.sessionId!))];
    }
  }

  const eventId = await redis.incr('sse:eventId');

  // Persist per recipient for Last-Event-ID resume (24h TTL). Only agents with
  // an open stream are buffered: the early return above skips everyone else, so
  // a message that arrives while the agent has no stream is not stored. This
  // function is only invoked for agents that already passed the live-delivery
  // filter, so a per-agent key contains exactly the messages this agent was
  // authorized to receive. Replay reads this key only, preventing cross-room/tenant leakage.
  // A targeted delivery records its sessions, so replay keeps it to them.
  const replayKey = `sse:replay:${agentId}`;
  await redis.zadd(replayKey, eventId, JSON.stringify({ ...message, eventId, ...(targets ? { targets } : {}) }));
  await redis.expire(replayKey, 86400);

  const sseData = formatSSE(eventId, 'message', message);
  for (const client of recipients) {
    try {
      if (client.res.writable && !client.res.writableEnded) {
        client.res.write(sseData);
        client.lastEventId = eventId;
      }
    } catch (err) {
      console.error(`[SSE] Failed to send to ${client.agentName}:`, err);
    }
  }
  return targets;
}

// ── Shutdown ──

export function shutdownSSE(): void {
  for (const [agentId, clients] of sseClients.entries()) {
    for (const client of clients) {
      client.res.write(formatSSE(0, 'shutdown', { message: 'Server shutting down' }));
      client.res.end();
    }
  }
  sseClients.clear();
  redis.disconnect();
  redisSub.disconnect();
}
