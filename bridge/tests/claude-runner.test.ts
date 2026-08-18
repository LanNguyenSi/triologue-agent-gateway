/**
 * Tests for bridge/src/claude-runner.ts.
 *
 * `spawn` and the fs/promises temp-file calls are mocked so no real
 * process is spawned and no real disk I/O happens. The mock child is a
 * plain EventEmitter with `.stdout` / `.stderr` sub-emitters, matching
 * the subset of the Node ChildProcess API the source actually uses.
 *
 * Mutation guards (marked inline):
 *   M1: buildMcpConfig stops using cfg.gatewayUrl / cfg.byoaToken
 *   M2: buildPrompt drops the roomName / history sections
 *   M3: runClaude stops capturing stdout/stderr
 *   M4: runClaude stops propagating a non-zero exit code
 *   M5: runClaude stops killing the child on timeout
 *   M6: runClaude stops cleaning up the temp dir (finally block)
 *   M7: mcp.json is no longer written with mode 0o600
 *   M8: runClaude stops escalating to SIGKILL after the 5s killTimer
 *   M9: runClaude stops suppressing SIGKILL once the child has actually
 *       exited (the `exited === true` branch of the `if (!exited)` guard)
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeConfig } from '../src/config.js';
import type { AgentIdentity, IncomingMessage } from '../src/mention.js';

const fsMocks = vi.hoisted(() => ({
  mkdtemp: vi.fn<(...args: any[]) => Promise<string>>(),
  writeFile: vi.fn<(...args: any[]) => Promise<void>>(),
  rm: vi.fn<(...args: any[]) => Promise<void>>(),
}));

vi.mock('node:fs/promises', () => fsMocks);

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { buildMcpConfig, buildPrompt, runClaude } = await import('../src/claude-runner.js');

// ── Mock child process ───────────────────────────────────────────────────────

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition never became true');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const FAKE_TMP_DIR = '/tmp/triologue-bridge-fake';

beforeEach(() => {
  fsMocks.mkdtemp.mockResolvedValue(FAKE_TMP_DIR);
  fsMocks.writeFile.mockResolvedValue(undefined);
  fsMocks.rm.mockResolvedValue(undefined);
  spawnMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCfg(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    gatewayUrl: 'https://gateway.test',
    byoaToken: 'byoa_test_token',
    claudeCmd: 'claude',
    roomAllowlist: null,
    claudeTimeoutMs: 120_000,
    logLevel: 'info',
    ...overrides,
  };
}

const agent: AgentIdentity = {
  username: 'claude-bot',
  mentionKey: 'code',
  receiveMode: 'mentions',
};

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'm1',
    room: 'room-1',
    roomName: 'General',
    sender: 'alice',
    senderType: 'HUMAN',
    content: 'hello there',
    timestamp: '2026-04-13T18:00:00Z',
    ...overrides,
  };
}

// ── buildMcpConfig (M1) ───────────────────────────────────────────────────────

describe('buildMcpConfig', () => {
  it('points the streamable-HTTP MCP server at gatewayUrl/byoa/mcp with a Bearer header', () => {
    const cfg = makeCfg({ gatewayUrl: 'https://gw.example.com', byoaToken: 'byoa_abc' });
    const mcpConfig = buildMcpConfig(cfg);
    // MUTATION GUARD M1: swap in a hard-coded URL/token → this fails
    expect(mcpConfig).toEqual({
      mcpServers: {
        'triologue-gateway': {
          type: 'http',
          url: 'https://gw.example.com/byoa/mcp',
          headers: { Authorization: 'Bearer byoa_abc' },
        },
      },
    });
  });
});

// ── buildPrompt (M2) ──────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  it('includes the agent identity, room, and latest message', () => {
    const prompt = buildPrompt({ message: makeMessage(), agent });
    expect(prompt).toContain('@code');
    expect(prompt).toContain('claude-bot');
    expect(prompt).toContain('room-1');
    expect(prompt).toContain('"General"');
    expect(prompt).toContain('@alice');
    expect(prompt).toContain('hello there');
    expect(prompt).toContain('send_message');
  });

  it('omits the room-name parenthetical when roomName is absent', () => {
    const prompt = buildPrompt({ message: makeMessage({ roomName: undefined }), agent });
    expect(prompt).not.toContain('("');
  });

  it('includes history lines when history is provided (M2)', () => {
    const prompt = buildPrompt({
      message: makeMessage(),
      agent,
      history: [
        { sender: 'bob', content: 'earlier message 1' },
        { sender: 'carol', content: 'earlier message 2' },
      ],
    });
    // MUTATION GUARD M2: drop the history block → these lines vanish; fails
    expect(prompt).toContain('Recent room history');
    expect(prompt).toContain('bob: earlier message 1');
    expect(prompt).toContain('carol: earlier message 2');
  });

  it('omits the history section entirely when history is empty or absent', () => {
    const withoutHistory = buildPrompt({ message: makeMessage(), agent });
    expect(withoutHistory).not.toContain('Recent room history');

    const withEmptyHistory = buildPrompt({ message: makeMessage(), agent, history: [] });
    expect(withEmptyHistory).not.toContain('Recent room history');
  });
});

// ── runClaude - success path ──────────────────────────────────────────────────

describe('runClaude - success', () => {
  it('resolves exitCode 0 and captures stdout/stderr (M3)', async () => {
    const mockChild = new MockChildProcess();
    spawnMock.mockReturnValue(mockChild);

    const resultPromise = runClaude(makeCfg(), { message: makeMessage(), agent });

    await waitUntil(() => spawnMock.mock.calls.length > 0);
    mockChild.stdout.emit('data', Buffer.from('partial-'));
    mockChild.stdout.emit('data', Buffer.from('output'));
    mockChild.stderr.emit('data', Buffer.from('a warning'));
    mockChild.emit('close', 0);

    const result = await resultPromise;
    // MUTATION GUARD M3: stop wiring the 'data' listeners → these are empty; fails
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('partial-output');
    expect(result.stderr).toBe('a warning');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('spawns cfg.claudeCmd with the prompt, mcp-config path, and the three allowed gateway tools', async () => {
    const mockChild = new MockChildProcess();
    spawnMock.mockReturnValue(mockChild);
    const cfg = makeCfg({ claudeCmd: '/opt/claude/bin/claude' });

    const resultPromise = runClaude(cfg, { message: makeMessage(), agent });
    await waitUntil(() => spawnMock.mock.calls.length > 0);
    mockChild.emit('close', 0);
    await resultPromise;

    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('/opt/claude/bin/claude');
    expect(args).toContain('-p');
    expect(args).toContain(buildPrompt({ message: makeMessage(), agent }));
    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/triologue-bridge-fake/mcp.json');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    const allowedToolsIndices = args
      .map((a: string, i: number) => (a === '--allowedTools' ? i : -1))
      .filter((i: number) => i !== -1);
    const allowedTools = allowedToolsIndices.map((i: number) => args[i + 1]);
    expect(allowedTools.sort()).toEqual(
      [
        'mcp__triologue-gateway__list_rooms',
        'mcp__triologue-gateway__get_room_messages',
        'mcp__triologue-gateway__send_message',
      ].sort(),
    );
    expect(opts).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('writes the mcp config file with mode 0600 (M7)', async () => {
    const mockChild = new MockChildProcess();
    spawnMock.mockReturnValue(mockChild);
    const cfg = makeCfg();

    const resultPromise = runClaude(cfg, { message: makeMessage(), agent });
    await waitUntil(() => fsMocks.writeFile.mock.calls.length > 0);
    mockChild.emit('close', 0);
    await resultPromise;

    const [path, content, opts] = fsMocks.writeFile.mock.calls[0];
    expect(path).toBe('/tmp/triologue-bridge-fake/mcp.json');
    expect(JSON.parse(content as string)).toEqual(buildMcpConfig(cfg));
    // MUTATION GUARD M7: drop `mode: 0o600` → the Bearer token file would be
    // world-readable under a loose umask; fails
    expect(opts).toEqual({ encoding: 'utf-8', mode: 0o600 });
  });

  it('always cleans up the temp dir, even on success (M6)', async () => {
    const mockChild = new MockChildProcess();
    spawnMock.mockReturnValue(mockChild);

    const resultPromise = runClaude(makeCfg(), { message: makeMessage(), agent });
    await waitUntil(() => spawnMock.mock.calls.length > 0);
    mockChild.emit('close', 0);
    await resultPromise;

    expect(fsMocks.rm).toHaveBeenCalledWith(FAKE_TMP_DIR, { recursive: true, force: true });
  });
});

// ── runClaude - failure paths ─────────────────────────────────────────────────

describe('runClaude - failure paths', () => {
  it('propagates a non-zero exit code without throwing (M4)', async () => {
    const mockChild = new MockChildProcess();
    spawnMock.mockReturnValue(mockChild);

    const resultPromise = runClaude(makeCfg(), { message: makeMessage(), agent });
    await waitUntil(() => spawnMock.mock.calls.length > 0);
    mockChild.emit('close', 1);

    const result = await resultPromise;
    // MUTATION GUARD M4: hard-code exitCode to 0 → this fails
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  it('treats a null close code as exit 0 (process killed by signal with no code)', async () => {
    const mockChild = new MockChildProcess();
    spawnMock.mockReturnValue(mockChild);

    const resultPromise = runClaude(makeCfg(), { message: makeMessage(), agent });
    await waitUntil(() => spawnMock.mock.calls.length > 0);
    mockChild.emit('close', null);

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
  });

  it('rejects when spawn emits an "error" event (e.g. ENOENT for a missing claude binary)', async () => {
    const mockChild = new MockChildProcess();
    spawnMock.mockReturnValue(mockChild);

    const resultPromise = runClaude(makeCfg(), { message: makeMessage(), agent });
    await waitUntil(() => spawnMock.mock.calls.length > 0);
    const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    mockChild.emit('error', err);

    await expect(resultPromise).rejects.toThrow('spawn claude ENOENT');
  });

  it('cleans up the temp dir even when spawn errors (M6)', async () => {
    const mockChild = new MockChildProcess();
    spawnMock.mockReturnValue(mockChild);

    const resultPromise = runClaude(makeCfg(), { message: makeMessage(), agent });
    await waitUntil(() => spawnMock.mock.calls.length > 0);
    mockChild.emit('error', new Error('boom'));

    await expect(resultPromise).rejects.toThrow('boom');
    expect(fsMocks.rm).toHaveBeenCalledWith(FAKE_TMP_DIR, { recursive: true, force: true });
  });

  it('kills the child with SIGTERM and reports timedOut once claudeTimeoutMs elapses (M5)', async () => {
    const mockChild = new MockChildProcess();
    spawnMock.mockReturnValue(mockChild);
    const cfg = makeCfg({ claudeTimeoutMs: 20 });

    const resultPromise = runClaude(cfg, { message: makeMessage(), agent });

    // MUTATION GUARD M5: remove the softTimer's `child.kill('SIGTERM')` call
    // → this never fires and the waitUntil below times out the test.
    await waitUntil(() => mockChild.kill.mock.calls.length > 0);
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

    // Simulate the child actually exiting once it receives the signal.
    mockChild.emit('close', null);

    const result = await resultPromise;
    expect(result.timedOut).toBe(true);
  });

  it('escalates to SIGKILL 5s after SIGTERM when the child ignores SIGTERM and never exits (M8)', async () => {
    vi.useFakeTimers();
    try {
      const mockChild = new MockChildProcess();
      // Uses the shared MockChildProcess.kill() unmodified, which sets
      // `killed = true` on every call — matching real Node (verified
      // against a real child process that installs a SIGTERM handler and
      // stays alive: `.killed` was already `true` right after the first
      // kill() call returned). The child below never emits 'exit' or
      // 'close', simulating exactly that scenario: SIGTERM delivered
      // (killed flips true) but the process keeps running. The fixed
      // guard tracks real termination via the 'exit' event instead of
      // `child.killed`, so it must still escalate here.
      spawnMock.mockReturnValue(mockChild);
      const cfg = makeCfg({ claudeTimeoutMs: 10 });

      const resultPromise = runClaude(cfg, { message: makeMessage(), agent });

      // Flush the mkdtemp/writeFile mock-promise chain so spawn() runs,
      // then advance past claudeTimeoutMs to fire the SIGTERM soft-kill.
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(mockChild.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
      expect(mockChild.killed).toBe(true);

      // MUTATION GUARD M8: revert the killTimer's guard to
      // `if (!child.killed) child.kill('SIGKILL')` -> `killed` is already
      // true at this point (asserted above), so the second kill() never
      // happens and the assertions below fail.
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockChild.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      expect(mockChild.kill).toHaveBeenCalledTimes(2);

      // Let the run settle so the test doesn't leak a pending Promise.
      mockChild.emit('exit', null);
      mockChild.emit('close', null);
      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the killTimer on a clean exit within the 5s escalation window (M8 clearTimeout)', async () => {
    vi.useFakeTimers();
    try {
      const mockChild = new MockChildProcess();
      spawnMock.mockReturnValue(mockChild);
      const cfg = makeCfg({ claudeTimeoutMs: 10 });

      const resultPromise = runClaude(cfg, { message: makeMessage(), agent });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(mockChild.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

      // The child terminates promptly, well inside the 5s escalation
      // window.
      mockChild.emit('exit', null);
      mockChild.emit('close', null);
      await resultPromise;

      // MUTATION GUARD (F1 fix): the previous version of this test only
      // asserted that SIGKILL never fired, but that held even with
      // `if (killTimer) clearTimeout(killTimer);` deleted, because the
      // 'exit' listener above already sets `exited = true` and the
      // killTimer callback's `if (!exited)` guard suppresses the kill
      // independently of whether the timer itself was cancelled.
      // Asserting on the fake-timer queue directly, right after the
      // promise settles, pins that the killTimer handle was actually
      // cleared: if the clearTimeout call is removed, the killTimer
      // stays scheduled here and this fails even though no SIGKILL is
      // ever observed.
      expect(vi.getTimerCount()).toBe(0);

      // Advance well past the 5s escalation delay for good measure; no
      // SIGKILL should follow.
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockChild.kill).toHaveBeenCalledTimes(1);
      expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses SIGKILL once the child has exited even before close fires (M9)', async () => {
    vi.useFakeTimers();
    try {
      const mockChild = new MockChildProcess();
      spawnMock.mockReturnValue(mockChild);
      const cfg = makeCfg({ claudeTimeoutMs: 10 });

      const resultPromise = runClaude(cfg, { message: makeMessage(), agent });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(mockChild.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

      // The child has actually terminated - Node emits 'exit' as soon
      // as the process is gone - but 'close' has not fired yet (stdio
      // streams can still take a tick to drain). This isolates the
      // `exited === true` branch of the killTimer's `if (!exited)`
      // guard from the 'close'-driven cleanup path exercised by the
      // test above.
      mockChild.emit('exit', null);

      // MUTATION GUARD M9: make the `child.once('exit', ...)` listener
      // body a no-op -> `exited` never flips to true, the killTimer's
      // `if (!exited)` guard stays open, and SIGKILL fires here too,
      // failing the toHaveBeenCalledTimes(1) assertion below.
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockChild.kill).toHaveBeenCalledTimes(1);
      expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

      // Let 'close' fire so the run settles cleanly and the test
      // doesn't leak a pending Promise.
      mockChild.emit('close', null);
      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
