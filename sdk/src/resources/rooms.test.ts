/**
 * Tests for sdk/src/resources/rooms.ts.
 *
 * RoomsResource is a thin wrapper: every method forwards to the injected
 * HttpClient with a specific verb + path (+ body). We assert the exact
 * (verb, path, body) triple per method and that the resolved value passes
 * straight through, plus one rejection-passthrough case.
 *
 * Mutation guard: swapping a verb (e.g. get→post) or mistyping a path
 * segment is caught because each assertion checks the exact call args.
 */

import { describe, expect, it, vi } from 'vitest';
import { RoomsResource } from './rooms.js';
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

describe('RoomsResource', () => {
  it('list() → GET /api/rooms and returns the resolved value', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([{ id: 'r1' }]);
    const rooms = new RoomsResource(http);

    const result = await rooms.list();

    expect(http.get).toHaveBeenCalledWith('/api/rooms');
    expect(result).toEqual([{ id: 'r1' }]);
  });

  it('get(roomId) → GET /api/rooms/:id', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ id: 'r1', name: 'General' });
    const rooms = new RoomsResource(http);

    const result = await rooms.get('r1');

    expect(http.get).toHaveBeenCalledWith('/api/rooms/r1');
    expect(result).toEqual({ id: 'r1', name: 'General' });
  });

  it('create(data) → POST /api/rooms with the body', async () => {
    const http = makeHttp();
    http.post.mockResolvedValue({ id: 'r2', name: 'New Room' });
    const rooms = new RoomsResource(http);
    const data = { name: 'New Room', isPrivate: true };

    const result = await rooms.create(data);

    expect(http.post).toHaveBeenCalledWith('/api/rooms', data);
    expect(result).toEqual({ id: 'r2', name: 'New Room' });
  });

  it('delete(roomId) → DELETE /api/rooms/:id', async () => {
    const http = makeHttp();
    http.delete.mockResolvedValue(undefined);
    const rooms = new RoomsResource(http);

    await rooms.delete('r1');

    expect(http.delete).toHaveBeenCalledWith('/api/rooms/r1');
  });

  it('join(roomId) → POST /api/rooms/:id/join with no body', async () => {
    const http = makeHttp();
    http.post.mockResolvedValue(undefined);
    const rooms = new RoomsResource(http);

    await rooms.join('r1');

    expect(http.post).toHaveBeenCalledWith('/api/rooms/r1/join');
  });

  it('invite(roomId, userId) → POST /api/rooms/:id/invite with { userId }', async () => {
    const http = makeHttp();
    http.post.mockResolvedValue(undefined);
    const rooms = new RoomsResource(http);

    await rooms.invite('r1', 'u9');

    expect(http.post).toHaveBeenCalledWith('/api/rooms/r1/invite', { userId: 'u9' });
  });

  it('invitable(roomId) → GET /api/rooms/:id/invitable', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([{ id: 'u1', username: 'alice', displayName: 'Alice' }]);
    const rooms = new RoomsResource(http);

    const result = await rooms.invitable('r1');

    expect(http.get).toHaveBeenCalledWith('/api/rooms/r1/invitable');
    expect(result).toEqual([{ id: 'u1', username: 'alice', displayName: 'Alice' }]);
  });

  it('mentions(roomId) → GET /api/rooms/:id/mentions', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([{ mentionKey: 'bot', name: 'Bot' }]);
    const rooms = new RoomsResource(http);

    const result = await rooms.mentions('r1');

    expect(http.get).toHaveBeenCalledWith('/api/rooms/r1/mentions');
    expect(result).toEqual([{ mentionKey: 'bot', name: 'Bot' }]);
  });

  it('export(roomId) → GET /api/rooms/:id/export', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ dump: true });
    const rooms = new RoomsResource(http);

    const result = await rooms.export('r1');

    expect(http.get).toHaveBeenCalledWith('/api/rooms/r1/export');
    expect(result).toEqual({ dump: true });
  });

  it('propagates a rejection from the underlying HttpClient', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(new Error('network down'));
    const rooms = new RoomsResource(http);

    await expect(rooms.list()).rejects.toThrow('network down');
  });
});
