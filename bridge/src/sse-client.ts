/**
 * SSE client for the gateway's `/byoa/sse/stream` endpoint. Hand-rolled
 * on top of `fetch` + `ReadableStream` so we can attach the
 * Authorization header (Node's built-in EventSource does not support
 * custom headers).
 *
 * Emits a callback per parsed `message` event and reconnects with
 * exponential backoff on disconnect. Designed to run forever.
 */

export interface SseMessageEvent {
  id: string;
  room: string;
  roomName?: string;
  sender: string;
  senderType: 'HUMAN' | 'AI';
  content: string;
  timestamp: string;
}

export interface SseClientOptions {
  url: string;
  token: string;
  onMessage: (message: SseMessageEvent) => void | Promise<void>;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Parse a single SSE frame (`event: X\ndata: Y\n\n`) into an
 * {event, data} pair. Returns null if the frame has no `data:` line.
 * Exported so unit tests can exercise the parser in isolation.
 */
export function parseSseFrame(
  raw: string,
): { event: string; data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export class SseClient {
  private abortController: AbortController | null = null;
  private stopped = false;
  private reconnectAttempts = 0;

  constructor(private readonly opts: SseClientOptions) {}

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    if (this.opts.log) this.opts.log(level, message);
  }

  /** Start the SSE loop. Resolves when `stop()` is called. */
  async start(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        // Clean disconnect — reset backoff and reconnect.
        this.reconnectAttempts = 0;
      } catch (err) {
        if (this.stopped) break;
        const message = err instanceof Error ? err.message : String(err);
        this.log('warn', `SSE disconnect: ${message}`);
        this.opts.onDisconnect?.(message);
      }
      if (this.stopped) break;
      const delay = this.backoffMs();
      this.log('info', `Reconnecting in ${Math.round(delay / 1000)}s…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
  }

  /** Exponential backoff with a 60s ceiling. */
  private backoffMs(): number {
    const base = 1000;
    const cap = 60_000;
    const attempt = Math.min(this.reconnectAttempts++, 6);
    return Math.min(cap, base * Math.pow(2, attempt));
  }

  private async connectOnce(): Promise<void> {
    this.abortController = new AbortController();
    const res = await fetch(this.opts.url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${this.opts.token}`,
        'Cache-Control': 'no-cache',
      },
      signal: this.abortController.signal,
    });

    if (!res.ok) {
      throw new Error(`SSE HTTP ${res.status} ${res.statusText}`);
    }
    if (!res.body) {
      throw new Error('SSE response has no body');
    }

    this.log('info', 'SSE connected');
    this.opts.onConnect?.();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          if (parsed.event !== 'message') continue;
          let payload: SseMessageEvent;
          try {
            payload = JSON.parse(parsed.data);
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            this.log('warn', `Invalid JSON in SSE frame: ${m}`);
            continue;
          }
          try {
            await this.opts.onMessage(payload);
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            this.log('error', `onMessage handler threw: ${m}`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
