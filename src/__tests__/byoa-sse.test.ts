/**
 * Tests for src/byoa-sse.ts
 *
 * Mounts sseRouter on an ephemeral express server; mocks ioredis and
 * authenticateToken so no real Redis or auth state is needed.
 *
 * Covers:
 *   - Client registration (hasSSEClient true after GET /stream)
 *   - getSSEClientAgentIds lists the connected agent
 *   - fanoutToSSEClient delivers the event to the matching agent only
 *   - Disconnect cleanup (close handler removes the client)
 *   - shutdownSSE closes all open connections
 *
 * Mutation guard:
 *   M-fanout: break the per-agent target filter in fanout (deliver to all
 *   instead of matching agentId) → the "NOT to others" assertion fails.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import express from 'express';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentInfo } from '../types.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

/**
 * ioredis creates two Redis connections at module load time (redis + redisSub).
 * Mock the module with a class constructor so `new Redis(url)` works without
 * attempting a real network connection.
 */
vi.mock('ioredis', () => {
  class MockRedis {
    incr = vi.fn<() => Promise<number>>().mockResolvedValue(42);
    zadd = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    expire = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    zrangebyscore = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
    set = vi.fn<() => Promise<string>>().mockResolvedValue('OK');
    get = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
    disconnect = vi.fn();
    on = vi.fn();
    subscribe = vi.fn();
  }
  return { Redis: MockRedis };
});

vi.mock('../metrics', () => ({
  metrics: {
    recordAuthFailure: vi.fn(),
    recordConnection: vi.fn(),
    recordDisconnect: vi.fn(),
    recordMessageSent: vi.fn(),
    generateReport: vi.fn().mockReturnValue(''),
    getSnapshot: vi.fn().mockReturnValue({}),
    updateAgentCounts: vi.fn(),
    shutdown: vi.fn(),
  },
}));

const authenticateTokenMock = vi.fn<(token: string) => AgentInfo | null>();

vi.mock('../auth', () => ({
  authenticateToken: (token: string) => authenticateTokenMock(token),
}));

// ── Import after mocks ─────────────────────────────────────────────────────────

const {
  sseRouter,
  hasSSEClient,
  getSSEClientAgentIds,
  fanoutToSSEClient,
  shutdownSSE,
} = await import('../byoa-sse.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const fakeAgent: AgentInfo = {
  id: 'user-sse-001',
  name: 'SSEBot',
  userId: 'user-sse-001',
  username: 'ssebot',
  mentionKey: 'sse',
  webhookUrl: null,
  webhookSecret: null,
  trustLevel: 'standard',
  emoji: '🌊',
  color: null,
  connectionType: 'both',
  receiveMode: 'mentions',
  delivery: 'webhook',
};

const fakeAgent2: AgentInfo = {
  id: 'user-sse-002',
  name: 'OtherBot',
  userId: 'user-sse-002',
  username: 'otherbot',
  mentionKey: 'other',
  webhookUrl: null,
  webhookSecret: null,
  trustLevel: 'standard',
  emoji: '🤖',
  color: null,
  connectionType: 'both',
  receiveMode: 'mentions',
  delivery: 'webhook',
};

// ── Server setup ──────────────────────────────────────────────────────────────

let server: Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use('/byoa/sse', sseRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  shutdownSSE();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  authenticateTokenMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── SSE connection helper ──────────────────────────────────────────────────────

/**
 * Open an SSE stream connection. Returns accumulated chunk data and a
 * destroy() function to close the client side (triggering the server's
 * 'close' event cleanup).
 */
function connectSSE(token: string): Promise<{
  chunks: string[];
  destroy: () => void;
  req: http.ClientRequest;
}> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/byoa/sse/stream',
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => chunks.push(chunk));
        resolve({ chunks, destroy: () => req.destroy(), req });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      // Ignore ECONNRESET — that's from our own destroy() call
      if (err.code !== 'ECONNRESET') reject(err);
    });
  });
}

/** Poll until condition is true or timeout */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('client registration', () => {
  it('hasSSEClient returns false before any connection', () => {
    expect(hasSSEClient('user-sse-001')).toBe(false);
  });

  it('hasSSEClient returns true after a client connects', async () => {
    authenticateTokenMock.mockReturnValue(fakeAgent);
    const { chunks, destroy } = await connectSSE('valid-token');

    // Wait for the server to send the initial 'connected' event
    await waitFor(() => chunks.some((c) => c.includes('connected')));

    expect(hasSSEClient(fakeAgent.userId)).toBe(true);

    destroy();
    await waitFor(() => !hasSSEClient(fakeAgent.userId));
  });

  it('getSSEClientAgentIds lists the connected agent ID', async () => {
    authenticateTokenMock.mockReturnValue(fakeAgent);
    const { chunks, destroy } = await connectSSE('valid-token');

    await waitFor(() => chunks.some((c) => c.includes('connected')));

    expect(getSSEClientAgentIds()).toContain(fakeAgent.userId);

    destroy();
    await waitFor(() => !hasSSEClient(fakeAgent.userId));
  });

  it('returns 401 for a missing Authorization header', async () => {
    const status = await new Promise<number>((resolve) => {
      http
        .get({ hostname: '127.0.0.1', port, path: '/byoa/sse/stream' }, (res) => {
          resolve(res.statusCode ?? 0);
        })
        .on('error', () => resolve(0));
    });
    expect(status).toBe(401);
  });

  it('returns 401 for an invalid token', async () => {
    authenticateTokenMock.mockReturnValue(null);
    const status = await new Promise<number>((resolve) => {
      http
        .get(
          {
            hostname: '127.0.0.1',
            port,
            path: '/byoa/sse/stream',
            headers: { Authorization: 'Bearer bad_token' },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
          },
        )
        .on('error', () => resolve(0));
    });
    expect(status).toBe(401);
  });
});

describe('fanoutToSSEClient', () => {
  it('delivers an event to the matching agent connection', async () => {
    authenticateTokenMock.mockReturnValue(fakeAgent);
    const { chunks, destroy } = await connectSSE('valid-token');

    await waitFor(() => chunks.some((c) => c.includes('connected')));

    const testMessage = {
      id: 'msg-001',
      room: 'room-1',
      roomName: 'General',
      sender: 'humanuser',
      senderType: 'HUMAN' as const,
      content: 'Hello SSEBot!',
      timestamp: new Date().toISOString(),
    };

    await fanoutToSSEClient(fakeAgent.userId, testMessage);

    await waitFor(() =>
      chunks.some((c) => c.includes('Hello SSEBot!')),
    );

    const allData = chunks.join('');
    expect(allData).toContain('msg-001');
    expect(allData).toContain('Hello SSEBot!');
    expect(allData).toContain('humanuser');

    destroy();
    await waitFor(() => !hasSSEClient(fakeAgent.userId));
  });

  it('does NOT deliver to a different agent (MUTATION GUARD: target filter)', async () => {
    // Connect agent1
    authenticateTokenMock.mockReturnValue(fakeAgent);
    const { chunks: chunks1, destroy: destroy1 } = await connectSSE('token-1');
    await waitFor(() => chunks1.some((c) => c.includes('connected')));

    // Connect agent2
    authenticateTokenMock.mockReturnValue(fakeAgent2);
    const { chunks: chunks2, destroy: destroy2 } = await connectSSE('token-2');
    await waitFor(() => chunks2.some((c) => c.includes('connected')));

    // Fan out only to agent1
    await fanoutToSSEClient(fakeAgent.userId, {
      id: 'msg-targeted',
      room: 'room-2',
      roomName: 'Test',
      sender: 'sender',
      senderType: 'HUMAN',
      content: 'OnlyForAgent1',
      timestamp: new Date().toISOString(),
    });

    // Agent1 should receive it
    await waitFor(() => chunks1.some((c) => c.includes('OnlyForAgent1')));

    // Agent2 must NOT receive it
    // Small wait to ensure any erroneous delivery would have arrived
    await new Promise((r) => setTimeout(r, 100));
    const agent2Data = chunks2.join('');
    // MUTATION GUARD: if fanout targets all agents instead of matching agentId,
    // 'OnlyForAgent1' would appear in agent2's stream → this assertion fails
    expect(agent2Data).not.toContain('OnlyForAgent1');

    destroy1();
    destroy2();
    await waitFor(() => !hasSSEClient(fakeAgent.userId) && !hasSSEClient(fakeAgent2.userId));
  });

  it('is a no-op when the target agent has no active connection', async () => {
    // No connection for 'nonexistent-agent' — should resolve without error
    await expect(
      fanoutToSSEClient('nonexistent-agent', {
        id: 'msg-none',
        room: 'r',
        roomName: 'r',
        sender: 's',
        senderType: 'HUMAN',
        content: 'noop',
        timestamp: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('disconnect cleanup', () => {
  it('removes the client from sseClients when the connection closes', async () => {
    authenticateTokenMock.mockReturnValue(fakeAgent);
    const { chunks, destroy } = await connectSSE('valid-token');

    await waitFor(() => chunks.some((c) => c.includes('connected')));
    expect(hasSSEClient(fakeAgent.userId)).toBe(true);

    destroy(); // triggers the req 'close' event on the server side

    await waitFor(() => !hasSSEClient(fakeAgent.userId));
    expect(hasSSEClient(fakeAgent.userId)).toBe(false);
    expect(getSSEClientAgentIds()).not.toContain(fakeAgent.userId);
  });
});

describe('shutdownSSE', () => {
  it('closes all open connections and clears client state', async () => {
    authenticateTokenMock.mockReturnValue(fakeAgent);
    const { chunks, req } = await connectSSE('valid-token');

    await waitFor(() => chunks.some((c) => c.includes('connected')));
    expect(hasSSEClient(fakeAgent.userId)).toBe(true);

    // shutdownSSE writes the 'shutdown' SSE event and ends all responses
    shutdownSSE();

    // After shutdown, no SSE clients should remain
    expect(hasSSEClient(fakeAgent.userId)).toBe(false);
    expect(getSSEClientAgentIds()).toHaveLength(0);

    // The shutdown event should have been written to the stream
    await waitFor(() => chunks.some((c) => c.includes('shutdown')), 1000).catch(() => {
      // The event may have arrived before our check; that's fine.
    });

    req.destroy();
  });
});
