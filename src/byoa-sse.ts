// ============================================================================
// BYOA SSE + REST Gateway — Triologue
// ============================================================================
// Prototype implementation alongside existing WebSocket gateway.
// 
// New routes:
//   - GET  /byoa/sse/stream (receive messages via SSE)
//   - POST /byoa/sse/messages (send messages via REST)
//   - POST /byoa/sse/tokens/rotate (token rotation)
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
import { authenticateToken, rotateToken, TOKEN_ROTATE_GRACE_MS } from './auth.js';

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
  res: Response;
  connectedAt: Date;
  lastEventId: number;
}

interface AgentMessage {
  id: string;
  room: string;
  roomName: string;
  sender: string;
  senderType: 'HUMAN' | 'AI';
  content: string;
  timestamp: string;
  context?: any[];
}

// ── State ──

const sseClients = new Map<string, SSEClient[]>(); // agentId → clients
const rateLimits = new Map<string, number[]>(); // agentId → timestamps

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
    res,
    connectedAt: new Date(),
    lastEventId,
  };

  if (!sseClients.has(agent.userId)) {
    sseClients.set(agent.userId, []);
  }

  const clients = sseClients.get(agent.userId)!;

  // Connection limit: max 2 concurrent SSE streams per agent
  if (clients.length >= 2) {
    res.write(
      formatSSE(0, 'error', {
        code: 'TOO_MANY_CONNECTIONS',
        message: 'Max 2 concurrent streams per agent',
      })
    );
    return res.end();
  }

  clients.push(client);

  // Metrics
  metrics.recordConnection(agent.userId, `${agent.name} (SSE)`);

  console.log(
    `✅ [SSE] ${agent.emoji} ${agent.name} connected (${clients.length} streams, lastEventId: ${lastEventId})`
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
    replayMissedMessages(agent.userId, lastEventId, res).catch((err) =>
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
  const { roomId, content, idempotencyKey } = req.body;

  // Validate
  if (!roomId || !content) {
    return res.status(400).json({ error: 'roomId and content required' });
  }

  if (typeof content !== 'string' || content.length > 4000) {
    return res.status(400).json({ error: 'content must be string, max 4000 chars' });
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
    await bridge.sendAsAgent(token, roomId, content);
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
// Gateway-local rotation: mints a new token immediately and keeps the
// presented token valid for a short grace window (TOKEN_ROTATE_GRACE_MS,
// see auth.ts) so an in-flight caller isn't cut off mid-rotation. This
// state lives only in this gateway process's memory — it does not (and,
// without a Triologue API to update the token in its own DB, cannot yet)
// propagate to Triologue itself. See BYOA.md's Token Rotation section for
// what that means in practice.

sseRouter.post('/tokens/rotate', authenticateSSE, async (req: Request, res: Response) => {
  const agent: AgentInfo = (req as any).agent;
  const token: string = (req as any).token;

  const result = rotateToken(token);
  if (!result) {
    // authenticateSSE already validated `token` before this handler ran, so
    // this only fires if the token expired out of its grace window in the
    // narrow race between that check and here.
    metrics.recordAuthFailure('SSE: Token rotation on an invalid/expired token');
    return res.status(401).json({ error: 'Invalid or inactive token' });
  }

  console.log(
    `🔄 [SSE] ${agent.emoji} ${agent.name} rotated their token (old token valid until ${new Date(result.oldTokenExpiresAt).toISOString()})`
  );

  res.status(200).json({
    token: result.token,
    agent: { id: agent.userId, name: agent.name, username: agent.username },
    oldTokenExpiresAt: new Date(result.oldTokenExpiresAt).toISOString(),
    gracePeriodSeconds: Math.round(TOKEN_ROTATE_GRACE_MS / 1000),
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
  const now = Date.now();
  const windowMs = 60_000; // 1 minute
  const maxRequests = agent.trustLevel === 'elevated' ? 30 : 10;

  if (!rateLimits.has(agent.userId)) rateLimits.set(agent.userId, []);
  const timestamps = rateLimits.get(agent.userId)!;

  // Remove old entries
  while (timestamps.length > 0 && timestamps[0] < now - windowMs) {
    timestamps.shift();
  }

  if (timestamps.length >= maxRequests) {
    const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    res.set('X-RateLimit-Limit', String(maxRequests));
    res.set('X-RateLimit-Remaining', '0');
    return res.status(429).json({
      error: 'RATE_LIMITED',
      retryAfter,
    });
  }

  timestamps.push(now);

  // Set rate limit headers
  res.set('X-RateLimit-Limit', String(maxRequests));
  res.set('X-RateLimit-Remaining', String(maxRequests - timestamps.length));
  next();
}

// ── Resume: Replay missed messages from Redis ──

async function replayMissedMessages(agentId: string, afterEventId: number, res: Response): Promise<void> {
  // Scope replay to this agent's own stream only. The per-recipient key is
  // written by fanoutToSSEClient, which runs once per authorized recipient
  // after the full receiveMode/@mention/shouldDeliver filter (see index.ts).
  // Never scan other agents' keys: that would leak cross-room/cross-tenant.
  const missed: Array<{ eventId: number; data: string }> = [];

  // Get messages with score > afterEventId (score = eventId)
  const entries = await redis.zrangebyscore(`sse:replay:${agentId}`, afterEventId + 1, '+inf');
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(entry);
      missed.push({ eventId: parsed.eventId, data: entry });
    } catch { /* skip malformed */ }
  }

  // Sort by eventId and deliver
  missed.sort((a, b) => a.eventId - b.eventId);

  if (missed.length > 0) {
    console.log(`[SSE] Replaying ${missed.length} missed messages for agent ${agentId} (after eventId ${afterEventId})`);
  }

  for (const m of missed) {
    try {
      const parsed = JSON.parse(m.data);
      const sseData = formatSSE(m.eventId, 'message', parsed);
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

export async function fanoutToSSEClient(agentId: string, message: AgentMessage): Promise<void> {
  const clients = sseClients.get(agentId);
  if (!clients || clients.length === 0) return;

  const eventId = await redis.incr('sse:eventId');

  // Persist per recipient for Last-Event-ID resume (24h TTL). This function is
  // only invoked for agents that already passed the live-delivery filter, so a
  // per-agent key contains exactly the messages this agent was authorized to
  // receive. Replay reads this key only, preventing cross-room/tenant leakage.
  const replayKey = `sse:replay:${agentId}`;
  await redis.zadd(replayKey, eventId, JSON.stringify({ ...message, eventId }));
  await redis.expire(replayKey, 86400);

  const sseData = formatSSE(eventId, 'message', message);
  for (const client of clients) {
    try {
      if (client.res.writable && !client.res.writableEnded) {
        client.res.write(sseData);
        client.lastEventId = eventId;
      }
    } catch (err) {
      console.error(`[SSE] Failed to send to ${client.agentName}:`, err);
    }
  }
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
