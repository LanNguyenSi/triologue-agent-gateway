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

class FakeGateway {
  sent: Array<{ roomId: string; content: string }> = [];
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
  async bind(_s: string, rooms: string[]) { return { rooms, threads: [] }; }
  async unbind(_s: string, rooms: string[]) { return { rooms, threads: [] }; }
  async endSession() {}
  async listRooms() { return ROOMS; }
  async sendMessage(roomId: string, content: string) {
    if (this.failSend) throw this.failSend;
    this.sent.push({ roomId, content });
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
    const session: Session = { server, client, gateway, streams, bindingDir, pid, events: [], verdicts: [], logs };
    client.setNotificationHandler(ChannelNotification, async (n) => { session.events.push(n.params.content); });
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
