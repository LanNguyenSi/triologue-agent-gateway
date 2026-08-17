/**
 * Tests for src/triologue-bridge.ts (TriologueBridge).
 *
 * axios, fs, and socket.io-client are all mocked - no real network or
 * disk I/O. socket.io's `io()` factory returns a MockSocket (a plain
 * EventEmitter matching the subset of the Socket API the source uses:
 * on/emit/connected/volatile/removeAllListeners/disconnect).
 *
 * Covers the "outbound delivery" surface (sendAsAgent, fetchMessagesSince,
 * getAgentRooms - success + failure/retry-relevant branches) and the JWT
 * authenticate() cache logic that gates every outbound call, all exercised
 * per the class's public API (connect/sendAsAgent/fetchMessagesSince/
 * getAgentRooms/disconnect - authenticate/createSocket are private and
 * only reachable through connect()).
 *
 * Mutation guards (marked inline):
 *   M1: sendAsAgent stops filtering NO_REPLY / HEARTBEAT_OK control strings
 *   M2: sendAsAgent stops sending the Bearer token header
 *   M3: fetchMessagesSince stops reversing the message order
 *   M4: fetchMessagesSince stops omitting `after` when afterId is null
 *   M5: fetchMessagesSince stops catching axios errors (would throw
 *       instead of returning [])
 *   M6: getAgentRooms stops catching axios errors (would throw instead
 *       of returning [])
 *   M7: authenticate() stops reusing a still-valid cached JWT (would
 *       always hit /api/auth/login)
 *   M8: authenticate() stops treating an expired cached JWT as invalid
 *   M9: scheduleReconnect stops doubling the backoff delay per attempt
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const axiosMocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));
vi.mock('axios', () => ({ default: axiosMocks }));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock('fs', () => ({ default: fsMocks }));

class MockSocket extends EventEmitter {
  static instances: MockSocket[] = [];
  connected = false;
  volatile = { emit: vi.fn() };
  removeAllListeners = vi.fn(() => {
    super.removeAllListeners();
    return this;
  });
  disconnect = vi.fn();

  constructor(public url: string, public opts: unknown) {
    super();
    MockSocket.instances.push(this);
  }
}

const ioMock = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: ioMock }));

const { TriologueBridge } = await import('../triologue-bridge.js');

function makeJwt(expSecondsFromNow: number): string {
  const payload = { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

beforeEach(() => {
  MockSocket.instances = [];
  axiosMocks.post.mockReset();
  axiosMocks.get.mockReset();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.unlinkSync.mockReset();
  ioMock.mockReset().mockImplementation((url: string, opts: unknown) => new MockSocket(url, opts));
});

afterEach(() => {
  vi.useRealTimers();
});

function makeBridge() {
  return new TriologueBridge({
    trioUrl: 'https://trio.test',
    username: 'gateway-bot',
    aiToken: 'byoa_gateway_token',
    userType: 'AI_AGENT',
  });
}

// ── sendAsAgent ────────────────────────────────────────────────────────────────

describe('sendAsAgent', () => {
  it('posts the message with a Bearer token header (M2)', async () => {
    axiosMocks.post.mockResolvedValue({ data: {} });
    const bridge = makeBridge();

    await bridge.sendAsAgent('byoa_agent_tok', 'room-1', 'hi there');

    expect(axiosMocks.post).toHaveBeenCalledWith(
      'https://trio.test/api/agents/message',
      { roomId: 'room-1', content: 'hi there' },
      { headers: { Authorization: 'Bearer byoa_agent_tok' } },
    );
  });

  it.each(['NO_REPLY', 'HEARTBEAT_OK', '  NO_REPLY  '])(
    'filters the control string "%s" without calling axios (M1)',
    async (content) => {
      const bridge = makeBridge();
      await bridge.sendAsAgent('byoa_agent_tok', 'room-1', content);
      // MUTATION GUARD M1: drop the control-string filter → this would
      // POST the literal control string into the room; fails.
      expect(axiosMocks.post).not.toHaveBeenCalled();
    },
  );

  it('does not filter a message that merely contains a control string as a substring', async () => {
    axiosMocks.post.mockResolvedValue({ data: {} });
    const bridge = makeBridge();

    await bridge.sendAsAgent('byoa_agent_tok', 'room-1', 'NO_REPLY please respond anyway');

    expect(axiosMocks.post).toHaveBeenCalled();
  });

  it('propagates an axios rejection to the caller', async () => {
    axiosMocks.post.mockRejectedValue(new Error('502 Bad Gateway'));
    const bridge = makeBridge();

    await expect(bridge.sendAsAgent('byoa_agent_tok', 'room-1', 'hello')).rejects.toThrow(
      '502 Bad Gateway',
    );
  });
});

// ── fetchMessagesSince ────────────────────────────────────────────────────────

describe('fetchMessagesSince', () => {
  it('reverses the API response into oldest-first order (M3)', async () => {
    axiosMocks.get.mockResolvedValue({
      data: { messages: [{ id: 'm3' }, { id: 'm2' }, { id: 'm1' }] },
    });
    const bridge = makeBridge();

    const result = await bridge.fetchMessagesSince('byoa_tok', 'room-1', null);

    // MUTATION GUARD M3: drop `.reverse()` → newest-first order; fails
    expect(result).toEqual([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
  });

  it('omits the `after` param when afterId is null (M4)', async () => {
    axiosMocks.get.mockResolvedValue({ data: { messages: [] } });
    const bridge = makeBridge();

    await bridge.fetchMessagesSince('byoa_tok', 'room-1', null, 10);

    const [, opts] = axiosMocks.get.mock.calls[0];
    // MUTATION GUARD M4: always set `params.after` (even to null/undefined)
    // → the API would receive an unwanted after= param; fails.
    expect(opts.params).toEqual({ limit: 10 });
  });

  it('includes the `after` param when afterId is set', async () => {
    axiosMocks.get.mockResolvedValue({ data: { messages: [] } });
    const bridge = makeBridge();

    await bridge.fetchMessagesSince('byoa_tok', 'room-1', 'm42', 25);

    const [url, opts] = axiosMocks.get.mock.calls[0];
    expect(url).toBe('https://trio.test/api/messages/room-1');
    expect(opts.params).toEqual({ limit: 25, after: 'm42' });
    expect(opts.headers).toEqual({ Authorization: 'Bearer byoa_tok' });
  });

  it('defaults to an empty messages array when the response has none', async () => {
    axiosMocks.get.mockResolvedValue({ data: {} });
    const bridge = makeBridge();

    const result = await bridge.fetchMessagesSince('byoa_tok', 'room-1', null);

    expect(result).toEqual([]);
  });

  it('catches axios errors and returns an empty array instead of throwing (M5)', async () => {
    axiosMocks.get.mockRejectedValue(new Error('timeout'));
    const bridge = makeBridge();

    // MUTATION GUARD M5: drop the try/catch → this rejects instead of
    // resolving []; fails.
    await expect(bridge.fetchMessagesSince('byoa_tok', 'room-1', null)).resolves.toEqual([]);
  });
});

// ── getAgentRooms ─────────────────────────────────────────────────────────────

describe('getAgentRooms', () => {
  it('logs in as the agent and maps the room list to { id, name }', async () => {
    axiosMocks.post.mockResolvedValue({ data: { token: 'jwt-for-agent' } });
    axiosMocks.get.mockResolvedValue({
      data: [
        { id: 'r1', name: 'General', extra: 'ignored' },
        { id: 'r2', name: 'Random' },
      ],
    });
    const bridge = makeBridge();

    const rooms = await bridge.getAgentRooms('byoa_agent_tok', 'agentname');

    expect(axiosMocks.post).toHaveBeenCalledWith('https://trio.test/api/auth/login', {
      username: 'agentname',
      aiToken: 'byoa_agent_tok',
      userType: 'AI_AGENT',
    });
    expect(axiosMocks.get).toHaveBeenCalledWith('https://trio.test/api/rooms', {
      headers: { Authorization: 'Bearer jwt-for-agent' },
    });
    expect(rooms).toEqual([
      { id: 'r1', name: 'General' },
      { id: 'r2', name: 'Random' },
    ]);
  });

  it('catches errors (login or rooms fetch) and returns [] (M6)', async () => {
    axiosMocks.post.mockRejectedValue(new Error('invalid credentials'));
    const bridge = makeBridge();

    // MUTATION GUARD M6: drop the try/catch → this rejects instead of
    // resolving []; fails.
    await expect(bridge.getAgentRooms('byoa_agent_tok', 'agentname')).resolves.toEqual([]);
  });
});

// ── authenticate() via connect() - JWT cache logic ─────────────────────────────

describe('connect() - JWT cache / authenticate()', () => {
  it('performs a fresh login and caches the JWT when no cache file exists', async () => {
    const jwt = makeJwt(3600);
    axiosMocks.post.mockResolvedValue({ data: { token: jwt } });
    fsMocks.existsSync.mockReturnValue(false);
    const bridge = makeBridge();

    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(MockSocket.instances.length).toBe(1));
    MockSocket.instances[0].connected = true;
    MockSocket.instances[0].emit('connect');
    await connectPromise;

    expect(axiosMocks.post).toHaveBeenCalledWith('https://trio.test/api/auth/login', {
      username: 'gateway-bot',
      aiToken: 'byoa_gateway_token',
      userType: 'AI_AGENT',
    });
    expect(fsMocks.writeFileSync).toHaveBeenCalled();
    const [, cached] = fsMocks.writeFileSync.mock.calls[0];
    expect(JSON.parse(cached as string).token).toBe(jwt);
  });

  it('reuses a still-valid cached JWT instead of logging in again (M7)', async () => {
    const jwt = makeJwt(3600);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ token: jwt, expiresAt: Date.now() + 3_600_000 }),
    );
    const bridge = makeBridge();

    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(MockSocket.instances.length).toBe(1));
    MockSocket.instances[0].connected = true;
    MockSocket.instances[0].emit('connect');
    await connectPromise;

    // MUTATION GUARD M7: drop the cache-hit early return → this would call
    // /api/auth/login even though the cache is fresh; fails.
    expect(axiosMocks.post).not.toHaveBeenCalledWith(
      'https://trio.test/api/auth/login',
      expect.anything(),
    );
  });

  it('falls back to a fresh login when the cached JWT is expired (M8)', async () => {
    const staleJwt = makeJwt(-10);
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ token: staleJwt, expiresAt: Date.now() - 1000 }),
    );
    axiosMocks.post.mockResolvedValue({ data: { token: makeJwt(3600) } });
    const bridge = makeBridge();

    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(MockSocket.instances.length).toBe(1));
    MockSocket.instances[0].connected = true;
    MockSocket.instances[0].emit('connect');
    await connectPromise;

    // MUTATION GUARD M8: drop the expiry check → an expired cache would
    // be reused forever and /api/auth/login would never be called; fails.
    expect(axiosMocks.post).toHaveBeenCalledWith(
      'https://trio.test/api/auth/login',
      expect.objectContaining({ username: 'gateway-bot' }),
    );
  });

  it('rejects when the socket emits connect_error before the first connect', async () => {
    axiosMocks.post.mockResolvedValue({ data: { token: makeJwt(3600) } });
    fsMocks.existsSync.mockReturnValue(false);
    const bridge = makeBridge();

    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(MockSocket.instances.length).toBe(1));
    MockSocket.instances[0].emit('connect_error', new Error('ECONNREFUSED'));

    await expect(connectPromise).rejects.toThrow('ECONNREFUSED');
  });
});

// ── reconnect backoff (M9) ───────────────────────────────────────────────────

describe('reconnect scheduling', () => {
  it('doubles the reconnect delay across consecutive failed reconnect attempts (M9)', async () => {
    // reconnectAttempts resets to 0 on a *successful* reconnect, so the
    // doubling is only observable across back-to-back *failures* - this
    // drives: disconnect → reconnect#1 fails → reconnect#2 (double delay).
    vi.useFakeTimers();
    axiosMocks.post.mockResolvedValue({ data: { token: makeJwt(3600) } });
    fsMocks.existsSync.mockReturnValue(false);
    const bridge = makeBridge();

    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(MockSocket.instances.length).toBe(1));
    MockSocket.instances[0].connected = true;
    MockSocket.instances[0].emit('connect');
    await connectPromise;

    // Disconnect → schedules reconnect attempt #1 at base delay (2s).
    MockSocket.instances[0].emit('disconnect', 'transport close');
    expect(MockSocket.instances.length).toBe(1); // no new socket yet
    await vi.advanceTimersByTimeAsync(1_999);
    expect(MockSocket.instances.length).toBe(1); // not yet - still short of 2s
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(MockSocket.instances.length).toBe(2));

    // Attempt #1 fails → doReconnect's catch calls scheduleReconnect again.
    // MUTATION GUARD M9: if the delay stops doubling per attempt, attempt
    // #2 below would fire at 2s again instead of 4s.
    MockSocket.instances[1].emit('connect_error', new Error('still down'));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(MockSocket.instances.length).toBe(2); // not yet - still short of 4s
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(MockSocket.instances.length).toBe(3));

    // Attempt #2 succeeds.
    MockSocket.instances[2].connected = true;
    MockSocket.instances[2].emit('connect');
  });
});

// ── disconnect() ──────────────────────────────────────────────────────────────

describe('disconnect()', () => {
  it('tears down the socket and clears the heartbeat', async () => {
    axiosMocks.post.mockResolvedValue({ data: { token: makeJwt(3600) } });
    fsMocks.existsSync.mockReturnValue(false);
    const bridge = makeBridge();

    const connectPromise = bridge.connect();
    await vi.waitFor(() => expect(MockSocket.instances.length).toBe(1));
    MockSocket.instances[0].connected = true;
    MockSocket.instances[0].emit('connect');
    await connectPromise;

    bridge.disconnect();

    expect(MockSocket.instances[0].removeAllListeners).toHaveBeenCalled();
    expect(MockSocket.instances[0].disconnect).toHaveBeenCalled();
  });
});
