/**
 * Tests for sdk/src/resources/messages.ts - see rooms.test.ts for the
 * shared rationale (thin HttpClient-forwarding wrapper).
 *
 * list()/search() also build query strings, so those get explicit
 * mutation-guarded coverage of the querystring-building branches.
 */

import { describe, expect, it, vi } from 'vitest';
import { MessagesResource } from './messages.js';
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

describe('MessagesResource', () => {
  it('list(roomId) with no options → GET with no querystring', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ messages: [] });
    const messages = new MessagesResource(http);

    await messages.list('r1');

    // MUTATION GUARD: if the `qs ? ... : ''` fallback is dropped, a bare
    // '?' would be appended even with no params; fails
    expect(http.get).toHaveBeenCalledWith('/api/messages/r1');
  });

  it('list(roomId, { limit }) → appends ?limit=', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ messages: [] });
    const messages = new MessagesResource(http);

    await messages.list('r1', { limit: 20 });

    expect(http.get).toHaveBeenCalledWith('/api/messages/r1?limit=20');
  });

  it('list(roomId, { before }) → appends ?before=', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ messages: [] });
    const messages = new MessagesResource(http);

    await messages.list('r1', { before: 'm100' });

    expect(http.get).toHaveBeenCalledWith('/api/messages/r1?before=m100');
  });

  it('list(roomId, { limit, before }) → combines both params', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ messages: [{ id: 'm1' }] });
    const messages = new MessagesResource(http);

    const result = await messages.list('r1', { limit: 5, before: 'm50' });

    expect(http.get).toHaveBeenCalledWith('/api/messages/r1?limit=5&before=m50');
    expect(result).toEqual({ messages: [{ id: 'm1' }] });
  });

  it('send(roomId, content) → POST /api/agents/message with the body', async () => {
    const http = makeHttp();
    http.post.mockResolvedValue({ success: true, messageId: 'm1' });
    const messages = new MessagesResource(http);

    const result = await messages.send('r1', 'hello');

    expect(http.post).toHaveBeenCalledWith('/api/agents/message', { roomId: 'r1', content: 'hello' });
    expect(result).toEqual({ success: true, messageId: 'm1' });
  });

  it('search(roomId, query) → GET with URL-encoded query', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ messages: [] });
    const messages = new MessagesResource(http);

    await messages.search('r1', 'a b&c');

    expect(http.get).toHaveBeenCalledWith('/api/messages/r1/search?q=a%20b%26c');
  });

  it('delete(messageId) → DELETE /api/messages/:id', async () => {
    const http = makeHttp();
    http.delete.mockResolvedValue(undefined);
    const messages = new MessagesResource(http);

    await messages.delete('m1');

    expect(http.delete).toHaveBeenCalledWith('/api/messages/m1');
  });

  it('pin(messageId) → PATCH /api/messages/:id/pin', async () => {
    const http = makeHttp();
    http.patch.mockResolvedValue(undefined);
    const messages = new MessagesResource(http);

    await messages.pin('m1');

    expect(http.patch).toHaveBeenCalledWith('/api/messages/m1/pin');
  });

  it('unpin(messageId) → PATCH /api/messages/:id/unpin', async () => {
    const http = makeHttp();
    http.patch.mockResolvedValue(undefined);
    const messages = new MessagesResource(http);

    await messages.unpin('m1');

    expect(http.patch).toHaveBeenCalledWith('/api/messages/m1/unpin');
  });

  it('pinned(roomId) → GET /api/messages/:id/pinned', async () => {
    const http = makeHttp();
    http.get.mockResolvedValue({ messages: [] });
    const messages = new MessagesResource(http);

    await messages.pinned('r1');

    expect(http.get).toHaveBeenCalledWith('/api/messages/r1/pinned');
  });

  it('propagates a rejection from the underlying HttpClient', async () => {
    const http = makeHttp();
    http.post.mockRejectedValue(new Error('room not found'));
    const messages = new MessagesResource(http);

    await expect(messages.send('missing', 'hi')).rejects.toThrow('room not found');
  });
});
