import { describe, expect, it, vi } from 'vitest';
import { SseStream, type SseMessage } from '../src/gateway.js';

/** A fetch that answers with an SSE body made of the given frames, then ends (or never ends). */
function sseResponse(frames: string[], opts: { status?: number; keepOpen?: boolean } = {}): Response {
  const status = opts.status ?? 200;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
      if (!opts.keepOpen) controller.close();
    },
  });
  return new Response(status === 200 ? body : null, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('SseStream', () => {
  it('tags the stream with the session, delivers message events with their id, skips others, and resumes a reconnect from the last id', async () => {
    const inits: RequestInit[] = [];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      inits.push(init ?? {});
      if (inits.length === 1) {
        return sseResponse([
          'event: connected\ndata: {"agent":{"id":"a1"}}\n\n',
          ': heartbeat\n\n',
          'id: 42\nevent: message\ndata: {"id":"m1","room":"r","sender":"lan","senderType":"HUMAN","content":"hi","timestamp":"t"}\n\n',
          'id: 43\nevent: error\ndata: {"code":"X"}\n\n',
          'id: 44\nevent: message\ndata: not json\n\n',
        ]);
      }
      // The gateway closed the first connection; the second one asks for the gap.
      stream.stop();
      return sseResponse([]);
    }) as unknown as typeof fetch;
    const received: SseMessage[] = [];
    const disconnects: string[] = [];
    const stream = new SseStream({
      gatewayUrl: 'http://gw', token: 'byoa_x', sessionId: 'sess-1',
      onMessage: (m) => { received.push(m); }, onDisconnect: (r) => disconnects.push(r),
      fetchImpl, maxBackoffMs: 10,
    });

    await stream.start();

    expect(urls).toEqual(['http://gw/byoa/sse/stream?session=sess-1', 'http://gw/byoa/sse/stream?session=sess-1']);
    expect((inits[0].headers as Record<string, string>)['Last-Event-ID']).toBeUndefined();
    expect((inits[0].headers as Record<string, string>).Authorization).toBe('Bearer byoa_x');
    expect(received).toEqual([{ id: 'm1', room: 'r', sender: 'lan', senderType: 'HUMAN', content: 'hi', timestamp: 't', eventId: '42' }]);
    expect(disconnects).toEqual(['closed']);
    // The invalid frame 44 was not processed, so the resume point is 42.
    expect((inits[1].headers as Record<string, string>)['Last-Event-ID']).toBe('42');
  });

  it('reconnects with backoff after a failed connect, cancels the failed body, and stops when told', async () => {
    const log = vi.fn();
    const disconnects: string[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls >= 3) stream.stop();
      return sseResponse([], { status: 503 });
    }) as unknown as typeof fetch;
    const stream = new SseStream({
      gatewayUrl: 'http://gw', token: 't', sessionId: null,
      onMessage: () => undefined, onDisconnect: (r) => disconnects.push(r), log, fetchImpl, maxBackoffMs: 5,
    });

    await stream.start();

    // The third attempt asked the stream to stop before it failed, so only
    // the two earlier failures were reported as disconnects.
    expect(calls).toBe(3);
    expect(disconnects).toEqual(['SSE HTTP 503', 'SSE HTTP 503']);
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('reconnect'));
  });

  it('gives up a connection that stays silent longer than the idle timeout', async () => {
    const disconnects: string[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 2) stream.stop();
      return sseResponse(['event: connected\ndata: {}\n\n'], { keepOpen: true });
    }) as unknown as typeof fetch;
    const stream = new SseStream({
      gatewayUrl: 'http://gw', token: 't', sessionId: null,
      onMessage: () => undefined, onDisconnect: (r) => disconnects.push(r), fetchImpl, maxBackoffMs: 5, idleTimeoutMs: 40,
    });

    await stream.start();

    expect(disconnects).toEqual(['no data for 40 ms']);
  });
});
