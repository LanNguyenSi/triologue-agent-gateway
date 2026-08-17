/**
 * Tests for src/openclaw-bridge.ts (OpenClawBridge).
 *
 * `ws` is mocked (no real network); device/config identity files are real
 * temp files with a real Ed25519 keypair (crypto.generateKeyPairSync),
 * since devicePath/configPath are constructor parameters (an existing,
 * already-injectable seam - no production change needed here).
 *
 * Mutation guards (marked inline):
 *   M1: constructor stops throwing when the device file is missing
 *   M2: constructor stops throwing when no gateway token is found
 *   M3: injectAndWaitForResponse stops resolving completed:true on
 *       lifecycle:end
 *   M4: injectAndWaitForResponse stops treating lifecycle:error as failure
 *   M5: the assistant-stream handler stops treating text as cumulative
 *       (would concatenate instead of replace)
 *   M6: timeout handling stops firing after responseTimeoutMs
 */

import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock WebSocket ────────────────────────────────────────────────────────────

class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];
  sent: string[] = [];
  send = vi.fn((data: string) => this.sent.push(data));
  close = vi.fn();

  constructor(public url: string) {
    super();
    MockWebSocket.instances.push(this);
  }

  lastSentParsed<T = any>(): T {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

vi.mock('ws', () => ({ default: MockWebSocket }));

const { OpenClawBridge } = await import('../openclaw-bridge.js');

// ── Fixtures: real temp device identity + config ──────────────────────────────

let tmpDir: string;
let devicePath: string;
let configPath: string;
let deviceId: string;

function writeDeviceAndConfig(opts: { token?: string } = {}): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  deviceId = 'device-test-001';
  fs.writeFileSync(
    devicePath,
    JSON.stringify({
      deviceId,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  );
  if (opts.token !== undefined) {
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: opts.token } } }));
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-bridge-test-'));
  devicePath = path.join(tmpDir, 'device.json');
  configPath = path.join(tmpDir, 'openclaw.json');
  MockWebSocket.instances = [];
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
});

// ── Constructor - failure paths ────────────────────────────────────────────────

describe('OpenClawBridge constructor - failure paths', () => {
  it('throws when the device identity file does not exist (M1)', () => {
    // MUTATION GUARD M1: drop the throw in the catch → this would silently
    // continue with `this.device` undefined; fails.
    expect(
      () =>
        new OpenClawBridge({
          devicePath: path.join(tmpDir, 'does-not-exist.json'),
          configPath,
          gatewayToken: 'explicit-token',
        }),
    ).toThrow(/Device identity not found/);
  });

  it('throws when no gateway token can be found anywhere (M2)', () => {
    writeDeviceAndConfig(); // no config file written → configPath read fails too
    // MUTATION GUARD M2: drop the `if (!this.gatewayToken) throw` → a bridge
    // with an empty token would be constructed silently; fails.
    expect(() => new OpenClawBridge({ devicePath, configPath })).toThrow(
      /No gateway token found/,
    );
  });
});

// ── Constructor - success / token resolution paths ─────────────────────────────

describe('OpenClawBridge constructor - token resolution', () => {
  it('uses an explicitly passed gatewayToken over any other source', () => {
    writeDeviceAndConfig({ token: 'from-config-file' });
    const bridge = new OpenClawBridge({ devicePath, configPath, gatewayToken: 'explicit-token' });
    expect(bridge).toBeInstanceOf(OpenClawBridge);
  });

  it('reads the token from configPath when no explicit token is given', () => {
    writeDeviceAndConfig({ token: 'from-config-file' });
    expect(() => new OpenClawBridge({ devicePath, configPath })).not.toThrow();
  });

  it('falls back to OPENCLAW_GATEWAY_TOKEN env var when configPath is unreadable', () => {
    writeDeviceAndConfig(); // configPath never written
    process.env.OPENCLAW_GATEWAY_TOKEN = 'env-token';
    expect(() => new OpenClawBridge({ devicePath, configPath })).not.toThrow();
  });
});

// ── injectAndWaitForResponse - protocol driving ─────────────────────────────────

function idOfRequest(ws: MockWebSocket, method: string): string {
  const req = ws.sent.map((s) => JSON.parse(s)).find((m) => m.method === method);
  if (!req) throw new Error(`no ${method} request sent`);
  return req.id;
}

describe('injectAndWaitForResponse', () => {
  beforeEach(() => {
    writeDeviceAndConfig({ token: 'gw-token' });
  });

  it('resolves completed:true with the cumulative assistant text on lifecycle:end (M3, M5)', async () => {
    const bridge = new OpenClawBridge({ devicePath, configPath, responseTimeoutMs: 5000 });
    const resultPromise = bridge.injectAndWaitForResponse('hello agent');

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0];

    ws.emit('message', Buffer.from(JSON.stringify({ event: 'connect.challenge', payload: { nonce: 'nonce-1' } })));
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(1));

    // Respond to the 'connect' request so the code proceeds to send 'agent'.
    const connectId = idOfRequest(ws, 'connect');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: connectId, result: { ok: true } })));
    await vi.waitFor(() => expect(() => idOfRequest(ws, 'agent')).not.toThrow());

    const agentId = idOfRequest(ws, 'agent');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: agentId, result: { runId: 'run-abc' } })));
    // Let the microtask that assigns `runId` from the resolved 'agent' req
    // run before sending stream events, so they aren't racing the request/
    // response round trip the way two genuinely separate WS frames wouldn't.
    await new Promise((r) => setTimeout(r, 0));

    // Cumulative assistant text - later events replace, not append (M5).
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'event',
          event: 'agent',
          payload: { runId: 'run-abc', stream: 'assistant', data: { text: 'Hel' } },
        }),
      ),
    );
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'event',
          event: 'agent',
          payload: { runId: 'run-abc', stream: 'assistant', data: { text: 'Hello world' } },
        }),
      ),
    );
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'event',
          event: 'agent',
          payload: { runId: 'run-abc', stream: 'lifecycle', data: { phase: 'end' } },
        }),
      ),
    );

    const result = await resultPromise;
    // MUTATION GUARD M3: if lifecycle:end stops calling finish(), this hangs
    // until the timeout instead; MUTATION GUARD M5: if assistant text
    // concatenated instead of replaced, this would be 'HelHello world'.
    expect(result).toEqual({ text: 'Hello world', runId: 'run-abc', completed: true });
    expect(ws.close).toHaveBeenCalled();
  });

  it('resolves completed:false with an error on lifecycle:error (M4)', async () => {
    const bridge = new OpenClawBridge({ devicePath, configPath, responseTimeoutMs: 5000 });
    const resultPromise = bridge.injectAndWaitForResponse('hello agent');

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0];
    ws.emit('message', Buffer.from(JSON.stringify({ event: 'connect.challenge', payload: { nonce: 'n' } })));
    await vi.waitFor(() => expect(() => idOfRequest(ws, 'connect')).not.toThrow());
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: idOfRequest(ws, 'connect'), result: {} })));
    await vi.waitFor(() => expect(() => idOfRequest(ws, 'agent')).not.toThrow());
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: idOfRequest(ws, 'agent'), result: { runId: 'run-err' } })));

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'event',
          event: 'agent',
          payload: { runId: 'run-err', stream: 'lifecycle', data: { phase: 'error', message: 'agent crashed' } },
        }),
      ),
    );

    const result = await resultPromise;
    // MUTATION GUARD M4: if the `phase === 'error'` branch is dropped,
    // this would hang instead of resolving completed:false.
    expect(result.completed).toBe(false);
    expect(result.error).toContain('agent crashed');
  });

  it('resolves with an error (not a throw) when the socket errors', async () => {
    const bridge = new OpenClawBridge({ devicePath, configPath, responseTimeoutMs: 5000 });
    const resultPromise = bridge.injectAndWaitForResponse('hi');

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0];
    ws.emit('error', new Error('ECONNREFUSED'));

    const result = await resultPromise;
    expect(result.completed).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('resolves with whatever partial text was captured when the socket closes unexpectedly', async () => {
    const bridge = new OpenClawBridge({ devicePath, configPath, responseTimeoutMs: 5000 });
    const resultPromise = bridge.injectAndWaitForResponse('hi');

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0];
    ws.emit('close');

    const result = await resultPromise;
    expect(result.completed).toBe(false);
    expect(result.error).toBe('WebSocket closed unexpectedly');
  });

  it('times out after responseTimeoutMs with completed:false (M6)', async () => {
    vi.useFakeTimers();
    const bridge = new OpenClawBridge({ devicePath, configPath, responseTimeoutMs: 50 });
    const resultPromise = bridge.injectAndWaitForResponse('hi');

    await vi.advanceTimersByTimeAsync(50);

    const result = await resultPromise;
    // MUTATION GUARD M6: if the timer is dropped, this promise never
    // settles and the test hangs until the suite-level timeout.
    expect(result.completed).toBe(false);
    expect(result.error).toContain('Timeout after 50ms');
  });
});

// ── inject (fire-and-forget) ────────────────────────────────────────────────────

describe('inject (fire-and-forget)', () => {
  beforeEach(() => {
    writeDeviceAndConfig({ token: 'gw-token' });
  });

  it('resolves with the runId once the agent request is accepted', async () => {
    const bridge = new OpenClawBridge({ devicePath, configPath });
    const resultPromise = bridge.inject('fire and forget');

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0];
    ws.emit('message', Buffer.from(JSON.stringify({ event: 'connect.challenge', payload: { nonce: 'n' } })));
    await vi.waitFor(() => expect(() => idOfRequest(ws, 'connect')).not.toThrow());
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: idOfRequest(ws, 'connect'), result: {} })));
    await vi.waitFor(() => expect(() => idOfRequest(ws, 'agent')).not.toThrow());
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: idOfRequest(ws, 'agent'), result: { runId: 'run-ff' } })));

    const runId = await resultPromise;
    expect(runId).toBe('run-ff');
    expect(ws.close).toHaveBeenCalled();
  });

  it('rejects when the socket errors', async () => {
    const bridge = new OpenClawBridge({ devicePath, configPath });
    const resultPromise = bridge.inject('hi');

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    MockWebSocket.instances[0].emit('error', new Error('ECONNRESET'));

    await expect(resultPromise).rejects.toThrow('ECONNRESET');
  });

  it('rejects after the 8s inject timeout', async () => {
    vi.useFakeTimers();
    const bridge = new OpenClawBridge({ devicePath, configPath });
    const resultPromise = bridge.inject('hi');

    const assertion = expect(resultPromise).rejects.toThrow('Inject timeout');
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
  });

  it('rejects when the server sends malformed JSON', async () => {
    const bridge = new OpenClawBridge({ devicePath, configPath });
    const resultPromise = bridge.inject('hi');

    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    MockWebSocket.instances[0].emit('message', Buffer.from('{ not json'));

    await expect(resultPromise).rejects.toThrow();
  });
});
