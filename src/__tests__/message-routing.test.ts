/**
 * Tests for the Triologue -> agents routing handler registered by index.ts
 * (bridge.onMessage): mention matching and the webhook loop-guard window.
 *
 * The handler is captured from the mocked bridge and driven directly, so no
 * socket or port is involved. The real loop-guard runs (not mocked), because
 * the point is when its 30-second window starts.
 *
 * Mutation guards:
 *   - lowercasing only the message text (not mentionKey/username) makes the
 *     mixed-case tests fail
 *   - moving shouldDeliver back before the mention check makes the
 *     "unmentioned AI message does not start the window" test fail
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../types.js';

process.env.GATEWAY_TOKEN = 'test-gateway-token';

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(),
  dispatchWebhook: vi.fn(),
  webhookAgents: [] as unknown[],
  allAgents: [] as unknown[],
  fanout: vi.fn().mockResolvedValue(undefined),
  hasSSE: vi.fn().mockReturnValue(false),
}));

vi.mock('../triologue-bridge', () => {
  class MockBridge {
    sendAsAgent = vi.fn();
    onMessage = mocks.onMessage;
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
  authenticateToken: vi.fn(),
  getWebhookAgents: () => mocks.webhookAgents,
  getAgentByUsername: vi.fn().mockReturnValue(null),
  getAllAgents: () => mocks.allAgents,
  startSync: vi.fn().mockResolvedValue(undefined),
  stopSync: vi.fn(),
}));

vi.mock('../webhook-dispatch', () => ({ dispatchWebhook: mocks.dispatchWebhook }));

vi.mock('ioredis', () => ({ Redis: class { on = vi.fn(); disconnect = vi.fn(); } }));

vi.mock('../byoa-sse', () => ({
  sseRouter: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  setBridge: vi.fn(),
  hasSSEClient: mocks.hasSSE,
  fanoutToSSEClient: mocks.fanout,
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

type Handler = (msg: Record<string, unknown>) => Promise<void>;
const handler = mocks.onMessage.mock.calls[0][0] as Handler;

let seq = 0;
function webhookAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  seq += 1;
  return {
    id: `a${seq}`,
    name: 'Hook',
    userId: `user-${seq}`,
    username: `HookBot${seq}`,
    mentionKey: `HookKey${seq}`,
    webhookUrl: 'https://hook.example/cb',
    webhookSecret: null,
    trustLevel: 'standard',
    emoji: '🤖',
    color: null,
    connectionType: 'webhook',
    receiveMode: 'mentions',
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `msg-${seq}`,
    content: 'hello',
    senderUsername: 'other-ai',
    senderType: 'ai',
    senderId: 'sender-1',
    roomId: 'room-1',
    timestamp: '2000-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.dispatchWebhook.mockClear();
  mocks.fanout.mockClear();
  mocks.hasSSE.mockReset().mockReturnValue(false);
  mocks.webhookAgents = [];
  mocks.allAgents = [];
});

describe('mention matching is case-insensitive on both sides', () => {
  it('webhook agent with a mixed-case mentionKey matches lowercase and uppercase text', async () => {
    const agent = webhookAgent({ mentionKey: 'MixedKey', username: 'lowuser' });
    mocks.webhookAgents = [agent];

    await handler(message({ senderType: 'human', senderUsername: 'human1', content: 'hi @mixedkey' }));
    await handler(message({ senderType: 'human', senderUsername: 'human1', content: 'hi @MIXEDKEY' }));

    expect(mocks.dispatchWebhook).toHaveBeenCalledTimes(2);
  });

  it('webhook agent with a mixed-case username matches', async () => {
    const agent = webhookAgent({ mentionKey: 'k', username: 'CamelUser' });
    mocks.webhookAgents = [agent];

    await handler(message({ senderType: 'human', senderUsername: 'human1', content: 'ping @camelUSER' }));

    expect(mocks.dispatchWebhook).toHaveBeenCalledTimes(1);
  });

  it('SSE agent with a mixed-case mentionKey matches in receiveMode mentions', async () => {
    const agent = webhookAgent({ mentionKey: 'SseKey', username: 'ssebot', receiveMode: 'mentions' });
    mocks.allAgents = [agent];
    mocks.hasSSE.mockReturnValue(true);

    await handler(message({ senderType: 'human', senderUsername: 'human1', content: '@ssekey look' }));

    expect(mocks.fanout).toHaveBeenCalledTimes(1);
  });

  it('a message without any mention is not dispatched', async () => {
    mocks.webhookAgents = [webhookAgent()];

    await handler(message({ senderType: 'human', senderUsername: 'human1', content: 'no mention here' }));

    expect(mocks.dispatchWebhook).not.toHaveBeenCalled();
  });
});

describe('webhook loop-guard window starts only on a delivery', () => {
  it('an unmentioned AI message does not block a following AI @mention', async () => {
    const agent = webhookAgent({ mentionKey: 'winkey', username: 'winuser' });
    mocks.webhookAgents = [agent];

    await handler(message({ content: 'chatter without a mention' }));
    expect(mocks.dispatchWebhook).not.toHaveBeenCalled();

    await handler(message({ content: 'now @winkey please' }));
    expect(mocks.dispatchWebhook).toHaveBeenCalledTimes(1);
  });

  it('a second AI @mention within the window after a delivery is still held back', async () => {
    const agent = webhookAgent({ mentionKey: 'repkey', username: 'repuser' });
    mocks.webhookAgents = [agent];

    await handler(message({ content: '@repkey one' }));
    await handler(message({ content: '@repkey two' }));

    expect(mocks.dispatchWebhook).toHaveBeenCalledTimes(1);
  });
});
