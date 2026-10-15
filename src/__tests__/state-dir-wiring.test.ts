/**
 * The read tracker, the metrics log and the JWT cache must all follow
 * STATE_DIR. Each module resolves its path at load time, so STATE_DIR is set
 * before a fresh dynamic import. `fs` is mocked: no real disk I/O.
 *
 * Mutation guard: pointing any of the three modules back at its old
 * `__dirname`-relative path makes the matching test fail.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STATE = '/srv/gateway-state';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock('fs', () => ({ default: fsMocks, ...fsMocks }));

const axiosMocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('axios', () => ({ default: axiosMocks }));

class MockSocket extends EventEmitter {
  connected = false;
  volatile = { emit: vi.fn() };
  disconnect = vi.fn();
}
const sockets = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('socket.io-client', () => ({
  io: () => {
    const s = new MockSocket();
    sockets.list.push(s);
    return s;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('STATE_DIR', STATE);
  sockets.list = [];
  for (const m of Object.values(fsMocks)) m.mockReset();
  fsMocks.existsSync.mockReturnValue(false);
  axiosMocks.post.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('STATE_DIR wiring', () => {
  it('read tracker writes under STATE_DIR', async () => {
    const { markMessageSeen } = await import('../read-tracker.js');
    markMessageSeen('agent-1', 'room-1', 'm1');
    expect(fsMocks.writeFileSync.mock.calls[0][0]).toBe(`${STATE}/.read-tracker.json`);
  });

  it('metrics log appends under STATE_DIR', async () => {
    const { metrics } = await import('../metrics.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    metrics.shutdown();
    expect(fsMocks.appendFileSync.mock.calls[0][0]).toBe(`${STATE}/metrics.jsonl`);
  });

  it('JWT cache is written under STATE_DIR', async () => {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64');
    axiosMocks.post.mockResolvedValue({ data: { token: `h.${payload}.s` } });
    const { TriologueBridge } = await import('../triologue-bridge.js');
    const bridge = new TriologueBridge({
      trioUrl: 'https://trio.test',
      username: 'gateway-bot',
      aiToken: 'byoa_gateway_token',
      userType: 'AI_AGENT',
    });

    const connecting = bridge.connect();
    await vi.waitFor(() => expect(sockets.list.length).toBe(1));
    const socket = sockets.list[0] as MockSocket;
    socket.connected = true;
    socket.emit('connect');
    await connecting;

    expect(fsMocks.existsSync).toHaveBeenCalledWith(`${STATE}/.jwt-cache-gateway.json`);
    expect(fsMocks.writeFileSync.mock.calls[0][0]).toBe(`${STATE}/.jwt-cache-gateway.json`);
  });
});
