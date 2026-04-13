/**
 * Integration tests for the BYOA MCP endpoint.
 *
 * Mounts the router on an ephemeral express server, mocks the
 * `authenticateToken` helper and the `TriologueBridge` so each test
 * runs in isolation without touching auth state or the real Triologue
 * backend. Covers the three behavioural guarantees that matter:
 *
 * 1. Missing / invalid Bearer token is rejected with 401 before any
 *    MCP machinery runs.
 * 2. A valid token can list the three registered tools
 *    (`list_rooms`, `get_room_messages`, `send_message`).
 * 3. A `tools/call` for `send_message` forwards to
 *    `bridge.sendAsAgent` with the caller's token + args.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentInfo } from '../types';

const fakeAgent: AgentInfo = {
  name: 'Test Bot',
  username: 'test-bot',
  mentionKey: 'test',
  emoji: '🤖',
  userId: 'user-1',
  trustLevel: 'standard',
  delivery: 'websocket',
} as unknown as AgentInfo;

const authenticateTokenMock = vi.fn();
const bridgeMock = {
  getAgentRooms: vi.fn(),
  fetchMessagesSince: vi.fn(),
  sendAsAgent: vi.fn(),
};

vi.mock('../auth', () => ({
  authenticateToken: (token: string) => authenticateTokenMock(token),
}));

// Import after the mock so the module wiring picks it up.
const { mcpRouter, setBridge } = await import('../byoa-mcp.js');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  setBridge(bridgeMock as unknown as import('../triologue-bridge').TriologueBridge);
  const app = express();
  app.use(express.json());
  app.use('/byoa/mcp', mcpRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/byoa/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  authenticateTokenMock.mockReset();
  bridgeMock.getAgentRooms.mockReset();
  bridgeMock.fetchMessagesSince.mockReset();
  bridgeMock.sendAsAgent.mockReset();
});

async function mcpRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  // Streamable HTTP may return JSON or SSE; both are safe to read as text.
  const raw = await res.text();
  let parsed: unknown = raw;
  if (raw) {
    // Strip SSE framing if present: "event: message\ndata: {...}\n\n".
    const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
    if (dataLine) {
      parsed = JSON.parse(dataLine.slice(6));
    } else {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
  }
  return { status: res.status, body: parsed };
}

describe('byoa-mcp auth gate', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await mcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res.status).toBe(401);
    expect(authenticateTokenMock).not.toHaveBeenCalled();
  });

  it('rejects a request with an invalid Bearer token', async () => {
    authenticateTokenMock.mockReturnValue(null);
    const res = await mcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { Authorization: 'Bearer bad_token' },
    );
    expect(res.status).toBe(401);
    expect(authenticateTokenMock).toHaveBeenCalledWith('bad_token');
  });
});

describe('byoa-mcp tool dispatch', () => {
  beforeEach(() => {
    authenticateTokenMock.mockReturnValue(fakeAgent);
  });

  async function listToolsDirectly(): Promise<string[]> {
    // In true stateless mode the SDK's Streamable HTTP transport does
    // NOT persist any session state between POSTs — each request is an
    // independent round-trip. The tests below send `tools/list`
    // WITHOUT a prior `initialize`, pinning the observed behaviour
    // that tool listing works on a fresh server. If the SDK ever
    // tightens this to require per-request init, this test will flip
    // red and force us to decide whether to batch or to make the
    // endpoint strictly spec-compliant.
    const listRes = await mcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { Authorization: 'Bearer good_token' },
    );
    expect(listRes.status).toBe(200);
    const payload = listRes.body as { result?: { tools?: Array<{ name: string }> } };
    return (payload.result?.tools ?? []).map((t) => t.name);
  }

  it('registers list_rooms, get_room_messages, and send_message', async () => {
    const names = await listToolsDirectly();
    expect(names.sort()).toEqual(['get_room_messages', 'list_rooms', 'send_message']);
  });

  it('send_message forwards the token + room + content to bridge.sendAsAgent', async () => {
    bridgeMock.sendAsAgent.mockResolvedValue(undefined);
    const callRes = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'send_message',
          arguments: { room_id: 'room-1', content: 'hello from mcp' },
        },
      },
      { Authorization: 'Bearer good_token' },
    );

    expect(callRes.status).toBe(200);
    expect(bridgeMock.sendAsAgent).toHaveBeenCalledTimes(1);
    expect(bridgeMock.sendAsAgent).toHaveBeenCalledWith(
      'good_token',
      'room-1',
      'hello from mcp',
    );
  });

  it('get_room_messages forwards token + room + pagination args to bridge.fetchMessagesSince', async () => {
    bridgeMock.fetchMessagesSince.mockResolvedValue([
      { id: 'm1', content: 'earlier' },
      { id: 'm2', content: 'later' },
    ]);
    const callRes = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_room_messages',
          arguments: { room_id: 'room-1', limit: 25, after_message_id: 'm0' },
        },
      },
      { Authorization: 'Bearer good_token' },
    );
    expect(callRes.status).toBe(200);
    expect(bridgeMock.fetchMessagesSince).toHaveBeenCalledWith(
      'good_token',
      'room-1',
      'm0',
      25,
    );
  });

  it('get_room_messages defaults limit to 50 and after_message_id to null when omitted', async () => {
    bridgeMock.fetchMessagesSince.mockResolvedValue([]);
    await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_room_messages',
          arguments: { room_id: 'room-2' },
        },
      },
      { Authorization: 'Bearer good_token' },
    );
    expect(bridgeMock.fetchMessagesSince).toHaveBeenCalledWith(
      'good_token',
      'room-2',
      null,
      50,
    );
  });
});

describe('byoa-mcp method guard', () => {
  it('rejects GET /byoa/mcp with 405 without touching auth', async () => {
    const res = await fetch(baseUrl, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(authenticateTokenMock).not.toHaveBeenCalled();
  });

  it('rejects DELETE /byoa/mcp with 405 without touching auth', async () => {
    const res = await fetch(baseUrl, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(authenticateTokenMock).not.toHaveBeenCalled();
  });
});
