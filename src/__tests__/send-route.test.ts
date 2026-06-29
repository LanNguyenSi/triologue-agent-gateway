/**
 * Tests for the POST /send route in src/index.ts.
 *
 * Production seam: index.ts exports `app` and guards `start()` with
 * `if (!process.env.VITEST)`. This lets tests import the Express app,
 * mount it on an ephemeral port, and call /send in isolation without
 * spawning a real Triologue connection or WebSocket server.
 *
 * All heavy dependencies are mocked so no real network calls are made.
 *
 * Covers:
 *   - Missing Authorization header → 401
 *   - Invalid/unknown token → 403
 *   - Missing room or content → 400
 *   - bridge.sendAsAgent throws → 500
 *   - Valid request → 200 { ok: true } + sendAsAgent called with correct args
 *
 * Mutation guard (M-auth):
 *   Breaking the auth check in /send (skipping token validation) causes the
 *   401 and 403 tests to fail because requests without a valid token succeed.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentInfo } from '../types.js';

// ── Set required env var BEFORE index.ts loads ────────────────────────────────
// index.ts has `if (!GATEWAY_TOKEN) { process.exit(1) }` at module level.
// Setting it here, before the dynamic import below, ensures the guard passes.
process.env.GATEWAY_TOKEN = 'test-gateway-token';

// ── Shared mock references via vi.hoisted ─────────────────────────────────────
// vi.hoisted runs before vi.mock factories — use it for references that must be
// reachable both in the factory closure and in test assertions.

const mocks = vi.hoisted(() => ({
  sendAsAgent: vi.fn<(token: string, room: string, content: string) => Promise<void>>(),
  onMessage: vi.fn(),
  onTaskAssigned: vi.fn(),
  authenticateToken: vi.fn<(token: string) => AgentInfo | null>(),
}));

// ── TriologueBridge mock ───────────────────────────────────────────────────────
// vi.fn().mockImplementation(() => obj) creates an arrow-function wrapper that
// is not a valid constructor (TypeError: not a constructor). A proper class
// satisfies `new TriologueBridge(...)` and lets each instance share the same
// mock functions via the vi.hoisted references above.

vi.mock('../triologue-bridge', () => {
  class MockBridge {
    sendAsAgent = mocks.sendAsAgent;
    onMessage = mocks.onMessage;
    onTaskAssigned = mocks.onTaskAssigned;
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    getAgentRooms = vi.fn().mockResolvedValue([]);
    fetchMessagesSince = vi.fn().mockResolvedValue([]);
  }
  return { TriologueBridge: MockBridge };
});

// ── Auth mock ─────────────────────────────────────────────────────────────────

vi.mock('../auth', () => ({
  loadAgents: vi.fn(),
  buildTokenIndex: vi.fn(),
  authenticateToken: (token: string) => mocks.authenticateToken(token),
  getWebhookAgents: vi.fn().mockReturnValue([]),
  getAgentByUsername: vi.fn().mockReturnValue(null),
  getAllAgents: vi.fn().mockReturnValue([]),
  startSync: vi.fn().mockResolvedValue(undefined),
  stopSync: vi.fn(),
}));

// ── ioredis mock (consumed transitively by byoa-sse when it loads) ────────────

vi.mock('ioredis', () => {
  class MockRedis {
    incr = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    zadd = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    expire = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    zrangebyscore = vi.fn<() => Promise<string[]>>().mockResolvedValue([]);
    set = vi.fn<() => Promise<string>>().mockResolvedValue('OK');
    get = vi.fn<() => Promise<string | null>>().mockResolvedValue(null);
    disconnect = vi.fn();
    on = vi.fn();
  }
  return { Redis: MockRedis };
});

// ── byoa-sse mock — avoids real Redis connections at module load ───────────────
// Express router usage: app.use('/byoa/sse', sseRouter). A passthrough function
// is sufficient — it handles no routes so /send is unaffected.

vi.mock('../byoa-sse', () => ({
  sseRouter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  setBridge: vi.fn(),
  hasSSEClient: vi.fn().mockReturnValue(false),
  fanoutToSSEClient: vi.fn().mockResolvedValue(undefined),
  shutdownSSE: vi.fn(),
  getSSEClientAgentIds: vi.fn().mockReturnValue([]),
}));

// ── byoa-mcp mock ─────────────────────────────────────────────────────────────

vi.mock('../byoa-mcp', () => ({
  mcpRouter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  setBridge: vi.fn(),
}));

// ── agent-tasks-bridge mock ───────────────────────────────────────────────────

vi.mock('../agent-tasks-bridge', () => ({
  createAgentTasksBridgeRouter: vi.fn().mockReturnValue(
    vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  ),
}));

// ── read-tracker mock ─────────────────────────────────────────────────────────

vi.mock('../read-tracker', () => ({
  loadReadTracker: vi.fn(),
  getLastSeenMessageId: vi.fn().mockReturnValue(null),
  markMessageSeen: vi.fn(),
}));

// ── metrics mock ──────────────────────────────────────────────────────────────

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

// ── Import app after all mocks are registered ─────────────────────────────────
// Dynamic import ensures mocks are in place before index.ts module body runs.
// index.ts is safe to import: start() is guarded by `if (!process.env.VITEST)`.

const { app } = await import('../index.js');

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const fakeAgent: AgentInfo = {
  id: 'user-send-001',
  name: 'SendBot',
  userId: 'user-send-001',
  username: 'sendbot',
  mentionKey: 'send',
  webhookUrl: null,
  webhookSecret: null,
  trustLevel: 'standard',
  emoji: '📤',
  color: null,
  connectionType: 'both',
  receiveMode: 'mentions',
  delivery: 'webhook',
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function postSend(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mocks.authenticateToken.mockReset();
  mocks.sendAsAgent.mockReset();
});

describe('POST /send — auth checks', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const { status, body } = await postSend({ room: 'r1', content: 'hello' });
    // MUTATION GUARD M-auth: if auth check is skipped → 400/200 instead; fails
    expect(status).toBe(401);
    expect((body as any).error).toMatch(/missing/i);
    expect(mocks.authenticateToken).not.toHaveBeenCalled();
  });

  it('returns 403 when the token is not recognised', async () => {
    mocks.authenticateToken.mockReturnValue(null);
    const { status, body } = await postSend(
      { room: 'r1', content: 'hello' },
      { Authorization: 'Bearer byoa_bad_token' },
    );
    // MUTATION GUARD M-auth: if token validation is removed → 200; fails
    expect(status).toBe(403);
    expect((body as any).error).toMatch(/invalid/i);
  });

  it('passes the Bearer token to authenticateToken', async () => {
    mocks.authenticateToken.mockReturnValue(null);
    await postSend(
      { room: 'r1', content: 'hi' },
      { Authorization: 'Bearer byoa_check_me' },
    );
    expect(mocks.authenticateToken).toHaveBeenCalledWith('byoa_check_me');
  });
});

describe('POST /send — body validation', () => {
  beforeEach(() => {
    mocks.authenticateToken.mockReturnValue(fakeAgent);
  });

  it('returns 400 when room is missing', async () => {
    const { status } = await postSend(
      { content: 'hello' },
      { Authorization: 'Bearer byoa_valid' },
    );
    expect(status).toBe(400);
  });

  it('returns 400 when content is missing', async () => {
    const { status } = await postSend(
      { room: 'room-1' },
      { Authorization: 'Bearer byoa_valid' },
    );
    expect(status).toBe(400);
  });

  it('returns 400 when both room and content are missing', async () => {
    const { status } = await postSend({}, { Authorization: 'Bearer byoa_valid' });
    expect(status).toBe(400);
  });
});

describe('POST /send — successful delivery', () => {
  beforeEach(() => {
    mocks.authenticateToken.mockReturnValue(fakeAgent);
    mocks.sendAsAgent.mockResolvedValue(undefined);
  });

  it('returns 200 { ok: true } on a valid request', async () => {
    const { status, body } = await postSend(
      { room: 'room-1', content: 'Hello world' },
      { Authorization: 'Bearer byoa_valid' },
    );
    expect(status).toBe(200);
    expect((body as any).ok).toBe(true);
  });

  it('calls bridge.sendAsAgent with the extracted token, room, and content', async () => {
    await postSend(
      { room: 'room-42', content: 'test message' },
      { Authorization: 'Bearer byoa_exact_token' },
    );
    expect(mocks.sendAsAgent).toHaveBeenCalledTimes(1);
    expect(mocks.sendAsAgent).toHaveBeenCalledWith('byoa_exact_token', 'room-42', 'test message');
  });
});

describe('POST /send — bridge error', () => {
  beforeEach(() => {
    mocks.authenticateToken.mockReturnValue(fakeAgent);
  });

  it('returns 500 when bridge.sendAsAgent throws', async () => {
    mocks.sendAsAgent.mockRejectedValue(new Error('bridge failure'));
    const { status, body } = await postSend(
      { room: 'room-1', content: 'hi' },
      { Authorization: 'Bearer byoa_valid' },
    );
    expect(status).toBe(500);
    expect((body as any).error).toBe('bridge failure');
  });
});
