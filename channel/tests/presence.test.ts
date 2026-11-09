import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOOK_SECRET_BYTES, HOOK_SECRET_HEADER, MAX_HOOK_BODY_BYTES, discoveryFile, privateDir, secretMatches, startPresenceListener, statusForHook, writeDiscoveryFile,
} from '../src/presence.js';

describe('statusForHook', () => {
  it.each([
    ['SessionStart', 'online', null],
    ['UserPromptSubmit', 'working', null],
    ['PermissionRequest', 'waiting_approval', 'Bash'],
    ['PreToolUse', 'working', 'Bash'],
    ['Stop', 'online', null],
    ['StopFailure', 'error', 'Bash'],
    ['PostToolUseFailure', 'error', 'Bash'],
    // /clear and /resume end the Claude session while the server lives on; the gateway session stays.
    ['SessionEnd', 'online', null],
  ])('%s -> %s', (event, status, detail) => {
    expect(statusForHook({ hook_event_name: event, session_id: 'cs-1', tool_name: 'Bash' })).toEqual({ status, detail, claudeSessionId: 'cs-1' });
  });

  it('ignores events it does not map, and a session id the gateway would refuse', () => {
    expect(statusForHook({ hook_event_name: 'PreCompact' })).toBeNull();
    expect(statusForHook({})).toBeNull();
    expect(statusForHook({ hook_event_name: 'Stop', session_id: 'x'.repeat(129) })?.claudeSessionId).toBeNull();
  });
});

describe('secretMatches', () => {
  const secret = 'a'.repeat(64);
  it('accepts the secret only', () => {
    expect(secretMatches(secret, secret)).toBe(true);
    expect(secretMatches('b'.repeat(64), secret)).toBe(false);
    expect(secretMatches('a'.repeat(63), secret)).toBe(false);
    expect(secretMatches('a'.repeat(65), secret)).toBe(false);
    expect(secretMatches('', secret)).toBe(false);
    expect(secretMatches(undefined, secret)).toBe(false);
    expect(secretMatches([secret, secret], secret)).toBe(false);
  });
});

describe('writeDiscoveryFile', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('creates the directory and the file for the owner only, and leaves no temporary file', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-discovery-'));
    dirs.push(stateDir);
    const file = discoveryFile(stateDir, 7);
    const openSpy = vi.spyOn(fs, 'openSync');
    writeDiscoveryFile(file, '{"port":1}');
    // Created with 0600 in the call that creates it, exclusively: no window with a wider mode.
    expect(openSpy).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), 'wx', 0o600);
    openSpy.mockRestore();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['7.json']);
    // Writing again replaces it in one step.
    writeDiscoveryFile(file, '{"port":2}');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"port":2}');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['7.json']);
  });

  it('narrows an existing directory that the group or others may enter to 700, and returns the old mode', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-discovery-'));
    dirs.push(stateDir);
    const dir = path.join(stateDir, 'sessions');
    for (const wide of [0o755, 0o750, 0o705, 0o777]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, wide);
      expect(privateDir(dir)).toBe(wide);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
    // Already private: left as it is.
    expect(privateDir(dir)).toBeNull();
    fs.chmodSync(dir, 0o500);
    expect(privateDir(dir)).toBeNull();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o500);
    fs.chmodSync(dir, 0o700);
    // Windows has no such mode bits.
    fs.chmodSync(dir, 0o755);
    expect(privateDir(dir, 'win32')).toBeNull();
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });

  it('removes the temporary file when the rename fails', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-discovery-'));
    dirs.push(stateDir);
    const file = discoveryFile(stateDir, 8);
    fs.mkdirSync(file, { recursive: true });
    fs.writeFileSync(path.join(file, 'x'), 'a directory where the file should be');
    expect(() => writeDiscoveryFile(file, '{}')).toThrow();
    expect(fs.readdirSync(path.dirname(file))).toEqual(['8.json']);
  });
});

describe('startPresenceListener', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function post(port: number, body: string, headers: Record<string, string> = {}, urlPath = '/hook'): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  async function listen(claudePid = 4242) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-presence-'));
    dirs.push(stateDir);
    const onChange = vi.fn();
    const listener = await startPresenceListener({ stateDir, claudePid, onChange });
    const file = discoveryFile(stateDir, claudePid);
    const discovered = JSON.parse(fs.readFileSync(file, 'utf8')) as { port: number; secret: string; pid: number };
    return { stateDir, onChange, listener, file, discovered, auth: { [HOOK_SECRET_HEADER]: discovered.secret } };
  }

  it('writes the port and a fresh random secret into a discovery file only the owner can read', async () => {
    const a = await listen(4242);
    const b = await listen(4243);
    expect(a.discovered).toMatchObject({ port: a.listener.port, pid: process.pid });
    expect(a.discovered.secret).toMatch(new RegExp(`^[0-9a-f]{${HOOK_SECRET_BYTES * 2}}$`));
    expect(b.discovered.secret).not.toBe(a.discovered.secret);
    expect(fs.statSync(a.file).mode & 0o777).toBe(0o600);
    await a.listener.close();
    await b.listener.close();
    expect(fs.existsSync(a.file)).toBe(false);
  });

  it('takes a hook post with the right secret', async () => {
    const { listener, onChange, auth } = await listen();
    expect(await post(listener.port, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'cs-9' }), auth)).toEqual({ status: 204, body: '' });
    expect(onChange).toHaveBeenCalledWith({ status: 'working', detail: null, claudeSessionId: 'cs-9' });
    await listener.close();
  });

  it.each([
    ['missing', {}],
    ['wrong', { [HOOK_SECRET_HEADER]: 'f'.repeat(HOOK_SECRET_BYTES * 2) }],
    ['shorter', { [HOOK_SECRET_HEADER]: 'f'.repeat(10) }],
    ['longer', { [HOOK_SECRET_HEADER]: 'f'.repeat(HOOK_SECRET_BYTES * 2 + 1) }],
    ['empty', { [HOOK_SECRET_HEADER]: '' }],
  ])('refuses a post with a %s secret: 401, no body, nothing changes', async (_label, headers) => {
    const { listener, onChange } = await listen();
    expect(await post(listener.port, JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }), headers)).toEqual({ status: 401, body: '' });
    // Without the secret the path is not even looked at.
    expect(await post(listener.port, '{}', headers, '/elsewhere')).toEqual({ status: 401, body: '' });
    expect(onChange).not.toHaveBeenCalled();
    await listener.close();
  });

  it('refuses the secret of another listener', async () => {
    const a = await listen(1);
    const b = await listen(2);
    expect((await post(a.listener.port, JSON.stringify({ hook_event_name: 'Stop' }), b.auth)).status).toBe(401);
    expect(a.onChange).not.toHaveBeenCalled();
    await a.listener.close();
    await b.listener.close();
  });

  it('answers 400/404/413 for junk from an authenticated caller', async () => {
    const { listener, onChange, auth } = await listen();
    expect((await post(listener.port, '{bad', auth)).status).toBe(400);
    expect((await post(listener.port, '{}', auth, '/other')).status).toBe(404);
    expect((await post(listener.port, JSON.stringify({ hook_event_name: 'PreCompact' }), auth)).status).toBe(204);
    // A payload beyond the cap is answered, not dropped on the floor.
    expect((await post(listener.port, JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: 'x'.repeat(MAX_HOOK_BODY_BYTES + 1) }), auth)).status).toBe(413);
    // A large Write payload within the cap still counts.
    expect((await post(listener.port, JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: 'x'.repeat(200 * 1024) }), auth)).status).toBe(204);
    expect(onChange).toHaveBeenCalledTimes(1);
    await listener.close();
  });

  it('narrows a sessions directory open to others before writing the file there, and says so', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-presence-'));
    dirs.push(stateDir);
    const dir = path.join(stateDir, 'sessions');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o777);
    const log = vi.fn();
    const listener = await startPresenceListener({ stateDir, claudePid: 6, onChange: vi.fn(), log });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(log).toHaveBeenCalledWith('warn', `${dir} was open to other users (mode 777); narrowed it to 700`);
    expect(fs.existsSync(discoveryFile(stateDir, 6))).toBe(true);
    await listener.close();
  });

  it('writes no discovery file into a directory it cannot narrow', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-presence-'));
    dirs.push(stateDir);
    const dir = path.join(stateDir, 'sessions');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o777);
    // Someone else's directory: chmod is refused.
    const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation(() => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); });
    const log = vi.fn();
    const listener = await startPresenceListener({ stateDir, claudePid: 7, onChange: vi.fn(), log });
    chmod.mockRestore();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/the hooks cannot report presence: EPERM/));
    await listener.close();
  });

  it('keeps listening (and says so) when the discovery file cannot be written', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-presence-'));
    dirs.push(stateDir);
    fs.writeFileSync(path.join(stateDir, 'sessions'), 'a file where the directory should be');
    const log = vi.fn();
    const listener = await startPresenceListener({ stateDir, claudePid: 5, onChange: vi.fn(), log });
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('the hooks cannot report presence'));
    await listener.close();
  });
});
