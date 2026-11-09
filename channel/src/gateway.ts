/**
 * The gateway side of the channel: the SSE stream (with the session tag and
 * Last-Event-ID resume), the REST sends, the sessions API and the room list.
 * `fetch` only, no HTTP library.
 */

export type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/** A REST call that takes longer than this is abandoned. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Opening the stream (headers in) must not take longer than this. */
export const STREAM_CONNECT_TIMEOUT_MS = 15_000;
/** The gateway writes a heartbeat comment every 25 s; a stream silent for this long is dead. */
export const STREAM_IDLE_TIMEOUT_MS = 90_000;
/** A connection that held this long resets the reconnect backoff. */
export const STABLE_CONNECTION_MS = 30_000;

export interface SseMessage {
  id: string;
  room: string;
  roomName?: string;
  threadId?: string | null;
  sender: string;
  senderId?: string | null;
  senderType: 'HUMAN' | 'AI';
  content: string;
  timestamp: string;
  eventId?: number | string;
}

export interface GatewayClientOptions {
  gatewayUrl: string;
  triologueUrl: string;
  token: string;
  log?: Log;
  fetchImpl?: typeof fetch;
  /** Tests shorten it. */
  requestTimeoutMs?: number;
}

export class GatewayError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * The readable part of a refusal body: `error`, plus the gateway's `detail`
 * (a `502` carries the upstream refusal there, for example Triologue's
 * `Request failed with status code 429`) and a `retryAfter` when given.
 */
export function errorDetail(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object' || !('error' in body)) return fallback;
  const { error, detail, retryAfter } = body as { error: unknown; detail?: unknown; retryAfter?: unknown };
  let text = String(error);
  if (typeof detail === 'string' && detail.length > 0) text += ` (${detail})`;
  if (typeof retryAfter === 'number') text += `, retry after ${retryAfter}s`;
  return text;
}

/** The gateway answered 404 for a session it no longer has (expired, ended, or removed). */
export function isUnknownSession(err: unknown): boolean {
  return err instanceof GatewayError && err.status === 404;
}

export interface SessionInfo {
  sessionId: string;
  status?: string;
  rooms?: string[];
  threads?: string[];
}

export class GatewayClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GatewayClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (!res.ok) {
      throw new GatewayError(`${method} ${url} -> ${res.status} ${errorDetail(parsed, res.statusText)}`, res.status, parsed);
    }
    return parsed as T;
  }

  // ── messages ──

  async sendMessage(roomId: string, content: string, threadId?: string | null, idempotencyKey?: string): Promise<{ messageId: string; status: string }> {
    return this.call('POST', `${this.opts.gatewayUrl}/byoa/sse/messages`, {
      roomId,
      content,
      ...(threadId ? { threadId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  // ── sessions ──

  /**
   * Register a session; with `sessionId` the gateway refreshes that session
   * (same id, bindings added), or recreates it under the same id when it had
   * expired. The response's `session` is the gateway's view of it.
   */
  async connectSession(input: {
    sessionId?: string; runtime: string; host: string; cwd: string; project?: string | null;
    claudeSessionId?: string | null; rooms?: string[]; threads?: string[];
  }): Promise<{ sessionId: string; heartbeatSeconds: number; ttlSeconds: number; session?: SessionInfo }> {
    return this.call('POST', `${this.opts.gatewayUrl}/byoa/sessions/connect`, input);
  }

  async heartbeat(sessionId: string): Promise<void> {
    await this.call('POST', `${this.opts.gatewayUrl}/byoa/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {});
  }

  async presence(sessionId: string, status: string, detail: string | null): Promise<void> {
    await this.call('POST', `${this.opts.gatewayUrl}/byoa/sessions/${encodeURIComponent(sessionId)}/presence`, {
      status,
      ...(detail ? { detail } : {}),
    });
  }

  async bind(sessionId: string, rooms: string[], threads: string[] = []): Promise<{ rooms: string[]; threads: string[] }> {
    return this.call('POST', `${this.opts.gatewayUrl}/byoa/sessions/${encodeURIComponent(sessionId)}/bind`, { rooms, threads });
  }

  async unbind(sessionId: string, rooms: string[], threads: string[] = []): Promise<{ rooms: string[]; threads: string[] }> {
    return this.call('DELETE', `${this.opts.gatewayUrl}/byoa/sessions/${encodeURIComponent(sessionId)}/bind`, { rooms, threads });
  }

  async endSession(sessionId: string): Promise<void> {
    await this.call('DELETE', `${this.opts.gatewayUrl}/byoa/sessions/${encodeURIComponent(sessionId)}`);
  }

  // ── rooms (Triologue API, the BYOA token authenticates there too) ──

  async listRooms(): Promise<Array<{ id: string; name: string }>> {
    const rooms = await this.call<Array<{ id: string; name: string }> | { rooms: Array<{ id: string; name: string }> }>('GET', `${this.opts.triologueUrl}/api/rooms`);
    const list = Array.isArray(rooms) ? rooms : rooms.rooms ?? [];
    return list.map((r) => ({ id: r.id, name: r.name }));
  }

  /** The agent's own identity (username), from the gateway's status route. */
  async status(): Promise<{ agent: { id: string; name: string; username: string }; mentionKey?: string }> {
    return this.call('GET', `${this.opts.gatewayUrl}/byoa/sse/status`);
  }
}

/** Pick a room by exact id, exact name, or unique partial name (case-insensitive). */
export function resolveRoom(rooms: Array<{ id: string; name: string }>, query: string): { id: string; name: string } | { error: string } {
  const q = query.trim().replace(/^#/, '').toLowerCase();
  if (q.length === 0) return { error: 'room is required' };
  const byId = rooms.find((r) => r.id.toLowerCase() === q);
  if (byId) return byId;
  const exact = rooms.filter((r) => r.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = rooms.filter((r) => r.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) return { error: `no room matches "${query}"` };
  return { error: `"${query}" matches several rooms: ${partial.map((r) => r.name).join(', ')}` };
}

// ── SSE stream ──

/** Parse one SSE frame into {id, event, data}; null without a data line. */
export function parseSseFrame(raw: string): { id: string | null; event: string; data: string } | null {
  let event = 'message';
  let id: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { id, event, data: dataLines.join('\n') };
}

export interface SseStreamOptions {
  gatewayUrl: string;
  token: string;
  sessionId: string | null;
  onMessage: (message: SseMessage) => void | Promise<void>;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  log?: Log;
  fetchImpl?: typeof fetch;
  /** Backoff cap in ms (tests shorten it). */
  maxBackoffMs?: number;
  /** Silence on the stream (no bytes, heartbeats count) that counts as a dead connection (tests shorten it). */
  idleTimeoutMs?: number;
}

export class SseStream {
  private abort: AbortController | null = null;
  private stopped = false;
  private attempts = 0;
  /**
   * The last processed event id, sent as Last-Event-ID on reconnect so the
   * gateway replays the gap. Memory only, on purpose: a new process starts
   * from now. An attended session should not be handed the backlog of a night,
   * and the file would be shared by every Claude Code on the machine.
   */
  private lastEventId: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: SseStreamOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.opts.log?.(level, message);
  }

  /** Runs until stop(); reconnects with exponential backoff. */
  async start(): Promise<void> {
    while (!this.stopped) {
      let connectedAt = 0;
      try {
        await this.connectOnce(() => { connectedAt = Date.now(); });
        if (this.stopped) break;
        this.log('warn', 'SSE stream closed by the gateway');
        this.opts.onDisconnect?.('closed');
      } catch (err) {
        if (this.stopped) break;
        const message = err instanceof Error ? err.message : String(err);
        this.log('warn', `SSE disconnected: ${message}`);
        this.opts.onDisconnect?.(message);
      }
      if (this.stopped) break;
      // A connection that held for a while starts the backoff over; one that
      // dropped at once keeps it growing.
      if (connectedAt > 0 && Date.now() - connectedAt >= STABLE_CONNECTION_MS) this.attempts = 0;
      const delay = Math.min(this.opts.maxBackoffMs ?? 60_000, 1000 * 2 ** Math.min(this.attempts++, 6));
      this.log('info', `SSE reconnect in ${Math.round(delay / 1000)}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  private async connectOnce(onOpen: () => void): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    const url = `${this.opts.gatewayUrl}/byoa/sse/stream${this.opts.sessionId ? `?session=${encodeURIComponent(this.opts.sessionId)}` : ''}`;
    const connectTimer = setTimeout(() => abort.abort(new Error(`SSE connect timeout after ${STREAM_CONNECT_TIMEOUT_MS / 1000}s`)), STREAM_CONNECT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${this.opts.token}`,
          'Cache-Control': 'no-cache',
          ...(this.lastEventId ? { 'Last-Event-ID': this.lastEventId } : {}),
        },
        signal: abort.signal,
      });
    } finally {
      clearTimeout(connectTimer);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`SSE HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('SSE response has no body');
    this.log('info', `SSE connected${this.opts.sessionId ? ` as session ${this.opts.sessionId}` : ''}`);
    onOpen();
    this.opts.onConnect?.();

    const idleMs = this.opts.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
    const reader = res.body.getReader();
    let idle = false;
    // Cancelling the reader settles a pending read; aborting alone need not.
    const onIdle = () => { idle = true; reader.cancel().catch(() => undefined); abort.abort(); };
    let idleTimer = setTimeout(onIdle, idleMs);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        clearTimeout(idleTimer);
        if (idle) throw new Error(`no data for ${idleMs} ms`);
        if (done) return;
        idleTimer = setTimeout(onIdle, idleMs);
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          if (parsed.event === 'error') {
            this.log('warn', `SSE error event: ${parsed.data}`);
            continue;
          }
          if (parsed.event !== 'message') continue;
          let payload: SseMessage;
          try {
            payload = JSON.parse(parsed.data) as SseMessage;
          } catch {
            this.log('warn', 'SSE frame with invalid JSON skipped');
            continue;
          }
          if (parsed.id) payload.eventId = parsed.id;
          try {
            await this.opts.onMessage(payload);
          } catch (err) {
            this.log('error', `onMessage failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (parsed.id) this.lastEventId = parsed.id;
        }
      }
    } catch (err) {
      if (idle) throw new Error(`no data for ${idleMs} ms`);
      throw err;
    } finally {
      clearTimeout(idleTimer);
      reader.releaseLock();
    }
  }
}
