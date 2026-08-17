/**
 * Tests for sdk/src/resources/users.ts - see rooms.test.ts for the
 * shared rationale (thin HttpClient-forwarding wrapper).
 */

import { describe, expect, it, vi } from 'vitest';
import { UsersResource } from './users.js';
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

describe('UsersResource', () => {
  it('list() → GET /api/users', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([{ id: 'u1' }]);
    const users = new UsersResource(http);

    const result = await users.list();

    expect(http.get).toHaveBeenCalledWith('/api/users');
    expect(result).toEqual([{ id: 'u1' }]);
  });

  it('inRoom(roomId) → GET /api/users/room/:id', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    const users = new UsersResource(http);

    const result = await users.inRoom('r1');

    // MUTATION GUARD: if the roomId is dropped or the path is mistyped
    // (e.g. /api/users?room=), this exact-match assertion fails.
    expect(http.get).toHaveBeenCalledWith('/api/users/room/r1');
    expect(result).toEqual([{ id: 'u1' }, { id: 'u2' }]);
  });

  it('propagates a rejection from the underlying HttpClient', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(new Error('forbidden'));
    const users = new UsersResource(http);

    await expect(users.list()).rejects.toThrow('forbidden');
  });
});
