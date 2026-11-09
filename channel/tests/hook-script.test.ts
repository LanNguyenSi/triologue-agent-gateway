/**
 * The hook script as Claude Code runs it: `sh presence-hook.sh` with the hook
 * payload on stdin, its parent being the process whose pid names the
 * discovery file (here: this test process). Needs `sh`, `curl`, `find` and
 * `id`; shims first on PATH record curl's argv and report another user id.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoveryFile, startPresenceListener } from '../src/presence.js';

const script = path.resolve(__dirname, '..', 'scripts', 'presence-hook.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function runHook(stateDir: string, payload: unknown, env: NodeJS.ProcessEnv = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [script], { env: { ...process.env, CLAUDE_PLUGIN_DATA: stateDir, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hook script did not finish')); }, 10_000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? -1); });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A directory with executable shell scripts, to put first on PATH. */
function shims(scripts: Record<string, string>): string {
  const bin = tmp('triologue-hook-bin-');
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

const realCurl = execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim();

/** A pid that is neither the hook's parent (this process) nor its grandparent. */
const strangerPid = [process.pid + 1, process.pid + 2].find((p) => p !== process.ppid)!;

describe('presence-hook.sh', () => {
  it('posts the payload with the secret from the discovery file', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-hook-'));
    dirs.push(stateDir);
    const onChange = vi.fn();
    const listener = await startPresenceListener({ stateDir, claudePid: process.pid, onChange });
    expect(await runHook(stateDir, { hook_event_name: 'PermissionRequest', session_id: 'cs-hook', tool_name: 'Bash' })).toBe(0);
    await waitFor(() => onChange.mock.calls.length > 0);
    expect(onChange).toHaveBeenCalledWith({ status: 'waiting_approval', detail: 'Bash', claudeSessionId: 'cs-hook' });
    await listener.close();
  });

  it('is refused with a stale secret and still exits 0', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-hook-'));
    dirs.push(stateDir);
    const onChange = vi.fn();
    const listener = await startPresenceListener({ stateDir, claudePid: process.pid, onChange });
    const file = discoveryFile(stateDir, process.pid);
    const discovered = JSON.parse(fs.readFileSync(file, 'utf8')) as { port: number; secret: string };
    fs.writeFileSync(file, JSON.stringify({ ...discovered, secret: 'ab'.repeat(32) }));
    expect(await runHook(stateDir, { hook_event_name: 'Stop' })).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(onChange).not.toHaveBeenCalled();
    await listener.close();
  });

  it('keeps the secret out of curl\'s argv, and the post still gets through', async () => {
    const stateDir = tmp('triologue-hook-');
    const argvLog = path.join(tmp('triologue-hook-argv-'), 'argv');
    const bin = shims({ curl: `printf '%s\\n' "$@" >> '${argvLog}'\nexec '${realCurl}' "$@"` });
    const onChange = vi.fn();
    const listener = await startPresenceListener({ stateDir, claudePid: process.pid, onChange });
    const { secret } = JSON.parse(fs.readFileSync(discoveryFile(stateDir, process.pid), 'utf8')) as { secret: string };
    expect(await runHook(stateDir, { hook_event_name: 'Stop', session_id: 'cs-argv' }, { PATH: `${bin}:${process.env.PATH ?? ''}` })).toBe(0);
    await waitFor(() => onChange.mock.calls.length > 0);
    expect(onChange).toHaveBeenCalledWith({ status: 'online', detail: null, claudeSessionId: 'cs-argv' });
    // The shim ran: curl was called through it, with the listener's URL.
    const argv = fs.readFileSync(argvLog, 'utf8');
    expect(argv).toContain(`http://127.0.0.1:${listener.port}/hook`);
    expect(argv).not.toContain(secret);
    await listener.close();
  });

  it('uses only the discovery file of its own Claude Code, even when it is the only one', async () => {
    const stateDir = tmp('triologue-hook-');
    const onChange = vi.fn();
    // Another session's server: its file is named after another Claude Code pid.
    const listener = await startPresenceListener({ stateDir, claudePid: strangerPid, onChange });
    expect(fs.readdirSync(path.join(stateDir, 'sessions'))).toEqual([`${strangerPid}.json`]);
    expect(await runHook(stateDir, { hook_event_name: 'PermissionRequest', session_id: 'cs-other', tool_name: 'Bash' })).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(onChange).not.toHaveBeenCalled();
    await listener.close();
  });

  it('skips a discovery file that is not a regular file of this user', async () => {
    const stateDir = tmp('triologue-hook-');
    const onChange = vi.fn();
    const listener = await startPresenceListener({ stateDir, claudePid: process.pid, onChange });
    const file = discoveryFile(stateDir, process.pid);

    // Owned by someone else: an id that reports another user stands in for one.
    const otherUser = shims({ id: `echo ${(process.getuid?.() ?? 0) + 1}` });
    expect(await runHook(stateDir, { hook_event_name: 'Stop' }, { PATH: `${otherUser}:${process.env.PATH ?? ''}` })).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(onChange).not.toHaveBeenCalled();

    // A link to a file with a valid port and secret.
    const elsewhere = path.join(tmp('triologue-hook-elsewhere-'), 'discovery.json');
    fs.renameSync(file, elsewhere);
    fs.symlinkSync(elsewhere, file);
    expect(await runHook(stateDir, { hook_event_name: 'Stop' })).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(onChange).not.toHaveBeenCalled();

    // The same content as a regular file of this user is taken.
    fs.rmSync(file);
    fs.copyFileSync(elsewhere, file);
    expect(await runHook(stateDir, { hook_event_name: 'Stop' })).toBe(0);
    await waitFor(() => onChange.mock.calls.length > 0);
    expect(onChange).toHaveBeenCalledTimes(1);
    await listener.close();
  });

  it('does nothing without a discovery file, or without a secret in it', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-hook-'));
    dirs.push(stateDir);
    expect(await runHook(stateDir, { hook_event_name: 'Stop' })).toBe(0);
    const onChange = vi.fn();
    const listener = await startPresenceListener({ stateDir, claudePid: process.pid, onChange });
    const file = discoveryFile(stateDir, process.pid);
    fs.writeFileSync(file, JSON.stringify({ port: listener.port }));
    expect(await runHook(stateDir, { hook_event_name: 'Stop' })).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(onChange).not.toHaveBeenCalled();
    await listener.close();
  });
});
