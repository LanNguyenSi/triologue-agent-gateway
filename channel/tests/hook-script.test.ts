/**
 * The hook script as Claude Code runs it: `sh presence-hook.sh` with the hook
 * payload on stdin, its parent being the process whose pid names the
 * discovery file (here: this test process). Needs `sh` and `curl`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoveryFile, startPresenceListener } from '../src/presence.js';

const script = path.resolve(__dirname, '..', 'scripts', 'presence-hook.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function runHook(stateDir: string, payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [script], { env: { ...process.env, CLAUDE_PLUGIN_DATA: stateDir }, stdio: ['pipe', 'ignore', 'ignore'] });
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
