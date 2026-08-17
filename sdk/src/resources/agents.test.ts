/**
 * Tests for sdk/src/resources/agents.ts - see rooms.test.ts for the
 * shared rationale (thin HttpClient-forwarding wrapper).
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentsResource } from './agents.js';
import type { HttpClient } from '../http.js';

function makeHttp() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as HttpClient & Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>>;
}

describe('AgentsResource', () => {
  it('info() → GET /api/agents/info', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ token: 't', name: 'Bot' });
    const agents = new AgentsResource(http);

    const result = await agents.info();

    expect(http.get).toHaveBeenCalledWith('/api/agents/info');
    expect(result).toEqual({ token: 't', name: 'Bot' });
  });

  it('gatewayConfig() → GET /api/agents/gateway-config', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ gatewayUrl: 'wss://gw', token: 't' });
    const agents = new AgentsResource(http);

    const result = await agents.gatewayConfig();

    expect(http.get).toHaveBeenCalledWith('/api/agents/gateway-config');
    expect(result).toEqual({ gatewayUrl: 'wss://gw', token: 't' });
  });

  it('register(data) → POST /api/agents with the body', async () => {
    const http = makeHttp();
    http.post.mockResolvedValue({ token: 'byoa_new' });
    const agents = new AgentsResource(http);
    const data = { name: 'Bot', mentionKey: 'bot' };

    const result = await agents.register(data);

    expect(http.post).toHaveBeenCalledWith('/api/agents', data);
    expect(result).toEqual({ token: 'byoa_new' });
  });

  it('list() → GET /api/agents', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([{ token: 't1' }]);
    const agents = new AgentsResource(http);

    const result = await agents.list();

    expect(http.get).toHaveBeenCalledWith('/api/agents');
    expect(result).toEqual([{ token: 't1' }]);
  });

  it('mine() → GET /api/agents/mine', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([{ token: 't1' }]);
    const agents = new AgentsResource(http);

    const result = await agents.mine();

    expect(http.get).toHaveBeenCalledWith('/api/agents/mine');
    expect(result).toEqual([{ token: 't1' }]);
  });

  it('update(agentId, data) → PATCH /api/agents/:id with the body', async () => {
    const http = makeHttp();
    http.patch.mockResolvedValue({ token: 't1', name: 'Renamed' });
    const agents = new AgentsResource(http);
    const data = { name: 'Renamed' };

    const result = await agents.update('a1', data);

    expect(http.patch).toHaveBeenCalledWith('/api/agents/a1', data);
    expect(result).toEqual({ token: 't1', name: 'Renamed' });
  });

  it('setVisibility(agentId, visibility, sharedWith) → PATCH /api/agents/:id/visibility', async () => {
    const http = makeHttp();
    http.patch.mockResolvedValue(undefined);
    const agents = new AgentsResource(http);

    await agents.setVisibility('a1', 'shared', ['u1', 'u2']);

    expect(http.patch).toHaveBeenCalledWith('/api/agents/a1/visibility', {
      visibility: 'shared',
      sharedWith: ['u1', 'u2'],
    });
  });

  it('setRooms(agentId, roomIds) → PUT /api/agents/:id/rooms', async () => {
    const http = makeHttp();
    http.put.mockResolvedValue(undefined);
    const agents = new AgentsResource(http);

    await agents.setRooms('a1', ['r1', 'r2']);

    expect(http.put).toHaveBeenCalledWith('/api/agents/a1/rooms', { roomIds: ['r1', 'r2'] });
  });

  it('getConfig(agentId) → GET /api/agents/:id/config', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ foo: 'bar' });
    const agents = new AgentsResource(http);

    const result = await agents.getConfig('a1');

    expect(http.get).toHaveBeenCalledWith('/api/agents/a1/config');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('updateConfig(agentId, config) → PATCH /api/agents/:id/config with the body', async () => {
    const http = makeHttp();
    http.patch.mockResolvedValue(undefined);
    const agents = new AgentsResource(http);
    const config = { foo: 'baz' };

    await agents.updateConfig('a1', config);

    expect(http.patch).toHaveBeenCalledWith('/api/agents/a1/config', config);
  });

  it('propagates a rejection from the underlying HttpClient', async () => {
    const http = makeHttp();
    http.post.mockRejectedValue(new Error('validation failed'));
    const agents = new AgentsResource(http);

    await expect(agents.register({ name: 'Bot', mentionKey: 'bot' })).rejects.toThrow(
      'validation failed',
    );
  });
});
