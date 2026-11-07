/**
 * /health reports the running build's version (read once at startup from the
 * repository's root package.json by src/version.ts) so a rebuilt deployment
 * can be verified from outside, and /metrics stays free of it.
 *
 * index.ts is imported with its dependencies stubbed the way
 * message-routing.test.ts stubs them; `app` is then served on an ephemeral
 * port and hit with fetch. metrics is NOT stubbed here, so the /metrics
 * assertions run against the real report and snapshot.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:http';
import { fileURLToPath } from 'node:url';

process.env.GATEWAY_TOKEN = 'test-gateway-token';

vi.mock('ws', () => ({
  WebSocketServer: class {
    on = vi.fn();
    close = vi.fn();
  },
  WebSocket: { OPEN: 1 },
}));

vi.mock('../triologue-bridge', () => {
  class MockBridge {
    sendAsAgent = vi.fn();
    onMessage = vi.fn();
    onTaskAssigned = vi.fn();
    connect = vi.fn();
    disconnect = vi.fn();
    getAgentRooms = vi.fn().mockResolvedValue([]);
    fetchMessagesSince = vi.fn().mockResolvedValue([]);
  }
  return { TriologueBridge: MockBridge };
});

vi.mock('../auth', () => ({
  loadAgents: vi.fn(),
  buildTokenIndex: vi.fn(),
  getCurrentTokenForAgent: vi.fn().mockReturnValue(null),
  authenticateToken: vi.fn().mockReturnValue(null),
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

const { app } = await import('../index.js');

const ROOT_VERSION: string = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
).version;

let baseUrl: string;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
});

afterAll(async () => {
  await closeServer();
});

describe('GET /health version field', () => {
  it('version is the repository root package.json version', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe(ROOT_VERSION);
    expect(typeof body.version).toBe('string');
  });
});

describe('version stays out of /metrics', () => {
  it('GET /metrics text report contains no version field', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('version');
    expect(text).not.toContain(ROOT_VERSION);
  });

  it('GET /metrics/json snapshot has no version key', async () => {
    const res = await fetch(`${baseUrl}/metrics/json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).not.toContain('version');
    expect(JSON.stringify(body)).not.toContain(ROOT_VERSION);
  });
});
