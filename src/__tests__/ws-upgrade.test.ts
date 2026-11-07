/**
 * Regression tests for the WebSocket upgrade routing on the real server:
 * the WebSocketServer in src/index.ts is constructed as
 * `new WebSocketServer({ server, path: '/byoa/ws' })`, so only upgrades to
 * /byoa/ws may reach the gateway's connection handler, the token check on
 * the first `auth` frame decides accept/refuse, and other paths get no
 * upgrade at all.
 *
 * Unlike the other index.ts tests this one does NOT mock `ws`: the point is
 * the real upgrade handshake. The http module is mocked only to capture the
 * `http.createServer(app)` instance index.ts builds at module load, so the
 * test can listen on an ephemeral port without changing src/index.ts. All
 * other index.ts dependencies are stubbed the way message-routing.test.ts
 * stubs them (auth in particular: authenticateToken is a plain token
 * comparison here).
 *
 * Mutation guards:
 *   - dropping `path: '/byoa/ws'` from the WebSocketServer options makes the
 *     "/byoa/other gets no upgrade" test fail (the socket opens instead of
 *     being refused with HTTP 400)
 *   - skipping the `if (!agent)` refusal makes the invalid-token test fail
 *     (no auth_error frame and no 4003 close)
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { AgentInfo } from '../types.js';

process.env.GATEWAY_TOKEN = 'test-gateway-token';

const VALID_TOKEN = 'byoa_valid_token_for_ws_test';
const REFUSED_TOKEN = 'byoa_wrong_token_for_ws_test';

const AGENT: AgentInfo = {
  id: 'ws-test-1',
  name: 'WsTester',
  userId: 'ws-user-1',
  username: 'WsTester',
  mentionKey: 'wstester',
  webhookUrl: null,
  webhookSecret: null,
  trustLevel: 'standard',
  emoji: '🧪',
  color: null,
  connectionType: 'websocket',
  receiveMode: 'mentions',
};

const AGENT_ROOMS = [{ id: 'room-1', name: 'general' }];

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getAgentRooms: vi.fn(),
  serverHolder: { server: null as Server | null },
}));

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  const original = actual.createServer.bind(actual);
  return {
    ...actual,
    createServer: (...args: never[]) => {
      const srv = (original as (...a: unknown[]) => Server)(...args);
      mocks.serverHolder.server = srv;
      return srv;
    },
  };
});

vi.mock('../triologue-bridge', () => {
  class MockBridge {
    sendAsAgent = vi.fn();
    onMessage = vi.fn();
    onTaskAssigned = vi.fn();
    connect = vi.fn();
    disconnect = vi.fn();
    getAgentRooms = mocks.getAgentRooms;
    fetchMessagesSince = vi.fn().mockResolvedValue([]);
  }
  return { TriologueBridge: MockBridge };
});

vi.mock('../auth', () => ({
  loadAgents: vi.fn(),
  buildTokenIndex: vi.fn(),
  getCurrentTokenForAgent: vi.fn().mockReturnValue(null),
  authenticateToken: (t: string) => mocks.authenticate(t),
  getWebhookAgents: () => [],
  getAgentByUsername: vi.fn().mockReturnValue(null),
  getAllAgents: () => [],
  startSync: vi.fn().mockResolvedValue(undefined),
  stopSync: vi.fn(),
}));

vi.mock('../webhook-dispatch', () => ({ dispatchWebhook: vi.fn() }));

vi.mock('ioredis', () => ({ Redis: class { on = vi.fn(); disconnect = vi.fn(); } }));

vi.mock('../sessions', () => ({
  SessionRegistry: class {
    on = vi.fn();
    off = vi.fn();
    sessionsForRoom = vi.fn().mockResolvedValue([]);
    sessionsForThread = vi.fn().mockResolvedValue([]);
    sweep = vi.fn().mockResolvedValue(0);
    agents = vi.fn().mockResolvedValue([]);
    list = vi.fn().mockResolvedValue([]);
  },
  createSessionsRouter: () => vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  SWEEP_INTERVAL_MS: 30_000,
  SESSION_ID_RE: /^[A-Za-z0-9_-]{1,64}$/,
}));

vi.mock('../presence-push', () => ({
  PresencePusher: class {
    schedule = vi.fn();
    push = vi.fn().mockResolvedValue(undefined);
    refreshAll = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
  },
}));

vi.mock('../byoa-sse', () => ({
  sseRouter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  setBridge: vi.fn(),
  hasSSEClient: vi.fn().mockReturnValue(false),
  fanoutToSSEClient: vi.fn().mockResolvedValue(undefined),
  shutdownSSE: vi.fn(),
  getSSEClientAgentIds: vi.fn().mockReturnValue([]),
}));

vi.mock('../byoa-mcp', () => ({
  mcpRouter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  setBridge: vi.fn(),
}));

vi.mock('../agent-tasks-bridge', () => ({
  createAgentTasksBridgeRouter: vi.fn().mockReturnValue(
    vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  ),
}));

vi.mock('../read-tracker', () => ({
  loadReadTracker: vi.fn(),
  getLastSeenMessageId: vi.fn().mockReturnValue(null),
  markMessageSeen: vi.fn(),
}));

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

await import('../index.js');

let server: Server;
let port: number;
const openSockets: WebSocket[] = [];

function connect(pathname: string): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`);
  openSockets.push(ws);
  return ws;
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err: Error) => reject(err));
  });
}

function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    ws.once('error', (err: Error) => reject(err));
  });
}

function closed(ws: WebSocket): Promise<[number, string]> {
  return new Promise((resolve, reject) => {
    ws.once('close', (code, reason) => resolve([code, reason.toString()]));
    ws.once('error', (err: Error) => reject(err));
  });
}

beforeAll(async () => {
  server = mocks.serverHolder.server!;
  mocks.authenticate.mockImplementation((t: string) => (t === VALID_TOKEN ? AGENT : null));
  mocks.getAgentRooms.mockResolvedValue(AGENT_ROOMS);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('WebSocket upgrade routing on /byoa/ws', () => {
  it('a connection to /byoa/ws with a valid token is accepted and receives the auth_ok first frame', async () => {
    const ws = connect('/byoa/ws');
    await opened(ws);
    ws.send(JSON.stringify({ type: 'auth', token: VALID_TOKEN }));

    const frame = await nextFrame(ws);
    expect(frame).toEqual({
      type: 'auth_ok',
      agent: {
        name: AGENT.name,
        username: AGENT.username,
        mentionKey: AGENT.mentionKey,
        emoji: AGENT.emoji,
        trustLevel: AGENT.trustLevel,
      },
      rooms: AGENT_ROOMS,
    });

    ws.close();
    await closed(ws);
  });

  it('a connection to /byoa/ws with an invalid token is refused with an auth_error frame and close code 4003', async () => {
    const ws = connect('/byoa/ws');
    await opened(ws);
    ws.send(JSON.stringify({ type: 'auth', token: REFUSED_TOKEN }));

    const frame = await nextFrame(ws);
    expect(frame).toEqual({ type: 'auth_error', error: 'Invalid or inactive token' });

    const [code, reason] = await closed(ws);
    expect(code).toBe(4003);
    expect(reason).toBe('Auth failed');
  });

  it('an upgrade to /byoa/other gets no upgrade (refused with HTTP 400 by the path option)', async () => {
    const ws = connect('/byoa/other');
    const err = await new Promise<Error>((resolve, reject) => {
      ws.once('error', resolve);
      ws.once('open', () => reject(new Error('upgrade unexpectedly succeeded on /byoa/other')));
    });
    expect(err.message).toMatch(/400/);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
