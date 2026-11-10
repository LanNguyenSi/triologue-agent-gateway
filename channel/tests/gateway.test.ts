import { describe, expect, it, vi } from 'vitest';
import { GatewayClient, GatewayError, errorDetail, parseSseFrame, resolveRoom } from '../src/gateway.js';

describe('parseSseFrame', () => {
  it('reads id, event and multi-line data, skipping comments', () => {
    expect(parseSseFrame(': heartbeat\nid: 7\nevent: message\ndata: {"a":\ndata: 1}')).toEqual({ id: '7', event: 'message', data: '{"a":\n1}' });
    expect(parseSseFrame(': heartbeat 123')).toBeNull();
    expect(parseSseFrame('data: x')).toEqual({ id: null, event: 'message', data: 'x' });
  });
});

describe('resolveRoom', () => {
  const rooms = [{ id: 'r1', name: 'backend' }, { id: 'r2', name: 'backend-ops' }, { id: 'r3', name: 'General' }];
  it('matches id, exact name, unique partial name, and reports ambiguity', () => {
    expect(resolveRoom(rooms, 'r3')).toEqual({ id: 'r3', name: 'General' });
    expect(resolveRoom(rooms, '#backend')).toEqual({ id: 'r1', name: 'backend' });
    expect(resolveRoom(rooms, 'gen')).toEqual({ id: 'r3', name: 'General' });
    expect(resolveRoom(rooms, 'back')).toEqual({ error: '"back" matches several rooms: backend, backend-ops' });
    expect(resolveRoom(rooms, 'nope')).toEqual({ error: 'no room matches "nope"' });
    expect(resolveRoom(rooms, '  ')).toEqual({ error: 'room is required' });
  });
});

describe('GatewayClient', () => {
  function client(responder: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const r = responder(String(input), init ?? {});
      return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { fetchImpl, gw: new GatewayClient({ gatewayUrl: 'http://gw/gateway', triologueUrl: 'http://trio', token: 'byoa_x', fetchImpl }) };
  }

  it('sends with the bearer token, the thread only when given, and the idempotency key', async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | undefined }> = [];
    const { gw } = client((url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as Record<string, string>).Authorization });
      return { status: 201, body: { messageId: 'm', status: 'sent' } };
    });
    await gw.sendMessage('room-1', 'hi', null, 'k1');
    await gw.sendMessage('room-1', 'in thread', 't-1');
    expect(calls[0]).toEqual({ url: 'http://gw/gateway/byoa/sse/messages', body: { roomId: 'room-1', content: 'hi', idempotencyKey: 'k1' }, auth: 'Bearer byoa_x' });
    expect(calls[1].body).toEqual({ roomId: 'room-1', content: 'in thread', threadId: 't-1' });
  });

  it('surfaces an upstream refusal as GatewayError with the status and the error text', async () => {
    const { gw } = client(() => ({ status: 404, body: { error: 'Unknown session' } }));
    await expect(gw.heartbeat('s1')).rejects.toMatchObject({ name: 'GatewayError', status: 404, message: expect.stringContaining('Unknown session') });
    expect(new GatewayError('x', 500, null)).toBeInstanceOf(Error);
  });

  it('carries the upstream refusal behind a 502 and a retry hint behind a 429 into the error text', async () => {
    const { gw: relay } = client(() => ({ status: 502, body: { error: 'Failed to deliver message', detail: 'Request failed with status code 429' } }));
    await expect(relay.sendMessage('room-1', 'hi')).rejects.toMatchObject({
      status: 502,
      message: 'POST http://gw/gateway/byoa/sse/messages -> 502 Failed to deliver message (Request failed with status code 429)',
    });
    const { gw: limited } = client(() => ({ status: 429, body: { error: 'RATE_LIMITED', retryAfter: 12 } }));
    await expect(limited.sendMessage('room-1', 'hi')).rejects.toMatchObject({ status: 429, message: expect.stringContaining('429 RATE_LIMITED, retry after 12s') });
    expect(errorDetail('plain text', 'Bad Gateway')).toBe('Bad Gateway');
    expect(errorDetail({ error: 'x', detail: '' }, 'f')).toBe('x');
  });

  it('lists rooms from Triologue in either response shape', async () => {
    const { gw: a } = client(() => ({ status: 200, body: [{ id: 'r1', name: 'A', extra: 1 }] }));
    expect(await a.listRooms()).toEqual([{ id: 'r1', name: 'A' }]);
    const { gw: b, fetchImpl } = client(() => ({ status: 200, body: { rooms: [{ id: 'r2', name: 'B' }] } }));
    expect(await b.listRooms()).toEqual([{ id: 'r2', name: 'B' }]);
    expect(String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toBe('http://trio/api/rooms');
  });
  it('reads and creates threads through the Triologue routes of the room, with the ids escaped and the answer checked', async () => {
    const calls: Array<{ method: string | undefined; url: string; body: unknown }> = [];
    const { gw } = client((url, init) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return { status: init.method === 'POST' ? 201 : 200, body: { id: 'th-1', title: 'Fix it', roomId: 'room 1', isResolved: false, messageCount: 0 } };
    });
    expect(await gw.getThread('room 1', 'th-1')).toEqual({ id: 'th-1', title: 'Fix it', roomId: 'room 1' });
    expect(await gw.createThread('room 1', 'Fix it')).toEqual({ id: 'th-1', title: 'Fix it', roomId: 'room 1' });
    expect(calls).toEqual([
      { method: 'GET', url: 'http://trio/api/rooms/room%201/threads/th-1', body: undefined },
      { method: 'POST', url: 'http://trio/api/rooms/room%201/threads', body: { title: 'Fix it' } },
    ]);

    const { gw: odd } = client(() => ({ status: 200, body: { id: 'a/b', roomId: 'r1' } }));
    await expect(odd.getThread('r1', 'x')).rejects.toThrow('not a thread');
    const { gw: refused } = client(() => ({ status: 403, body: { error: 'Access denied to this room' } }));
    await expect(refused.getThread('r1', 'x')).rejects.toMatchObject({ status: 403 });
  });
});
