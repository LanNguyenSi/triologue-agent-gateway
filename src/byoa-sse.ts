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
import { metrics } from './metrics';
import type { AgentInfo } from './types';

// Use existing auth system
import { authenticateToken } from './auth';

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

  // TODO: Deliver missed messages if lastEventId > 0
  // Requires message persistence in Redis (sorted set per room)

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

  // TODO: Send to Triologue via bridge
  // For now, just simulate success
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

sseRouter.post('/tokens/rotate', authenticateSSE, async (req: Request, res: Response) => {
  const agent: AgentInfo = (req as any).agent;

  // TODO: Generate new token and update in DB
  // For prototype, just return mock response
  const newToken = `byoa_${crypto.randomBytes(32).toString('hex')}`;

  // Disconnect all existing SSE streams for this agent
  const clients = sseClients.get(agent.userId);
  if (clients) {
    for (const client of clients) {
      client.res.write(
        formatSSE(0, 'token_rotated', {
          message: 'Reconnect with new token',
        })
      );
      client.res.end();
    }
    sseClients.delete(agent.userId);
  }

  console.log(`🔄 [SSE] ${agent.emoji} ${agent.name} rotated token`);

  res.json({
    token: newToken,
    message: 'Store this token safely. Old token is now invalid.',
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
    return res.status(429).json({
      error: 'RATE_LIMITED',
      retryAfter: Math.ceil((timestamps[0] + windowMs - now) / 1000),
    });
  }

  timestamps.push(now);

  // Set rate limit headers
  res.set('X-RateLimit-Limit', String(maxRequests));
  res.set('X-RateLimit-Remaining', String(maxRequests - timestamps.length));
  next();
}

// ── Message Fanout (to be called from Triologue bridge) ──

export async function fanoutToSSE(message: AgentMessage): Promise<void> {
  const eventId = await redis.incr('sse:eventId'); // Global monotonic ID

  // TODO: Persist message in Redis sorted set for resume
  // await redis.zadd(`messages:${message.room}`, eventId, JSON.stringify({ ...message, eventId }));
  // await redis.expire(`messages:${message.room}`, 86400);

  // Fan out to all connected SSE agents
  for (const [agentId, clients] of sseClients.entries()) {
    // TODO: Check room membership, trust level, receive mode filters
    // For prototype, send to all SSE clients

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
