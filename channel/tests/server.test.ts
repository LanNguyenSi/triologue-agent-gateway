/**
 * Several channel sessions of one agent on one machine, in process: real
 * ChannelServers over in-memory MCP transports, a fake gateway each, one
 * shared binding directory. Covers which session a bound room reaches (an
 * unbound session nothing, of several bound sessions the most recently bound
 * one, the next one after a disconnect or exit), verdicts for a standby
 * session's own prompt, a session whose first registration failed (it claims
 * no room and opens no stream until the gateway knows it), and how a refused
 * relay or send shows up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BindingOrder } from '../src/bindings.js';
import type { ChannelConfig } from '../src/config.js';
import { GatewayError, type GatewayClient, type SseMessage } from '../src/gateway.js';
import { parseAllowedSenders } from '../src/inbound.js';
import { ChannelServer } from '../src/server.js';

const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
});
const PermissionVerdict = z.object({
  method: z.literal('notifications/claude/channel/permission'),
  params: z.object({ request_id: z.string(), behavior: z.enum(['allow', 'deny']) }),
});

const ROOMS = [{ id: 'room-1', name: 'backend' }, { id: 'room-2', name: 'ops' }];

interface FakeThread { id: string; title: string; roomId: string }

class FakeGateway {
  sent: Array<{ roomId: string; content: string; threadId: string | null }> = [];
  /** The threads Triologue knows (thread id -> thread). */
  threads = new Map<string, FakeThread>([
    ['th-1', { id: 'th-1', title: 'Fix the login bug', roomId: 'room-1' }],
    ['th-2', { id: 'th-2', title: 'Second task', roomId: 'room-1' }],
    ['th-ops', { id: 'th-ops', title: 'Ops thread', roomId: 'room-2' }],
    ['th-9', { id: 'th-9', title: 'In an unlisted room', roomId: 'room-9' }],
  ]);
  /** Every thread route call, in order: `get <room>/<thread>` and `create <room>`. */
  threadCalls: string[] = [];
  /** When set, a thread route answers with this room id whatever room was asked about. */
  threadRoomOverride: string | null = null;
  /** When set, bind refuses with it. */
  failBind: Error | null = null;
  binds: Array<{ apply: 'bind' | 'unbind'; rooms: string[]; threads: string[] }> = [];
  failSend: GatewayError | null = null;
  /** While set, a registration fails with it. */
  failConnect: Error | null = null;
  connects: Array<{ rooms?: string[] }> = [];
  constructor(readonly sessionId: string) {}
  async status() { return { agent: { id: 'a1', name: 'Claude', username: 'agent_claude' } }; }
  async connectSession(input: { rooms?: string[] }) {
    this.connects.push(input);
    if (this.failConnect) throw this.failConnect;
    return { sessionId: this.sessionId, heartbeatSeconds: 30, ttlSeconds: 90 };
  }
  async heartbeat() {}
  async presence() {}
  async bind(_s: string, rooms: string[], threads: string[] = []) {
    if (this.failBind) throw this.failBind;
    this.binds.push({ apply: 'bind', rooms, threads });
    return { rooms, threads };
  }
  async unbind(_s: string, rooms: string[], threads: string[] = []) {
    this.binds.push({ apply: 'unbind', rooms, threads });
    return { rooms, threads };
  }
  async endSession() {}
  async listRooms() { return ROOMS; }
  async getThread(roomId: string, threadId: string): Promise<FakeThread> {
    this.threadCalls.push(`get ${roomId}/${threadId}`);
    const thread = this.threads.get(threadId);
    if (!thread || thread.roomId !== roomId) throw new GatewayError(`GET http://trio/api/rooms/${roomId}/threads/${threadId} -> 404 Thread not found`, 404, null);
    return this.threadRoomOverride ? { ...thread, roomId: this.threadRoomOverride } : thread;
  }
  async createThread(roomId: string, title: string): Promise<FakeThread> {
    this.threadCalls.push(`create ${roomId}`);
    const thread = { id: `th-new-${this.threads.size}`, title, roomId };
    this.threads.set(thread.id, thread);
    return this.threadRoomOverride ? { ...thread, roomId: this.threadRoomOverride } : thread;
  }
  async sendMessage(roomId: string, content: string, threadId: string | null = null) {
    if (this.failSend) throw this.failSend;
    this.sent.push({ roomId, content, threadId });
    return { messageId: `m-${this.sent.length}`, status: 'sent' };
  }
}

interface Session {
  server: ChannelServer;
  client: Client;
  gateway: FakeGateway;
  /** The session tag of every stream the server opened. */
  streams: Array<{ sessionId: string | null }>;
  /** The directory of the binding order, shared by the sessions of one machine. */
  bindingDir: string;
  pid: number;
  events: string[];
  /** The meta of every delivered message, in the order of `events`. */
  metas: Array<Record<string, string> | undefined>;
  verdicts: Array<{ request_id: string; behavior: string }>;
  logs: Array<[string, string]>;
}

const dirs: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) {
    await s.client.close().catch(() => undefined);
    await s.server.stop().catch(() => undefined);
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function machine() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-server-'));
  dirs.push(stateDir);
  const bindingDir = path.join(stateDir, 'bindings', 'agent');
  let nextPid = 500;
  return async (rooms: string[] = [], opts: { failConnect?: Error; heartbeatSeconds?: number } = {}): Promise<Session> => {
    nextPid += 1;
    const pid = nextPid;
    const config: ChannelConfig = {
      gatewayUrl: 'http://gw', triologueUrl: 'http://trio', byoaToken: 'byoa_test', allowedSenders: parseAllowedSenders(['user-lan']),
      allowAgents: false, rooms, runtime: 'claude', host: 'test-host', cwd: '/p', project: 'p', claudeSessionId: null,
      stateDir, presencePort: 0, heartbeatSeconds: opts.heartbeatSeconds ?? 30, logLevel: 'debug', warnings: [],
    };
    const gateway = new FakeGateway(`sess-${pid}`);
    gateway.failConnect = opts.failConnect ?? null;
    const logs: Array<[string, string]> = [];
    const streams: Session['streams'] = [];
    const server = new ChannelServer({
      config,
      gateway: gateway as unknown as GatewayClient,
      log: (level, message) => logs.push([level, message]),
      createStream: (o) => { streams.push({ sessionId: o.sessionId }); return { start: async () => undefined, stop: () => undefined }; },
      presenceListener: false,
      bindingOrder: new BindingOrder({ dir: bindingDir, pid, isAlive: () => true }),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.start(serverSide);
    const client = new Client({ name: 'claude-code-fake', version: '0.0.0' }, { capabilities: { experimental: { 'claude/channel': {} } } });
    const session: Session = { server, client, gateway, streams, bindingDir, pid, events: [], metas: [], verdicts: [], logs };
    client.setNotificationHandler(ChannelNotification, async (n) => { session.events.push(n.params.content); session.metas.push(n.params.meta); });
    client.setNotificationHandler(PermissionVerdict, async (n) => { session.verdicts.push(n.params); });
    await client.connect(clientSide);
    sessions.push(session);
    return session;
  };
}

let seq = 0;
function message(room: string, content: string): SseMessage {
  seq += 1;
  return { id: `m${seq}`, room, sender: 'lan', senderId: 'user-lan', senderType: 'HUMAN', content, timestamp: new Date().toISOString() };
}

function threadMessage(room: string, threadId: string, content: string, overrides: Partial<SseMessage> = {}): SseMessage {
  return { ...message(room, content), threadId, ...overrides };
}

/** Push one room message into every session, the way the gateway fans it out to each bound stream. */
async function fanOut(all: Session[], room: string, content: string): Promise<void> {
  for (const s of all) await s.server.onMessage(message(room, content));
  await new Promise((r) => setTimeout(r, 20));
}

async function tool(s: Session, name: string, args: Record<string, unknown> = {}): Promise<{ isError?: boolean; text: string; body: Record<string, unknown> }> {
  const result = await s.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* error text */ }
  return { isError: result.isError as boolean | undefined, text, body };
}

/** The clock in the binding order is the wall clock; keep binds a millisecond apart. */
const later = () => new Promise((r) => setTimeout(r, 3));

/** The pids of the sessions with an entry for the room in the order on this machine. */
function entryPids(s: Session, room: string): number[] {
  const dir = path.join(s.bindingDir, room);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => Number(name.split('-')[0])).sort((x, y) => x - y);
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('which session a room reaches', () => {
  it('an unbound session receives nothing, also after disconnecting its last room', async () => {
    const start = machine();
    const a = await start();
    await fanOut([a], 'room-1', 'hello?');
    expect(a.events).toEqual([]);
    expect((await tool(a, 'status')).body.dropped).toEqual({ 'room-not-bound': 1 });

    await tool(a, 'connect_room', { room: 'backend' });
    await fanOut([a], 'room-1', 'bound now');
    expect(a.events).toEqual(['bound now']);

    const off = await tool(a, 'disconnect_room', { room: 'backend' });
    expect(off.body).toMatchObject({ ok: true, rooms: [] });
    await fanOut([a], 'room-1', 'after the last room');
    await fanOut([a], 'room-2', 'another room');
    expect(a.events).toEqual(['bound now']);
    expect((await tool(a, 'status')).body).toMatchObject({ rooms: [], answering: [], standby: [], dropped: { 'room-not-bound': 3 } });
  });

  it('of two sessions bound to a room only the most recently bound one gets its messages; the other gets nothing', async () => {
    const start = machine();
    const a = await start();
    const b = await start();
    expect((await tool(a, 'connect_room', { room: 'backend' })).body).toMatchObject({ answers: true });
    await later();
    expect((await tool(b, 'connect_room', { room: 'backend' })).body).toMatchObject({ answers: true });

    await fanOut([a, b], 'room-1', 'who answers?');
    expect(b.events).toEqual(['who answers?']);
    expect(a.events).toEqual([]);
    expect((await tool(a, 'status')).body).toMatchObject({ rooms: ['room-1'], answering: [], standby: ['room-1'], dropped: { 'answered-by-newer-session': 1 } });
    expect((await tool(b, 'status')).body).toMatchObject({ answering: ['room-1'], standby: [] });
  });

  it('binding again makes the older session the one that answers', async () => {
    const start = machine();
    const a = await start();
    const b = await start();
    await tool(a, 'connect_room', { room: 'backend' });
    await later();
    await tool(b, 'connect_room', { room: 'backend' });
    await later();
    await tool(a, 'connect_room', { room: 'backend' });
    await fanOut([a, b], 'room-1', 'rebound');
    expect(a.events).toEqual(['rebound']);
    expect(b.events).toEqual([]);
  });

  it('when the most recent session disconnects or exits, the next most recent still-bound one answers', async () => {
    const start = machine();
    const a = await start();
    const b = await start();
    const c = await start();
    for (const s of [a, b, c]) { await tool(s, 'connect_room', { room: 'backend' }); await later(); }
    await fanOut([a, b, c], 'room-1', 'one');
    expect([a, b, c].map((s) => s.events)).toEqual([[], [], ['one']]);

    await tool(c, 'disconnect_room', { room: 'backend' });
    await fanOut([a, b, c], 'room-1', 'two');
    expect([a, b, c].map((s) => s.events)).toEqual([[], ['two'], ['one']]);

    await b.server.stop();
    await fanOut([a, c], 'room-1', 'three');
    expect([a.events, c.events]).toEqual([['three'], ['one']]);
  });

  it('rooms bound at start count as bound at start, and other rooms are independent', async () => {
    const start = machine();
    const a = await start(['room-1', 'room-2']);
    await later();
    const b = await start();
    await tool(b, 'connect_room', { room: 'ops' });
    await fanOut([a, b], 'room-1', 'backend message');
    await fanOut([a, b], 'room-2', 'ops message');
    expect(a.events).toEqual(['backend message']);
    expect(b.events).toEqual(['ops message']);
    expect((await tool(a, 'status')).body).toMatchObject({ answering: ['room-1'], standby: ['room-2'] });
  });

  it('a session that no longer answers a room still takes the verdict for the prompt it relayed there', async () => {
    const start = machine();
    const a = await start();
    const b = await start();
    await tool(a, 'connect_room', { room: 'backend' });
    await later();
    await tool(b, 'connect_room', { room: 'backend' });
    await a.client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'abcde', tool_name: 'Bash', description: 'Run the tests', input_preview: 'npm test' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(a.gateway.sent[0]).toMatchObject({ roomId: 'room-1' });
    await fanOut([a, b], 'room-1', 'yes abcde');
    expect(a.verdicts).toEqual([{ request_id: 'abcde', behavior: 'allow' }]);
    expect(b.verdicts).toEqual([]);
    expect([a.events, b.events]).toEqual([[], []]);
  });
});

describe('a session the gateway does not know yet', () => {
  const outage = new GatewayError('POST http://gw/byoa/sessions/connect -> 503 Service Unavailable', 503, null);

  it('claims no room and opens no stream until a heartbeat registers it; then the stream carries the session tag and it answers', async () => {
    const start = machine();
    const a = await start(['room-1', 'room-2']);
    await later();
    const b = await start(['room-1'], { failConnect: outage, heartbeatSeconds: 0.05 });
    // connect_room before the registration: bound for the session, claimed later.
    expect((await tool(b, 'connect_room', { room: 'ops' })).body).toMatchObject({ ok: true, rooms: ['room-1', 'room-2'], answers: false });

    expect(b.server.state.sessionId).toBeNull();
    expect(b.streams).toEqual([]);
    expect(entryPids(a, 'room-1')).toEqual([a.pid]);
    expect(entryPids(a, 'room-2')).toEqual([a.pid]);
    // Only A has a stream, and A still answers both rooms.
    await fanOut([a], 'room-1', 'still A (backend)');
    await fanOut([a], 'room-2', 'still A (ops)');
    expect(a.events).toEqual(['still A (backend)', 'still A (ops)']);
    expect((await tool(a, 'status')).body).toMatchObject({ answering: ['room-1', 'room-2'], standby: [] });
    expect((await tool(b, 'status')).body).toMatchObject({ session: null, rooms: ['room-1', 'room-2'], answering: [] });
    expect(b.logs).toContainEqual(['warn', expect.stringMatching(/^session registration failed, retrying with the next heartbeat: .*503/)]);

    b.gateway.failConnect = null;
    await waitFor(() => b.streams.length > 0, 'the stream after the registration');
    expect(b.server.state.sessionId).toBe(`sess-${b.pid}`);
    expect(b.streams).toEqual([{ sessionId: `sess-${b.pid}` }]);
    // The gateway learned both bindings with the registration.
    expect(b.gateway.connects.at(-1)).toMatchObject({ rooms: ['room-1', 'room-2'] });
    expect(entryPids(a, 'room-1')).toEqual([a.pid, b.pid]);
    expect(entryPids(a, 'room-2')).toEqual([a.pid, b.pid]);

    await fanOut([a, b], 'room-1', 'now B (backend)');
    await fanOut([a, b], 'room-2', 'now B (ops)');
    expect(b.events).toEqual(['now B (backend)', 'now B (ops)']);
    expect(a.events).toEqual(['still A (backend)', 'still A (ops)']);
    // Several heartbeats later still one stream.
    await new Promise((r) => setTimeout(r, 150));
    expect(b.streams).toHaveLength(1);
  });

  it('with a gateway that has no sessions API it takes part at once, with an untagged stream', async () => {
    const start = machine();
    const a = await start(['room-1'], { failConnect: new GatewayError('POST http://gw/byoa/sessions/connect -> 404 Not Found', 404, null) });
    expect(a.server.state.sessionId).toBeNull();
    expect(a.streams).toEqual([{ sessionId: null }]);
    expect(entryPids(a, 'room-1')).toEqual([a.pid]);
    await fanOut([a], 'room-1', 'old gateway');
    expect(a.events).toEqual(['old gateway']);
    expect(a.logs).toContainEqual(['warn', expect.stringMatching(/^the gateway has no sessions API/)]);
  });

  it('also when the gateway turns out to have no sessions API only at a heartbeat after a failed start', async () => {
    const start = machine();
    const a = await start(['room-1'], { failConnect: outage, heartbeatSeconds: 0.05 });
    expect(a.streams).toEqual([]);
    a.gateway.failConnect = new GatewayError('POST http://gw/byoa/sessions/connect -> 404 Not Found', 404, null);
    await waitFor(() => a.streams.length > 0, 'the stream after the 404');
    expect(a.streams).toEqual([{ sessionId: null }]);
    expect(entryPids(a, 'room-1')).toEqual([a.pid]);
  });

  it('a 404 at a heartbeat is final: no further registration attempt, also when the gateway would now accept one, and one untagged stream', async () => {
    const start = machine();
    const a = await start(['room-1'], { failConnect: outage, heartbeatSeconds: 0.05 });
    a.gateway.failConnect = new GatewayError('POST http://gw/byoa/sessions/connect -> 404 Not Found', 404, null);
    await waitFor(() => a.streams.length > 0, 'the stream after the 404');
    const connectsAt404 = a.gateway.connects.length;
    // The gateway recovers: a registration now would succeed, but none is tried.
    a.gateway.failConnect = null;
    await new Promise((r) => setTimeout(r, 300));
    expect(a.gateway.connects).toHaveLength(connectsAt404);
    expect(a.server.state.sessionId).toBeNull();
    // Several heartbeats later, still the one untagged stream and the one entry.
    expect(a.streams).toEqual([{ sessionId: null }]);
    expect(entryPids(a, 'room-1')).toEqual([a.pid]);
    await fanOut([a], 'room-1', 'still answered');
    expect(a.events).toEqual(['still answered']);
  });

  it('a registration that is still pending when the session stops opens no stream and claims no room', async () => {
    const start = machine();
    const a = await start(['room-1'], { failConnect: outage, heartbeatSeconds: 0.05 });
    let release: (() => void) | null = null;
    const ended: string[] = [];
    (a.gateway as unknown as { endSession: unknown }).endSession = async (id: string) => { ended.push(id); };
    (a.gateway as unknown as { connectSession: unknown }).connectSession = () => new Promise((resolve) => {
      release = () => resolve({ sessionId: 'late-session', heartbeatSeconds: 30, ttlSeconds: 90 });
    });
    await waitFor(() => release !== null, 'the registration in flight');
    await a.server.stop();
    release!();
    await new Promise((r) => setTimeout(r, 50));
    expect(a.server.state.sessionId).toBeNull();
    expect(ended).toEqual(['late-session']);
    expect(a.streams).toEqual([]);
    expect(entryPids(a, 'room-1')).toEqual([]);
  });

  it('activating twice opens one stream and writes the entries once', async () => {
    const start = machine();
    const a = await start(['room-1']);
    expect(a.streams).toHaveLength(1);
    const before = entryPids(a, 'room-1');
    (a.server as unknown as { activate(): void }).activate();
    expect(a.streams).toHaveLength(1);
    expect(entryPids(a, 'room-1')).toEqual(before);
  });
});

describe('refused relays and sends', () => {
  const refusal = new GatewayError('POST http://gw/byoa/sse/messages -> 502 Failed to deliver message (Request failed with status code 429)', 502, null);

  it('a relay the gateway refuses shows up in status and as an error line, the prompt stays in the terminal', async () => {
    const a = await machine()(['room-1']);
    a.gateway.failSend = refusal;
    await a.client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'qwert', tool_name: 'Bash', description: 'x', input_preview: 'ls' },
    });
    await new Promise((r) => setTimeout(r, 50));
    const status = (await tool(a, 'status')).body;
    expect(status.relayFailures).toMatchObject({ failures: 1, last: { status: 502, room: 'room-1', requestId: 'qwert', error: expect.stringContaining('status code 429') } });
    expect(status.sendFailures).toEqual({ failures: 0, last: null });
    expect(a.logs).toContainEqual(['error', expect.stringMatching(/^permission request qwert \(Bash\) was not relayed to room room-1, the gateway answered 502: .*; answer it in the terminal$/)]);
  });

  it('a send the gateway refuses comes back as a tool error with the status code, and shows up in status', async () => {
    const a = await machine()(['room-1']);
    a.gateway.failSend = refusal;
    const result = await tool(a, 'send_message', { room_id: 'room-1', text: 'hi' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(`send_message failed with status 502: ${refusal.message}`);
    expect((await tool(a, 'status')).body.sendFailures).toMatchObject({ failures: 1, last: { status: 502, room: 'room-1' } });
    expect(a.logs).toContainEqual(['error', `send_message to room room-1 failed with status 502: ${refusal.message}`]);

    // A failure without an HTTP status (timeout, network) still counts.
    a.gateway.failSend = new Error('The operation was aborted due to timeout') as unknown as GatewayError;
    const timedOut = await tool(a, 'send_message', { room_id: 'room-1', text: 'hi' });
    expect(timedOut.text).toBe('send_message failed: The operation was aborted due to timeout');
    expect((await tool(a, 'status')).body.sendFailures).toMatchObject({ failures: 2, last: { status: null } });
  });
});

describe('thread bindings', () => {
  const askPermission = async (s: Session, id: string) => {
    await s.client.notification({
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: id, tool_name: 'Bash', description: 'Run the tests', input_preview: 'npm test' },
    });
    await new Promise((r) => setTimeout(r, 30));
  };
  const pushThread = async (s: Session, room: string, thread: string, content: string) => {
    await s.server.onMessage(threadMessage(room, thread, content));
    await new Promise((r) => setTimeout(r, 20));
  };

  it('connect_thread binds an existing thread at the gateway; a session bound only to it gets that thread, with the thread id and title in the meta', async () => {
    const a = await machine()();
    const result = await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    expect(result.body).toEqual({ ok: true, created: false, thread: { id: 'th-1', title: 'Fix the login bug', room: { id: 'room-1', name: 'backend' } }, threads: ['th-1'] });
    expect(a.gateway.threadCalls).toEqual(['get room-1/th-1']);
    expect(a.gateway.binds).toEqual([{ apply: 'bind', rooms: [], threads: ['th-1'] }]);

    await pushThread(a, 'room-1', 'th-1', 'work on it');
    expect(a.events).toEqual(['work on it']);
    expect(a.metas[0]).toMatchObject({ room: 'room-1', thread_id: 'th-1', thread_title: 'Fix the login bug' });

    // The room's top-level messages and its other threads are not meant for this session.
    await fanOut([a], 'room-1', 'top-level message');
    await pushThread(a, 'room-1', 'th-2', 'another thread');
    expect(a.events).toEqual(['work on it']);
    expect((await tool(a, 'status')).body).toMatchObject({ rooms: [], delivered: 1, dropped: { 'thread-not-bound': 2 } });
  });

  it('connect_thread with a title creates the thread in the room and binds it', async () => {
    const a = await machine()();
    const result = await tool(a, 'connect_thread', { room: 'ops', title: '  Rotate the keys  ' });
    expect(result.body).toMatchObject({ ok: true, created: true, thread: { title: 'Rotate the keys', room: { id: 'room-2', name: 'ops' } } });
    const id = (result.body.thread as { id: string }).id;
    expect(a.gateway.threadCalls).toEqual(['create room-2']);
    expect(a.gateway.binds).toEqual([{ apply: 'bind', rooms: [], threads: [id] }]);
    await pushThread(a, 'room-2', id, 'start');
    expect(a.metas[0]).toMatchObject({ thread_id: id, thread_title: 'Rotate the keys' });
  });

  it('a room message in a thread this session is not bound to still reaches it when the room is bound, as before, without a title', async () => {
    const a = await machine()(['room-1']);
    await pushThread(a, 'room-1', 'th-2', 'reply in an unbound thread');
    expect(a.events).toEqual(['reply in an unbound thread']);
    expect(a.metas[0]).toMatchObject({ thread_id: 'th-2' });
    expect(a.metas[0]).not.toHaveProperty('thread_title');
    // ... and a reply goes where the caller says, a top-level one without a thread.
    await tool(a, 'send_message', { room_id: 'room-1', text: 'hi' });
    expect(a.gateway.sent.at(-1)).toMatchObject({ roomId: 'room-1', threadId: null });
  });

  it('a bound thread is delivered even when a more recently bound session answers its room', async () => {
    const start = machine();
    const a = await start();
    await tool(a, 'connect_room', { room: 'backend' });
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    await later();
    const b = await start();
    await tool(b, 'connect_room', { room: 'backend' });
    await pushThread(a, 'room-1', 'th-1', 'the thread');
    await pushThread(a, 'room-1', 'th-2', 'a thread nobody bound');
    expect(a.events).toEqual(['the thread']);
    expect((await tool(a, 'status')).body).toMatchObject({ standby: ['room-1'], dropped: { 'answered-by-newer-session': 1 } });
  });

  it('send_message defaults to the thread of the message being answered; an explicit thread_id wins; another room gets none', async () => {
    const a = await machine()();
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    // Bound but nothing delivered yet: the thread that was just bound.
    expect((await tool(a, 'send_message', { room_id: 'room-1', text: 'starting' })).body).toMatchObject({ ok: true, thread_id: 'th-1' });
    expect(a.gateway.sent.at(-1)).toMatchObject({ roomId: 'room-1', content: 'starting', threadId: 'th-1' });

    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-2' });
    await pushThread(a, 'room-1', 'th-1', 'question');
    await tool(a, 'send_message', { room_id: 'room-1', text: 'answer' });
    expect(a.gateway.sent.at(-1)).toMatchObject({ threadId: 'th-1' });

    await tool(a, 'send_message', { room_id: 'room-1', text: 'elsewhere', thread_id: 'th-2' });
    expect(a.gateway.sent.at(-1)).toMatchObject({ threadId: 'th-2' });

    await tool(a, 'send_message', { room_id: 'room-2', text: 'other room' });
    expect(a.gateway.sent.at(-1)).toMatchObject({ roomId: 'room-2', threadId: null });
  });

  it('after a top-level message of a bound room, a reply is top-level again', async () => {
    const a = await machine()(['room-1']);
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    await pushThread(a, 'room-1', 'th-1', 'in the thread');
    await fanOut([a], 'room-1', 'in the room');
    await tool(a, 'send_message', { room_id: 'room-1', text: 'reply' });
    expect(a.gateway.sent.at(-1)).toMatchObject({ threadId: null });
  });

  it('a permission prompt goes into the bound thread, and only a verdict from that thread counts', async () => {
    const a = await machine()(['room-1']);
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    await askPermission(a, 'abcde');
    expect(a.gateway.sent.at(-1)).toMatchObject({ roomId: 'room-1', threadId: 'th-1' });
    expect(a.gateway.sent.at(-1)!.content).toContain('yes abcde');
    expect((await tool(a, 'status')).body).toMatchObject({ permissionRoom: 'room-1', permissionThread: 'th-1' });

    // The room is bound too, so its top-level "yes" is delivered as a verdict candidate, but the prompt was posted in the thread.
    await fanOut([a], 'room-1', 'yes abcde');
    await pushThread(a, 'room-1', 'th-2', 'yes abcde');
    expect(a.verdicts).toEqual([]);
    expect(a.logs).toContainEqual(['info', 'verdict for abcde from another room or thread than the prompt ignored']);

    await pushThread(a, 'room-1', 'th-1', 'yes abcde');
    expect(a.verdicts).toEqual([{ request_id: 'abcde', behavior: 'allow' }]);
    expect(a.events).toEqual([]);
  });

  it('a verdict in a bound thread of a room that is not bound counts, from an allowed human only', async () => {
    const a = await machine()();
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    await askPermission(a, 'abcde');
    await a.server.onMessage(threadMessage('room-1', 'th-1', 'yes abcde', { sender: 'mallory', senderId: 'user-mallory' }));
    await a.server.onMessage(threadMessage('room-1', 'th-1', 'yes abcde', { sender: 'lava', senderId: 'user-lan', senderType: 'AI' }));
    expect(a.verdicts).toEqual([]);
    await pushThread(a, 'room-1', 'th-1', 'no abcde');
    expect(a.verdicts).toEqual([{ request_id: 'abcde', behavior: 'deny' }]);
  });

  it('the thread that last delivered a message (or was bound last) is where the prompt goes; a room binding after a thread moves it to the room', async () => {
    const a = await machine()();
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-2' });
    await askPermission(a, 'aaaaa');
    expect(a.gateway.sent.at(-1)).toMatchObject({ threadId: 'th-2' });
    await pushThread(a, 'room-1', 'th-1', 'hello');
    await askPermission(a, 'bbbbb');
    expect(a.gateway.sent.at(-1)).toMatchObject({ threadId: 'th-1' });
    await tool(a, 'connect_room', { room: 'backend' });
    await askPermission(a, 'ccccc');
    expect(a.gateway.sent.at(-1)).toMatchObject({ roomId: 'room-1', threadId: null });
  });

  it('a thread bound after a room binding is where the prompt goes, in a room other than the bound one', async () => {
    const a = await machine()(['room-2']);
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    // The thread just bound is the active target, not the bound room-2.
    await askPermission(a, 'aaaaa');
    expect(a.gateway.sent.at(-1)).toMatchObject({ roomId: 'room-1', threadId: 'th-1' });
  });

  it('disconnect_thread unbinds at the gateway and returns replies, prompts and delivery to the room', async () => {
    const a = await machine()(['room-1']);
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    await pushThread(a, 'room-1', 'th-1', 'with title');
    const off = await tool(a, 'disconnect_thread', { thread_id: 'th-1' });
    expect(off.body).toEqual({ ok: true, thread_id: 'th-1', threads: [] });
    expect(a.gateway.binds.at(-1)).toEqual({ apply: 'unbind', rooms: [], threads: ['th-1'] });

    await tool(a, 'send_message', { room_id: 'room-1', text: 'back in the room' });
    expect(a.gateway.sent.at(-1)).toMatchObject({ threadId: null });
    await askPermission(a, 'abcde');
    expect(a.gateway.sent.at(-1)).toMatchObject({ roomId: 'room-1', threadId: null });
    expect((await tool(a, 'status')).body).toMatchObject({ threads: [], activeThread: null, permissionThread: null });
    // The thread's messages are room messages now: delivered, without a title.
    await pushThread(a, 'room-1', 'th-1', 'as a room message');
    expect(a.metas.at(-1)).not.toHaveProperty('thread_title');
  });

  it('after disconnecting its last thread a thread-only session receives nothing again', async () => {
    const a = await machine()();
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    await tool(a, 'disconnect_thread', { thread_id: 'th-1' });
    await pushThread(a, 'room-1', 'th-1', 'nobody home');
    expect(a.events).toEqual([]);
    await askPermission(a, 'abcde');
    expect(a.gateway.sent).toEqual([]);
  });

  it('refuses a thread of a room that is neither listed for the agent nor bound, and calls no thread route', async () => {
    const a = await machine()();
    const unknown = await tool(a, 'connect_thread', { room: 'room-7', thread_id: 'th-7' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toBe('connect_thread failed: no room matches "room-7"');
    const created = await tool(a, 'connect_thread', { room: 'room-7', title: 'x' });
    expect(created.isError).toBe(true);
    expect(a.gateway.threadCalls).toEqual([]);
    expect(a.gateway.binds).toEqual([]);
    expect((await tool(a, 'status')).body).toMatchObject({ threads: [] });
  });

  it('accepts a thread of a bound room that the room list does not show', async () => {
    const a = await machine()(['room-9']);
    const result = await tool(a, 'connect_thread', { room: 'room-9', thread_id: 'th-9' });
    expect(result.body).toMatchObject({ ok: true, thread: { id: 'th-9', room: { id: 'room-9' } } });
    expect(a.gateway.threadCalls).toEqual(['get room-9/th-9']);
  });

  it('refuses a thread that Triologue places in another room than the one asked about, and one it does not know', async () => {
    const a = await machine()();
    a.gateway.threadRoomOverride = 'room-2';
    const moved = await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    expect(moved.isError).toBe(true);
    expect(moved.text).toContain('belongs to another room');
    a.gateway.threadRoomOverride = null;
    const missing = await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-ops' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/^connect_thread failed with status 404: .*Thread not found/);
    expect(a.gateway.binds).toEqual([]);
    expect(a.server.state.boundThreads.size).toBe(0);
  });

  it('checks its arguments before it calls anything: room, exactly one of thread_id and title, id characters, title length', async () => {
    const a = await machine()();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ thread_id: 'th-1' }, 'room is required'],
      [{ room: 'backend' }, 'give either thread_id'],
      [{ room: 'backend', thread_id: 'th-1', title: 'x' }, 'give either thread_id'],
      [{ room: 'backend', thread_id: 'th/../1' }, 'thread_id must match'],
      [{ room: 'backend', title: 'x'.repeat(201) }, 'title is longer than 200'],
    ];
    for (const [args, message] of cases) {
      const result = await tool(a, 'connect_thread', args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(message);
    }
    expect((await tool(a, 'disconnect_thread', { thread_id: 'a b' })).isError).toBe(true);
    expect(a.gateway.threadCalls).toEqual([]);
    expect(a.gateway.binds).toEqual([]);
  });

  it('a thread that was created but could not be bound says so with its id, and is not recorded as bound', async () => {
    const a = await machine()();
    a.gateway.failBind = new GatewayError('POST http://gw/byoa/sessions/s/bind -> 400 too many', 400, null);
    const result = await tool(a, 'connect_thread', { room: 'backend', title: 'Fresh' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^connect_thread failed: thread th-new-\d+ was created but binding it failed: .*too many/);
    expect(a.server.state.boundThreads.size).toBe(0);
  });

  it('status lists the thread bindings, and a registration (also a recovery) carries them to the gateway', async () => {
    const a = await machine()();
    expect(a.gateway.connects.at(-1)).not.toHaveProperty('threads');
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    expect((await tool(a, 'status')).body).toMatchObject({
      threads: [{ id: 'th-1', room: 'room-1', title: 'Fix the login bug' }], activeRoom: 'room-1', activeThread: 'th-1', permissionRoom: 'room-1', permissionThread: 'th-1',
    });
    await (a.server as unknown as { register(reason: string | null, recover?: boolean): Promise<boolean> }).register('test', true);
    expect(a.gateway.connects.at(-1)).toMatchObject({ rooms: [], threads: ['th-1'] });
  });

  it('a thread bound before the gateway knows the session is sent with the registration', async () => {
    const start = machine();
    const outage = new GatewayError('POST http://gw/byoa/sessions/connect -> 503 Service Unavailable', 503, null);
    const a = await start([], { failConnect: outage, heartbeatSeconds: 0.05 });
    expect((await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' })).body).toMatchObject({ ok: true });
    a.gateway.failConnect = null;
    await waitFor(() => a.streams.length > 0, 'the stream after the registration');
    expect(a.gateway.connects.at(-1)).toMatchObject({ threads: ['th-1'] });
  });

  it('a relay into a thread the gateway refuses is recorded with the thread', async () => {
    const a = await machine()();
    await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
    a.gateway.failSend = new GatewayError('POST http://gw/byoa/sse/messages -> 400 threadId must name a thread in roomId', 400, null);
    await askPermission(a, 'abcde');
    expect((await tool(a, 'status')).body.relayFailures).toMatchObject({ failures: 1, last: { status: 400, room: 'room-1', threadId: 'th-1', requestId: 'abcde' } });
    expect(a.logs).toContainEqual(['error', expect.stringMatching(/was not relayed to room room-1 \(thread th-1\), the gateway answered 400/)]);
  });
  describe('verdicts', () => {
    it('a prompt posted at the top level of a bound room is answered from any message of that room, also inside a thread this session is not bound to (as before threads)', async () => {
      const a = await machine()(['room-1']);
      await askPermission(a, 'abcde');
      expect(a.gateway.sent.at(-1)).toMatchObject({ roomId: 'room-1', threadId: null });
      await pushThread(a, 'room-1', 'th-2', 'yes abcde');
      expect(a.verdicts).toEqual([{ request_id: 'abcde', behavior: 'allow' }]);
      expect(a.events).toEqual([]);
      await askPermission(a, 'fghij');
      await fanOut([a], 'room-1', 'no fghij');
      expect(a.verdicts.at(-1)).toEqual({ request_id: 'fghij', behavior: 'deny' });
    });

    it('a top-level prompt is not answered from another room, also not from a thread of another room', async () => {
      const a = await machine()(['room-1', 'room-2']);
      await askPermission(a, 'abcde');
      expect(a.gateway.sent.at(-1)).toMatchObject({ roomId: 'room-1', threadId: null });
      await fanOut([a], 'room-2', 'yes abcde');
      await pushThread(a, 'room-2', 'th-ops', 'yes abcde');
      expect(a.verdicts).toEqual([]);
      expect(a.logs.filter(([, m]) => m.includes('another room or thread than the prompt'))).toHaveLength(2);
      await pushThread(a, 'room-1', 'th-1', 'yes abcde');
      expect(a.verdicts).toEqual([{ request_id: 'abcde', behavior: 'allow' }]);
    });

    it('a prompt posted into a thread is not answered at the top level of its room, and the prompt stays open for its thread', async () => {
      const a = await machine()(['room-1']);
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
      await askPermission(a, 'abcde');
      await fanOut([a], 'room-1', 'yes abcde');
      expect(a.verdicts).toEqual([]);
      expect(a.logs).toContainEqual(['info', 'verdict for abcde from another room or thread than the prompt ignored']);
      expect((await tool(a, 'status')).body.pendingPermissions).toEqual(['abcde']);
      await pushThread(a, 'room-1', 'th-1', 'yes abcde');
      expect(a.verdicts).toEqual([{ request_id: 'abcde', behavior: 'allow' }]);
    });

    it('a prompt posted into a thread is not answered from another thread, bound or not', async () => {
      const a = await machine()();
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-2' });
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
      await askPermission(a, 'abcde');
      expect(a.gateway.sent.at(-1)).toMatchObject({ threadId: 'th-1' });
      await pushThread(a, 'room-1', 'th-2', 'yes abcde');
      await pushThread(a, 'room-1', 'th-3', 'yes abcde');
      expect(a.verdicts).toEqual([]);
      await pushThread(a, 'room-1', 'th-1', 'no abcde');
      expect(a.verdicts).toEqual([{ request_id: 'abcde', behavior: 'deny' }]);
    });

    it('the sender gate still applies to a verdict for a top-level prompt given inside a thread: not an agent, not a stranger', async () => {
      const a = await machine()(['room-1']);
      await askPermission(a, 'abcde');
      await a.server.onMessage(threadMessage('room-1', 'th-2', 'yes abcde', { sender: 'mallory', senderId: 'user-mallory' }));
      await a.server.onMessage(threadMessage('room-1', 'th-2', 'yes abcde', { sender: 'lava', senderId: 'user-lan', senderType: 'AI' }));
      expect(a.verdicts).toEqual([]);
      expect((await tool(a, 'status')).body).toMatchObject({ dropped: { 'sender-not-allowed': 1, 'ai-sender': 1 } });
      await pushThread(a, 'room-1', 'th-2', 'yes abcde');
      expect(a.verdicts).toEqual([{ request_id: 'abcde', behavior: 'allow' }]);
    });
  });

  describe('the reply default', () => {
    const lastSent = (s: Session) => s.gateway.sent.at(-1);

    it('with the room bound as well, a reply without thread_id is top-level, also after a message in the bound thread; an explicit thread_id still wins', async () => {
      const a = await machine()(['room-1']);
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
      await fanOut([a], 'room-1', 'a question in the room');
      await pushThread(a, 'room-1', 'th-1', 'something in the thread');
      await tool(a, 'send_message', { room_id: 'room-1', text: 'answer to the question' });
      expect(lastSent(a)).toMatchObject({ roomId: 'room-1', threadId: null });
      await tool(a, 'send_message', { room_id: 'room-1', text: 'with an empty thread_id', thread_id: '' });
      expect(lastSent(a)).toMatchObject({ threadId: null });
      expect((await tool(a, 'send_message', { room_id: 'room-1', text: 'into the thread', thread_id: 'th-1' })).body).toMatchObject({ thread_id: 'th-1' });
      expect(lastSent(a)).toMatchObject({ threadId: 'th-1' });
    });

    it('thread_id "" (or blanks) posts at the top level even where the thread would be the default; the result has no thread_id', async () => {
      const a = await machine()();
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
      await pushThread(a, 'room-1', 'th-1', 'question');
      const result = await tool(a, 'send_message', { room_id: 'room-1', text: 'top level please', thread_id: '' });
      expect(result.body).toEqual({ ok: true, room_id: 'room-1', messageId: 'm-1' });
      expect(lastSent(a)).toMatchObject({ threadId: null });
      await tool(a, 'send_message', { room_id: 'room-1', text: 'blank', thread_id: '   ' });
      expect(lastSent(a)).toMatchObject({ threadId: null });
      await tool(a, 'send_message', { room_id: 'room-1', text: 'omitted' });
      expect(lastSent(a)).toMatchObject({ threadId: 'th-1' });
    });

    it('with several bound threads of a room and the room not bound, a reply without thread_id goes into the thread of the last message the room delivered', async () => {
      const a = await machine()();
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-2' });
      await pushThread(a, 'room-1', 'th-1', 'one');
      await tool(a, 'send_message', { room_id: 'room-1', text: 'a' });
      expect(lastSent(a)).toMatchObject({ threadId: 'th-1' });
      await pushThread(a, 'room-1', 'th-2', 'two');
      await tool(a, 'send_message', { room_id: 'room-1', text: 'b' });
      expect(lastSent(a)).toMatchObject({ threadId: 'th-2' });
      await tool(a, 'send_message', { room_id: 'room-1', text: 'c', thread_id: 'th-1' });
      expect(lastSent(a)).toMatchObject({ threadId: 'th-1' });
    });

    it('the default is per room: a message of another room does not move it', async () => {
      const a = await machine()();
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
      await tool(a, 'connect_thread', { room: 'ops', thread_id: 'th-ops' });
      await pushThread(a, 'room-1', 'th-1', 'one');
      await pushThread(a, 'room-2', 'th-ops', 'two');
      await tool(a, 'send_message', { room_id: 'room-1', text: 'a' });
      expect(lastSent(a)).toMatchObject({ roomId: 'room-1', threadId: 'th-1' });
      await tool(a, 'send_message', { room_id: 'room-2', text: 'b' });
      expect(lastSent(a)).toMatchObject({ roomId: 'room-2', threadId: 'th-ops' });
    });

    it('with another room bound, a room bound only through a thread still defaults to that thread', async () => {
      const a = await machine()(['room-2']);
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
      await pushThread(a, 'room-1', 'th-1', 'in the thread');
      await fanOut([a], 'room-2', 'top level in the bound room');
      await tool(a, 'send_message', { room_id: 'room-1', text: 'reply to the thread' });
      expect(lastSent(a)).toMatchObject({ roomId: 'room-1', threadId: 'th-1' });
      await tool(a, 'send_message', { room_id: 'room-2', text: 'reply in the bound room' });
      expect(lastSent(a)).toMatchObject({ roomId: 'room-2', threadId: null });
    });

    it('after the last delivering thread is disconnected the room has no default; binding the room makes top level the default', async () => {
      const a = await machine()();
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-1' });
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-2' });
      await tool(a, 'disconnect_thread', { thread_id: 'th-2' });
      await tool(a, 'send_message', { room_id: 'room-1', text: 'a' });
      expect(lastSent(a)).toMatchObject({ threadId: null });
      await tool(a, 'connect_thread', { room: 'backend', thread_id: 'th-2' });
      await tool(a, 'send_message', { room_id: 'room-1', text: 'b' });
      expect(lastSent(a)).toMatchObject({ threadId: 'th-2' });
      await tool(a, 'connect_room', { room: 'backend' });
      await tool(a, 'send_message', { room_id: 'room-1', text: 'c' });
      expect(lastSent(a)).toMatchObject({ threadId: null });
    });

    it('the tool description says what an omitted and an empty thread_id do', async () => {
      const a = await machine()();
      const { tools } = await a.client.listTools();
      const send = tools.find((t) => t.name === 'send_message')!;
      expect(send.description).toContain('thread_id "" posts at the top level');
      expect(JSON.stringify(send.inputSchema)).toContain('(empty) posts at the top level');
    });
  });

  describe('the thread cap', () => {
    const bindMany = async (s: Session, count: number) => {
      for (let i = 0; i < count; i += 1) s.gateway.threads.set(`cap-${i}`, { id: `cap-${i}`, title: `T${i}`, roomId: 'room-1' });
      for (let i = 0; i < count; i += 1) expect((await tool(s, 'connect_thread', { room: 'backend', thread_id: `cap-${i}` })).isError).toBeUndefined();
    };

    it('refuses a 51st thread binding, naming the limit, before it creates or looks up anything', async () => {
      const a = await machine()();
      await bindMany(a, 50);
      a.gateway.threads.set('cap-50', { id: 'cap-50', title: 'T50', roomId: 'room-1' });
      const calls = a.gateway.threadCalls.length;
      const binds = a.gateway.binds.length;
      const existing = await tool(a, 'connect_thread', { room: 'backend', thread_id: 'cap-50' });
      expect(existing.isError).toBe(true);
      expect(existing.text).toContain('50 threads');
      const created = await tool(a, 'connect_thread', { room: 'backend', title: 'One too many' });
      expect(created.isError).toBe(true);
      expect(created.text).toContain('50 threads');
      expect(a.gateway.threadCalls).toHaveLength(calls);
      expect(a.gateway.binds).toHaveLength(binds);
      expect(a.server.state.boundThreads.size).toBe(50);
      // A registration still fits the gateway's 50-id limit.
      await (a.server as unknown as { register(reason: string | null, recover?: boolean): Promise<boolean> }).register('test', true);
      expect((a.gateway.connects.at(-1) as { threads?: string[] }).threads).toHaveLength(50);
    });

    it('binding an already bound thread again works at the cap, and a freed slot can be used', async () => {
      const a = await machine()();
      await bindMany(a, 50);
      expect((await tool(a, 'connect_thread', { room: 'backend', thread_id: 'cap-3' })).body).toMatchObject({ ok: true });
      await tool(a, 'disconnect_thread', { thread_id: 'cap-3' });
      expect((await tool(a, 'connect_thread', { room: 'backend', title: 'Fits now' })).body).toMatchObject({ ok: true, created: true });
      expect(a.server.state.boundThreads.size).toBe(50);
    });
  });
});
