/**
 * Tests for sdk/src/resources/inbox.ts - see rooms.test.ts for the
 * shared rationale (thin HttpClient-forwarding wrapper).
 */

import { describe, expect, it, vi } from 'vitest';
import { InboxResource } from './inbox.js';
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

describe('InboxResource', () => {
  it('list() → GET /api/inbox', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue([{ id: 'i1' }]);
    const inbox = new InboxResource(http);

    const result = await inbox.list();

    expect(http.get).toHaveBeenCalledWith('/api/inbox');
    expect(result).toEqual([{ id: 'i1' }]);
  });

  it('markRead(id) → PATCH /api/inbox/:id/read', async () => {
    const http = makeHttp();
    http.patch.mockResolvedValue(undefined);
    const inbox = new InboxResource(http);

    await inbox.markRead('i1');

    expect(http.patch).toHaveBeenCalledWith('/api/inbox/i1/read');
  });

  it('markAllRead() → PATCH /api/inbox/read-all', async () => {
    const http = makeHttp();
    http.patch.mockResolvedValue(undefined);
    const inbox = new InboxResource(http);

    await inbox.markAllRead();

    // MUTATION GUARD: distinguishes the per-item path (above) from the
    // bulk path - a typo collapsing them would go unnoticed otherwise.
    expect(http.patch).toHaveBeenCalledWith('/api/inbox/read-all');
  });

  it('delete(id) → DELETE /api/inbox/:id', async () => {
    const http = makeHttp();
    http.delete.mockResolvedValue(undefined);
    const inbox = new InboxResource(http);

    await inbox.delete('i1');

    expect(http.delete).toHaveBeenCalledWith('/api/inbox/i1');
  });

  it('deleteAll() → DELETE /api/inbox', async () => {
    const http = makeHttp();
    http.delete.mockResolvedValue(undefined);
    const inbox = new InboxResource(http);

    await inbox.deleteAll();

    expect(http.delete).toHaveBeenCalledWith('/api/inbox');
  });

  it('propagates a rejection from the underlying HttpClient', async () => {
    const http = makeHttp();
    http.get.mockRejectedValue(new Error('unauthorized'));
    const inbox = new InboxResource(http);

    await expect(inbox.list()).rejects.toThrow('unauthorized');
  });
});
