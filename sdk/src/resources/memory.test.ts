/**
 * Tests for sdk/src/resources/memory.ts - see rooms.test.ts for the
 * shared rationale (thin HttpClient-forwarding wrapper).
 *
 * list() builds a multi-param query string, so that gets explicit
 * mutation-guarded coverage of each param's inclusion branch.
 */

import { describe, expect, it, vi } from 'vitest';
import { MemoryResource } from './memory.js';
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

describe('MemoryResource', () => {
  it('list() with no options → GET with no querystring', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([]);
    const memory = new MemoryResource(http);

    await memory.list();

    expect(http.get).toHaveBeenCalledWith('/api/memory');
  });

  it('list({ projectId }) → appends ?projectId=', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([]);
    const memory = new MemoryResource(http);

    await memory.list({ projectId: 'p1' });

    expect(http.get).toHaveBeenCalledWith('/api/memory?projectId=p1');
  });

  it('list({ scope, memoryType }) → combines both params', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([{ id: 'mem1' }]);
    const memory = new MemoryResource(http);

    const result = await memory.list({ scope: 'project', memoryType: 'reference' });

    expect(http.get).toHaveBeenCalledWith('/api/memory?scope=project&memoryType=reference');
    expect(result).toEqual([{ id: 'mem1' }]);
  });

  it('get(id) → GET /api/memory/:id', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ id: 'mem1' });
    const memory = new MemoryResource(http);

    const result = await memory.get('mem1');

    expect(http.get).toHaveBeenCalledWith('/api/memory/mem1');
    expect(result).toEqual({ id: 'mem1' });
  });

  it('create(data) → POST /api/memory with the body', async () => {
    const http = makeHttp();
    http.post.mockResolvedValue({ id: 'mem2' });
    const memory = new MemoryResource(http);
    const data = { pluginId: 'p', memoryType: 'reference', payload: { a: 1 } };

    const result = await memory.create(data);

    expect(http.post).toHaveBeenCalledWith('/api/memory', data);
    expect(result).toEqual({ id: 'mem2' });
  });

  it('update(id, data) → PATCH /api/memory/:id with the body', async () => {
    const http = makeHttp();
    http.patch.mockResolvedValue({ id: 'mem1', title: 'New title' });
    const memory = new MemoryResource(http);
    const data = { title: 'New title' };

    const result = await memory.update('mem1', data);

    expect(http.patch).toHaveBeenCalledWith('/api/memory/mem1', data);
    expect(result).toEqual({ id: 'mem1', title: 'New title' });
  });

  it('delete(id) → DELETE /api/memory/:id (soft delete)', async () => {
    const http = makeHttp();
    http.delete.mockResolvedValue(undefined);
    const memory = new MemoryResource(http);

    await memory.delete('mem1');

    expect(http.delete).toHaveBeenCalledWith('/api/memory/mem1');
  });

  it('deletePermanent(id) → DELETE /api/memory/:id/permanent', async () => {
    const http = makeHttp();
    http.delete.mockResolvedValue(undefined);
    const memory = new MemoryResource(http);

    await memory.deletePermanent('mem1');

    // MUTATION GUARD: if `/permanent` is dropped, this collides with the
    // soft-delete path above; fails
    expect(http.delete).toHaveBeenCalledWith('/api/memory/mem1/permanent');
  });

  it('propagates a rejection from the underlying HttpClient', async () => {
    const http = makeHttp();
    http.post.mockRejectedValue(new Error('payload too large'));
    const memory = new MemoryResource(http);

    await expect(
      memory.create({ pluginId: 'p', memoryType: 'reference', payload: {} }),
    ).rejects.toThrow('payload too large');
  });
});
