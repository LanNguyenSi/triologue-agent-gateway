import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SseStream, type SseMessage } from '../src/gateway.js';

/** A fetch that answers with an SSE body made of the given frames, then ends. */
function sseFetch(frames: string[], onRequest?: (init: RequestInit) => void, status = 200) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    onRequest?.(init ?? {});
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(new TextEncoder().encode(f));
        controller.close();
      },
    });
    return new Response(status === 200 ? body : null, { status, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('SseStream', () => {
  it('tags the stream with the session, delivers message events with their id, skips others, and remembers the id', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-sse-'));
    dirs.push(stateDir);
    const lastEventFile = path.join(stateDir, 'last-event-id');
    fs.writeFileSync(lastEventFile, '41');
    const inits: RequestInit[] = [];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      inits.push(init ?? {});
      return (sseFetch([
        'event: connected\ndata: {"agent":{"id":"a1"}}\n\n',
        ': heartbeat\n\n',
        'id: 42\nevent: message\ndata: {"id":"m1","room":"r","sender":"lan","senderType":"HUMAN","content":"hi","timestamp":"t"}\n\n',
        'id: 43\nevent: error\ndata: {"code":"X"}\n\n',
        'id: 44\nevent: message\ndata: not json\n\n',
      ]) as unknown as (u: string, i?: RequestInit) => Promise<Response>)(String(url), init);
    }) as unknown as typeof fetch;
    const received: SseMessage[] = [];
    const stream = new SseStream({
      gatewayUrl: 'http://gw', token: 'byoa_x', sessionId: 'sess-1', lastEventFile,
      onMessage: (m) => { received.push(m); if (received.length === 1) stream.stop(); },
      fetchImpl, maxBackoffMs: 10,
    });

    await stream.start();

    expect(urls[0]).toBe('http://gw/byoa/sse/stream?session=sess-1');
    expect((inits[0].headers as Record<string, string>)['Last-Event-ID']).toBe('41');
    expect((inits[0].headers as Record<string, string>).Authorization).toBe('Bearer byoa_x');
    expect(received).toEqual([{ id: 'm1', room: 'r', sender: 'lan', senderType: 'HUMAN', content: 'hi', timestamp: 't', eventId: '42' }]);
    expect(fs.readFileSync(lastEventFile, 'utf8')).toBe('42');
  });

  it('reconnects with backoff after a failed connect and stops when told', async () => {
    const log = vi.fn();
    const disconnects: string[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls >= 3) stream.stop();
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;
    const stream = new SseStream({
      gatewayUrl: 'http://gw', token: 't', sessionId: null, lastEventFile: null,
      onMessage: () => undefined, onDisconnect: (r) => disconnects.push(r), log, fetchImpl, maxBackoffMs: 5,
    });

    await stream.start();

    // The third attempt asked the stream to stop before it failed, so only
    // the two earlier failures were reported as disconnects.
    expect(calls).toBe(3);
    expect(disconnects).toEqual(['SSE HTTP 503', 'SSE HTTP 503']);
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('reconnect'));
  });
});
