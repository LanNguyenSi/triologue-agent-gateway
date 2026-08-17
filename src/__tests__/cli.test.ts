/**
 * Tests for src/cli.ts (triologue-cli).
 *
 * cli.ts is a top-level script with no exported functions - every branch
 * (arg parsing, WebSocket handling, readline commands) runs as an
 * unguarded side effect at import time, including `process.exit()` calls.
 * That makes it fundamentally unlike the other MED-gap files: it cannot be
 * `import`-ed into the vitest worker process (a `process.exit()` mid-run
 * would kill the whole test run), and adding an export/seam to make it
 * importable is out of scope - the task's allowed production changes are
 * limited to the three named seam refactors, none of which is cli.ts.
 *
 * So these tests drive cli.ts the only way its current shape allows:
 * spawning it as a real child process (`tsx src/cli.ts <args>`) and
 * asserting on stdout/stderr/exit code. For the connected-agent scenarios,
 * the "gateway" it connects to is a real local `ws` WebSocketServer bound
 * to an ephemeral loopback port - no external network, but a real process
 * boundary and a real socket, matching how the CLI is actually invoked.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

const CLI_PATH = new URL('../cli.ts', import.meta.url).pathname;
const TSX_BIN = new URL('../../node_modules/.bin/tsx', import.meta.url).pathname;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(TSX_BIN, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      // stdin must stay open ('pipe', not 'ignore'): in interactive mode
    // (no --json/--pipe) cli.ts wires a readline interface to
    // process.stdin, and an already-closed stdin makes readline emit
    // 'close' immediately, which cli.ts treats as `/quit` - the process
    // would exit 0 before the WebSocket handshake even completes.
    stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

/** Spawns the CLI without waiting for it to exit - caller controls lifecycle. */
function spawnCli(args: string[], env: Record<string, string> = {}): {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
} {
  const child = spawn(TSX_BIN, [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    // stdin must stay open ('pipe', not 'ignore'): in interactive mode
    // (no --json/--pipe) cli.ts wires a readline interface to
    // process.stdin, and an already-closed stdin makes readline emit
    // 'close' immediately, which cli.ts treats as `/quit` - the process
    // would exit 0 before the WebSocket handshake even completes.
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitUntil(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition never became true');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let server: WebSocketServer | null = null;
let spawned: ChildProcessWithoutNullStreams | null = null;

afterEach(async () => {
  if (spawned && !spawned.killed) {
    spawned.kill('SIGKILL');
  }
  spawned = null;
  if (server) {
    // A SIGKILL'd client doesn't send a clean WS close frame, so the
    // server-side connection can linger and `server.close()`'s callback
    // would otherwise wait indefinitely for it. Terminate any remaining
    // sockets first so close() settles promptly.
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe('cli.ts - arg parsing (no connection attempted)', () => {
  it('--help prints usage and exits 0', async () => {
    const { stdout, code } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('USAGE:');
    expect(stdout).toContain('--token');
  }, 15000);

  it('exits 1 with an error when no token is provided (arg or env)', async () => {
    const { stderr, code } = await runCli([], { BYOA_TOKEN: '' });
    expect(code).toBe(1);
    expect(stderr).toContain('Token required');
  }, 15000);
});

describe('cli.ts - connected to a local fake gateway', () => {
  it('authenticates, selects the single available room, and relays a message as JSON (--json mode)', async () => {
    server = new WebSocketServer({ port: 0, path: '/byoa/ws' });
    const port = (server.address() as { port: number }).port;

    const connectionReceived = new Promise<WsSocket>((resolve) => {
      server!.on('connection', (ws) => resolve(ws));
    });

    const spawnedInfo = spawnCli(
      ['--server', `ws://127.0.0.1:${port}/byoa/ws`, '--token', 'test-token-123', '--json'],
    );
    spawned = spawnedInfo.child;

    const ws = await connectionReceived;
    const authMsg: any = await new Promise((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(authMsg).toEqual({ type: 'auth', token: 'test-token-123' });

    ws.send(
      JSON.stringify({
        type: 'auth_ok',
        agent: { name: 'TestBot', emoji: '🤖', username: 'testbot', mentionKey: 'test', trustLevel: 'standard' },
        rooms: [{ id: 'room-1', name: 'General' }],
      }),
    );

    ws.send(
      JSON.stringify({
        type: 'message',
        id: 'm1',
        room: 'room-1',
        roomName: 'General',
        sender: 'alice',
        senderDisplayName: 'Alice',
        senderType: 'human',
        content: 'hello from the room',
        timestamp: '2026-04-13T18:00:00Z',
      }),
    );

    await waitUntil(() => spawnedInfo.stdout().includes('"content":"hello from the room"'));
    const jsonLine = spawnedInfo
      .stdout()
      .split('\n')
      .find((l) => l.includes('"content":"hello from the room"'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed).toMatchObject({
      type: 'message',
      id: 'm1',
      room: 'room-1',
      sender: 'alice',
      content: 'hello from the room',
    });
  }, 15000);

  it('exits 1 with an auth-failure message when the gateway closes with code 4003', async () => {
    server = new WebSocketServer({ port: 0, path: '/byoa/ws' });
    const port = (server.address() as { port: number }).port;

    server.on('connection', (ws) => {
      ws.once('message', () => {
        ws.close(4003, 'Auth failed');
      });
    });

    const { stderr, code } = await runCli([
      '--server',
      `ws://127.0.0.1:${port}/byoa/ws`,
      '--token',
      'bad-token',
      '--quiet',
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain('Authentication failed');
  }, 15000);

  it('responds to a ping with a pong (keepalive)', async () => {
    server = new WebSocketServer({ port: 0, path: '/byoa/ws' });
    const port = (server.address() as { port: number }).port;
    const connectionReceived = new Promise<WsSocket>((resolve) => {
      server!.on('connection', (ws) => resolve(ws));
    });

    spawned = spawnCli([
      '--server',
      `ws://127.0.0.1:${port}/byoa/ws`,
      '--token',
      'test-token-456',
      '--quiet',
    ]).child;

    const ws = await connectionReceived;
    await new Promise((resolve) => ws.once('message', resolve)); // auth frame
    ws.send(JSON.stringify({ type: 'auth_ok', agent: { name: 'Bot', emoji: '🤖', username: 'bot', mentionKey: 'bot', trustLevel: 'standard' }, rooms: [] }));

    const pongReceived = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const evt = JSON.parse(data.toString());
        if (evt.type === 'pong') resolve(evt);
      });
    });
    ws.send(JSON.stringify({ type: 'ping' }));

    await expect(pongReceived).resolves.toEqual({ type: 'pong' });
  }, 15000);
});
