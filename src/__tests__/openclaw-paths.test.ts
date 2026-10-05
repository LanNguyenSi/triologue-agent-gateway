/**
 * Tests for the OPENCLAW_HOME base-directory resolution (src/openclaw-paths.ts)
 * and its two consumers that read files at runtime: openclaw-inject.ts (module
 * load) and OpenClawBridge (constructor).
 */

import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];
  sent: string[] = [];
  send = vi.fn((data: string) => this.sent.push(data));
  close = vi.fn();

  constructor(public url: string) {
    super();
    MockWebSocket.instances.push(this);
  }
}

vi.mock('ws', () => ({ default: MockWebSocket }));

const {
  DEFAULT_OPENCLAW_HOME,
  resolveOpenClawHome,
  openClawConfigPath,
  openClawDevicePath,
  openClawReplyScriptPath,
  openClawReplyHint,
} = await import('../openclaw-paths.js');

let tmpDir: string;
const savedHome = process.env.OPENCLAW_HOME;
const savedToken = process.env.OPENCLAW_GATEWAY_TOKEN;

function writeInstall(home: string, deviceId: string, token: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  fs.mkdirSync(path.join(home, 'identity'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'identity', 'device.json'),
    JSON.stringify({
      deviceId,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  );
  fs.writeFileSync(path.join(home, 'openclaw.json'), JSON.stringify({ gateway: { auth: { token } } }));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-paths-test-'));
  MockWebSocket.instances = [];
  delete process.env.OPENCLAW_HOME;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = savedHome;
  if (savedToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
  else process.env.OPENCLAW_GATEWAY_TOKEN = savedToken;
});

describe('resolveOpenClawHome', () => {
  it('falls back to the historical /root/.openclaw when OPENCLAW_HOME is unset', () => {
    expect(DEFAULT_OPENCLAW_HOME).toBe('/root/.openclaw');
    expect(resolveOpenClawHome({})).toBe('/root/.openclaw');
    expect(openClawConfigPath({})).toBe('/root/.openclaw/openclaw.json');
    expect(openClawDevicePath({})).toBe('/root/.openclaw/identity/device.json');
    expect(openClawReplyScriptPath({})).toBe('/root/.openclaw/workspace/send-to-triologue.sh');
  });

  it('treats a blank OPENCLAW_HOME as unset', () => {
    expect(resolveOpenClawHome({ OPENCLAW_HOME: '   ' })).toBe('/root/.openclaw');
  });

  it('derives every path from OPENCLAW_HOME when it is set', () => {
    const env = { OPENCLAW_HOME: '/srv/oc' };
    expect(openClawConfigPath(env)).toBe('/srv/oc/openclaw.json');
    expect(openClawDevicePath(env)).toBe('/srv/oc/identity/device.json');
    expect(openClawReplyScriptPath(env)).toBe('/srv/oc/workspace/send-to-triologue.sh');
  });

  it('reads process.env by default', () => {
    process.env.OPENCLAW_HOME = '/from/process/env';
    expect(resolveOpenClawHome()).toBe('/from/process/env');
  });
});

describe('openclaw-inject reads its identity from OPENCLAW_HOME', () => {
  it('signs the connect request with the device found under OPENCLAW_HOME', async () => {
    writeInstall(tmpDir, 'device-from-env-home', 'token-from-env-home');
    process.env.OPENCLAW_HOME = tmpDir;
    vi.resetModules();
    const { injectToSession } = await import('../openclaw-inject.js');

    const result = injectToSession('hello').catch((e: Error) => e);
    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0];
    ws.emit('message', Buffer.from(JSON.stringify({ event: 'connect.challenge', payload: { nonce: 'n1' } })));

    await vi.waitFor(() => expect(ws.sent.length).toBe(1));
    const connect = JSON.parse(ws.sent[0]);
    expect(connect.method).toBe('connect');
    expect(connect.params.device.id).toBe('device-from-env-home');
    expect(connect.params.auth.token).toBe('token-from-env-home');

    ws.emit('error', new Error('stop'));
    await result;
  });
});

describe('OpenClawBridge default paths follow OPENCLAW_HOME', () => {
  it('loads device identity and token from OPENCLAW_HOME when no path is passed', async () => {
    writeInstall(tmpDir, 'bridge-device', 'bridge-token');
    process.env.OPENCLAW_HOME = tmpDir;
    const { OpenClawBridge } = await import('../openclaw-bridge.js');
    expect(() => new OpenClawBridge()).not.toThrow();
  });

  it('names the resolved default device path in the error when nothing is installed there', async () => {
    process.env.OPENCLAW_HOME = tmpDir;
    const { OpenClawBridge } = await import('../openclaw-bridge.js');
    expect(() => new OpenClawBridge()).toThrow(
      `Device identity not found at ${path.join(tmpDir, 'identity', 'device.json')}`,
    );
  });
});

describe('openClawReplyHint', () => {
  it('names the reply script under OPENCLAW_HOME and the room id', () => {
    expect(openClawReplyHint('room-1', { OPENCLAW_HOME: '/opt/oc' })).toBe(
      '(Reply with: /opt/oc/workspace/send-to-triologue.sh room-1 "<your message>")',
    );
  });

  it('keeps the historical default when OPENCLAW_HOME is unset', () => {
    expect(openClawReplyHint('room-2', {})).toBe(
      '(Reply with: /root/.openclaw/workspace/send-to-triologue.sh room-2 "<your message>")',
    );
  });

  it('reads process.env by default', () => {
    const saved = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = '/from/process/env';
    try {
      expect(openClawReplyHint('r')).toContain('/from/process/env/workspace/send-to-triologue.sh r ');
    } finally {
      if (saved === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = saved;
    }
  });
});
