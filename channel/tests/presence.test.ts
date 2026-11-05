import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoveryFile, startPresenceListener, statusForHook } from '../src/presence.js';

describe('statusForHook', () => {
  it.each([
    ['SessionStart', 'online', null],
    ['UserPromptSubmit', 'working', null],
    ['PermissionRequest', 'waiting_approval', 'Bash'],
    ['PreToolUse', 'working', 'Bash'],
    ['Stop', 'online', null],
    ['StopFailure', 'error', 'Bash'],
    ['PostToolUseFailure', 'error', 'Bash'],
    ['SessionEnd', 'offline', null],
  ])('%s -> %s', (event, status, detail) => {
    expect(statusForHook({ hook_event_name: event, session_id: 'cs-1', tool_name: 'Bash' })).toEqual({ status, detail, claudeSessionId: 'cs-1' });
  });

  it('ignores events it does not map', () => {
    expect(statusForHook({ hook_event_name: 'PreCompact' })).toBeNull();
    expect(statusForHook({})).toBeNull();
  });
});

describe('startPresenceListener', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function post(port: number, body: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  it('writes the discovery file, maps posted hooks and answers 400/404 for junk', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-presence-'));
    dirs.push(stateDir);
    const onChange = vi.fn();
    const listener = await startPresenceListener({ stateDir, claudePid: 4242, onChange });

    const file = discoveryFile(stateDir, 4242);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ port: listener.port, pid: process.pid });

    expect(await post(listener.port, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'cs-9' }))).toBe(204);
    expect(onChange).toHaveBeenCalledWith({ status: 'working', detail: null, claudeSessionId: 'cs-9' });
    expect(await post(listener.port, '{bad')).toBe(400);
    expect(await post(listener.port, JSON.stringify({ hook_event_name: 'PreCompact' }))).toBe(204);
    expect(onChange).toHaveBeenCalledTimes(1);

    await listener.close();
    expect(fs.existsSync(file)).toBe(false);
  });
});
