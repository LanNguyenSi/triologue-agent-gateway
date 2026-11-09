import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FILE_FIRST, MAX_CLAUDE_SESSION_ID, claudeSessionIdFrom, defaultStateDir, loadConfig, parseDotEnv, readEnvFile, requireSecureUrl, type ChannelConfig } from '../src/config.js';

const dirs: string[] = [];
function tmpState(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-channel-'));
  dirs.push(d);
  return d;
}
/** The state dir's .env as /triologue:configure writes it: mode 600. */
function writeEnv(stateDir: string, text: string, mode = 0o600): string {
  const file = path.join(stateDir, '.env');
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
  return file;
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('parseDotEnv', () => {
  it('reads KEY=value lines, strips quotes, ignores comments and junk', () => {
    expect(parseDotEnv('# c\nA=1\nB="two words"\nC=\'x\'\nnot a line\n=nokey\n1BAD=x\n')).toEqual({ A: '1', B: 'two words', C: 'x' });
  });
});

describe('loadConfig', () => {
  it('requires GATEWAY_URL and a token', () => {
    const stateDir = tmpState();
    expect(() => loadConfig({ CLAUDE_PLUGIN_DATA: stateDir })).toThrow(/GATEWAY_URL is required/);
    expect(() => loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, TRIOLOGUE_GATEWAY_URL: 'https://x/gateway' })).toThrow(/BYOA_TOKEN is required/);
  });

  it('merges the state dir .env under the environment and derives the defaults', () => {
    const stateDir = tmpState();
    writeEnv(stateDir, 'GATEWAY_URL=https://opentriologue.ai/gateway/\nBYOA_TOKEN=byoa_file\nALLOWED_SENDERS=User-Lan, user:Lan\n');

    const c = loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PROJECT_DIR: '/projects/evidence-api', TRIOLOGUE_ROOMS: 'room-1,room-1,room-2' });

    expect(c.gatewayUrl).toBe('https://opentriologue.ai/gateway');
    expect(c.triologueUrl).toBe('https://opentriologue.ai');
    expect(c.byoaToken).toBe('byoa_file');
    expect(c.warnings).toEqual([]);
    expect(c.claudeSessionId).toBeNull();
    expect([...c.allowedSenders.ids]).toEqual(['user-lan']);
    expect([...c.allowedSenders.usernames]).toEqual(['lan']);
    expect(c.allowAgents).toBe(false);
    expect(c.rooms).toEqual(['room-1', 'room-2']);
    expect(c.runtime).toBe('claude');
    expect(c.cwd).toBe('/projects/evidence-api');
    expect(c.project).toBe('evidence-api');
    expect(c.stateDir).toBe(stateDir);
    expect(c.heartbeatSeconds).toBe(30);
    expect(c.presencePort).toBe(0);
  });

  it('reads the token from the file only: one in the environment is ignored and reported, never used', () => {
    const stateDir = tmpState();
    const env = { CLAUDE_PLUGIN_DATA: stateDir, TRIOLOGUE_GATEWAY_URL: 'http://localhost:9500', BYOA_TOKEN: 'byoa_env', TRIOLOGUE_BYOA_TOKEN: 'byoa_env2' };
    expect(() => loadConfig(env)).toThrow(/BYOA_TOKEN is required; put it in .*\.env with mode 600/);
    writeEnv(stateDir, 'BYOA_TOKEN=byoa_file\n');
    const c = loadConfig(env);
    expect(c.byoaToken).toBe('byoa_file');
    expect(c.warnings).toEqual([`BYOA_TOKEN and TRIOLOGUE_BYOA_TOKEN in the environment ignored: the token is read only from ${path.join(stateDir, '.env')}`]);
    expect(c.warnings.join(' ')).not.toContain('byoa_env');
    // TRIOLOGUE_BYOA_TOKEN in the file wins over BYOA_TOKEN in the file.
    writeEnv(stateDir, 'BYOA_TOKEN=byoa_file\nTRIOLOGUE_BYOA_TOKEN=byoa_prefixed\n');
    expect(loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, TRIOLOGUE_GATEWAY_URL: 'https://x' }).byoaToken).toBe('byoa_prefixed');
  });

  it.each(['644', '640', '604', '660', '606', '620', '602'])('refuses a .env the group or others may access (mode %s)', (octal) => {
    const mode = parseInt(octal, 8);
    const stateDir = tmpState();
    const file = writeEnv(stateDir, 'GATEWAY_URL=http://x\nBYOA_TOKEN=byoa_file\n', mode);
    expect(() => loadConfig({ CLAUDE_PLUGIN_DATA: stateDir })).toThrow(`${file} holds the token and is open to other users (mode ${mode.toString(8)}); run: chmod 600 "${file}"`);
  });

  it('accepts a .env for the owner only (600, 400), and skips the mode check on Windows', () => {
    const stateDir = tmpState();
    writeEnv(stateDir, 'GATEWAY_URL=https://x\nBYOA_TOKEN=byoa_file\n', 0o400);
    expect(loadConfig({ CLAUDE_PLUGIN_DATA: stateDir }).byoaToken).toBe('byoa_file');
    writeEnv(stateDir, 'GATEWAY_URL=https://x\nBYOA_TOKEN=byoa_file\n', 0o644);
    expect(loadConfig({ CLAUDE_PLUGIN_DATA: stateDir }, 'win32').byoaToken).toBe('byoa_file');
  });

  it('readEnvFile: no file is an empty config, an unreadable one is an error', () => {
    const stateDir = tmpState();
    expect(readEnvFile(path.join(stateDir, '.env'))).toEqual({});
    fs.writeFileSync(path.join(stateDir, 'locked.env'), 'A=1', { mode: 0o000 });
    if (process.getuid?.() !== 0) expect(() => readEnvFile(path.join(stateDir, 'locked.env'))).toThrow(/cannot read/);
  });

  it('takes Claude Code\'s session id from CLAUDE_CODE_SESSION_ID at start, within the gateway\'s limit', () => {
    const stateDir = tmpState();
    writeEnv(stateDir, 'GATEWAY_URL=https://x\nBYOA_TOKEN=byoa_file\n');
    expect(loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_CODE_SESSION_ID: ' cs-start ' }).claudeSessionId).toBe('cs-start');
    expect(loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_CODE_SESSION_ID: 'x'.repeat(MAX_CLAUDE_SESSION_ID + 1) }).claudeSessionId).toBeNull();
    expect(claudeSessionIdFrom('x'.repeat(MAX_CLAUDE_SESSION_ID))).toHaveLength(MAX_CLAUDE_SESSION_ID);
    expect(claudeSessionIdFrom('  ')).toBeNull();
    expect(claudeSessionIdFrom(42)).toBeNull();
  });

  it('accepts an explicit TRIOLOGUE_URL and bool/number overrides', () => {
    const stateDir = tmpState();
    writeEnv(stateDir, 'BYOA_TOKEN=byoa_t\n');
    const c = loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, TRIOLOGUE_GATEWAY_URL: 'http://localhost:9500', TRIOLOGUE_URL: 'http://localhost:4001/', TRIOLOGUE_ALLOW_AGENTS: 'yes', HEARTBEAT_SECONDS: '10', PRESENCE_PORT: '70000', TRIOLOGUE_LOG_LEVEL: 'debug' });
    expect(c.triologueUrl).toBe('http://localhost:4001');
    expect(c.byoaToken).toBe('byoa_t');
    expect(c.allowAgents).toBe(true);
    expect(c.heartbeatSeconds).toBe(10);
    expect(c.presencePort).toBe(0);
    expect(c.logLevel).toBe('debug');
  });

  it('reads HOST, PROJECT, ROOMS, RUNTIME and LOG_LEVEL from the environment only with the TRIOLOGUE_ prefix, from the file plainly', () => {
    const stateDir = tmpState();
    writeEnv(stateDir, 'GATEWAY_URL=https://x/gateway\nBYOA_TOKEN=byoa_file\nHOST=mac-mini\nROOMS=room-9\nLOG_LEVEL=warn\n');
    const shell = { CLAUDE_PLUGIN_DATA: stateDir, HOST: '0.0.0.0', PROJECT: 'something-else', ROOMS: 'room-1', LOG_LEVEL: 'debug', CLAUDE_PROJECT_DIR: '/projects/evidence-api' };
    const c = loadConfig(shell);
    expect(c.host).toBe('mac-mini');
    expect(c.project).toBe('evidence-api');
    expect(c.rooms).toEqual(['room-9']);
    expect(c.logLevel).toBe('warn');
    const prefixed = loadConfig({ ...shell, TRIOLOGUE_HOST: 'laptop', TRIOLOGUE_PROJECT: 'evidence', TRIOLOGUE_ROOMS: 'room-2', TRIOLOGUE_RUNTIME: 'claude-dev' });
    expect(prefixed.host).toBe('laptop');
    expect(prefixed.project).toBe('evidence');
    expect(prefixed.rooms).toEqual(['room-2']);
    expect(prefixed.runtime).toBe('claude-dev');
  });

  it('defaults the state dir to ~/.claude/channels/triologue outside a plugin', () => {
    expect(defaultStateDir({})).toBe(path.join(os.homedir(), '.claude', 'channels', 'triologue'));
    expect(defaultStateDir({ CLAUDE_PLUGIN_DATA: '/data' })).toBe('/data');
  });
});

/**
 * The keys that decide where the token goes and who may command the session.
 * Winner, highest first: TRIOLOGUE_<KEY> in the file, <KEY> in the file,
 * TRIOLOGUE_<KEY> in the environment. A plain <KEY> in the environment is
 * never read (warning). An empty value counts as absent everywhere.
 */
describe('the keys the file decides', () => {
  interface Case { key: string; a: string; b: string; resultA: unknown; resultB: unknown; absent: unknown; read: (c: ChannelConfig) => unknown }
  const cases: Case[] = [
    { key: 'GATEWAY_URL', a: 'https://a.example/gateway', b: 'https://b.example/gateway', resultA: 'https://a.example/gateway', resultB: 'https://b.example/gateway', absent: 'required', read: (c) => c.gatewayUrl },
    { key: 'TRIOLOGUE_URL', a: 'https://a.example', b: 'https://b.example', resultA: 'https://a.example', resultB: 'https://b.example', absent: 'https://base.example', read: (c) => c.triologueUrl },
    { key: 'ALLOWED_SENDERS', a: 'id-a', b: 'id-b', resultA: ['id-a'], resultB: ['id-b'], absent: [], read: (c) => [...c.allowedSenders.ids] },
    { key: 'ALLOW_AGENTS', a: 'yes', b: 'no', resultA: true, resultB: false, absent: false, read: (c) => c.allowAgents },
  ];
  const plainCases = cases.filter((c) => !c.key.startsWith('TRIOLOGUE_'));

  /** Load with `<key>=<fileValue>` in the file (unless undefined) and the given environment. */
  function load(key: string, fileValue: string | undefined, env: Record<string, string>): ChannelConfig {
    const stateDir = tmpState();
    let text = 'BYOA_TOKEN=byoa_file\n';
    if (key !== 'GATEWAY_URL') text += 'GATEWAY_URL=https://base.example/gateway\n';
    if (fileValue !== undefined) text += `${key}=${fileValue}\n`;
    writeEnv(stateDir, text);
    return loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, ...env });
  }
  function expectAbsent(c: Case, run: () => ChannelConfig): void {
    if (c.absent === 'required') expect(run).toThrow(/GATEWAY_URL is required/);
    else expect(c.read(run())).toEqual(c.absent);
  }
  const prefixed = (key: string) => (key.startsWith('TRIOLOGUE_') ? key : `TRIOLOGUE_${key}`);

  it('covers exactly these keys', () => {
    expect([...FILE_FIRST].sort()).toEqual(cases.map((c) => c.key).sort());
  });

  it.each(cases)('$key: from the file alone', (c) => {
    const config = load(c.key, c.a, {});
    expect(c.read(config)).toEqual(c.resultA);
    expect(config.warnings).toEqual([]);
  });

  it.each(cases)('$key: from TRIOLOGUE_<KEY> in the environment when the file lacks it', (c) => {
    const config = load(c.key, undefined, { [prefixed(c.key)]: c.a });
    expect(c.read(config)).toEqual(c.resultA);
    expect(config.warnings).toEqual([]);
  });

  it.each(cases)('$key: the file wins over TRIOLOGUE_<KEY> in the environment', (c) => {
    expect(c.read(load(c.key, c.a, { [prefixed(c.key)]: c.b }))).toEqual(c.resultA);
    expect(c.read(load(c.key, c.b, { [prefixed(c.key)]: c.a }))).toEqual(c.resultB);
  });

  it.each(plainCases)('$key: TRIOLOGUE_<KEY> in the file wins over <KEY> in the file', (c) => {
    const stateDir = tmpState();
    const base = c.key === 'GATEWAY_URL' ? '' : 'GATEWAY_URL=https://base.example/gateway\n';
    writeEnv(stateDir, `BYOA_TOKEN=byoa_file\n${base}${c.key}=${c.b}\n${prefixed(c.key)}=${c.a}\n`);
    expect(c.read(loadConfig({ CLAUDE_PLUGIN_DATA: stateDir }))).toEqual(c.resultA);
  });

  it.each(plainCases)('$key: a plain <KEY> in the environment is ignored, with a warning that names it but not its value', (c) => {
    const config = load(c.key, c.a, { [c.key]: c.b });
    expect(c.read(config)).toEqual(c.resultA);
    // The exact text: the variable's name, never its value.
    expect(config.warnings).toEqual([`${c.key} in the environment ignored: set it in ${path.join(config.stateDir, '.env')} or as TRIOLOGUE_${c.key}`]);
    // Alone it does not count either.
    expectAbsent(c, () => load(c.key, undefined, { [c.key]: c.a }));
  });

  it.each(cases)('$key: an empty value counts as absent, in the file and in the environment', (c) => {
    expect(c.read(load(c.key, '', { [prefixed(c.key)]: c.a }))).toEqual(c.resultA);
    expect(c.read(load(c.key, c.a, { [prefixed(c.key)]: '' }))).toEqual(c.resultA);
    expectAbsent(c, () => load(c.key, '', { [prefixed(c.key)]: '' }));
    // An empty plain variable is not reported.
    if (c.key !== prefixed(c.key)) expect(load(c.key, c.a, { [c.key]: '' }).warnings).toEqual([]);
  });

  it('reports every plain variable it ignored, each once', () => {
    const config = load('ALLOW_AGENTS', 'yes', { GATEWAY_URL: 'https://shell.example/gateway', ALLOWED_SENDERS: 'someone', ALLOW_AGENTS: 'no' });
    expect(config.warnings.map((w) => w.split(' ')[0])).toEqual(['GATEWAY_URL', 'ALLOWED_SENDERS', 'ALLOW_AGENTS']);
    expect(config.gatewayUrl).toBe('https://base.example/gateway');
  });
});

describe('URLs the token is sent to', () => {
  it.each([
    'https://opentriologue.ai/gateway',
    'http://localhost:9500',
    'http://LOCALHOST:9500/gateway',
    'http://127.0.0.1:9500',
    'http://[::1]:9500',
  ])('accepts %s', (url) => {
    expect(() => requireSecureUrl('GATEWAY_URL', url)).not.toThrow();
  });

  it.each([
    'http://opentriologue.ai/gateway',
    'http://192.168.1.5:9500',
    'http://localhost.example.com:9500',
    'http://127.0.0.2:9500',
    'ws://localhost:9500',
    'ftp://opentriologue.ai',
  ])('refuses %s, without echoing it', (url) => {
    expect(() => requireSecureUrl('GATEWAY_URL', url)).toThrow('GATEWAY_URL must be an https URL (plain http only to localhost, 127.0.0.1 or ::1): the token is sent there');
  });

  it('refuses something that is not a URL', () => {
    expect(() => requireSecureUrl('GATEWAY_URL', 'opentriologue.ai/gateway')).toThrow('GATEWAY_URL is not a valid URL');
  });

  it('loadConfig refuses a plain-http GATEWAY_URL or TRIOLOGUE_URL to another host', () => {
    const stateDir = tmpState();
    writeEnv(stateDir, 'BYOA_TOKEN=byoa_file\nGATEWAY_URL=http://opentriologue.ai/gateway\n');
    expect(() => loadConfig({ CLAUDE_PLUGIN_DATA: stateDir })).toThrow(/^GATEWAY_URL must be an https URL/);
    writeEnv(stateDir, 'BYOA_TOKEN=byoa_file\nGATEWAY_URL=https://opentriologue.ai/gateway\nTRIOLOGUE_URL=http://opentriologue.ai\n');
    expect(() => loadConfig({ CLAUDE_PLUGIN_DATA: stateDir })).toThrow(/^TRIOLOGUE_URL must be an https URL/);
    writeEnv(stateDir, 'BYOA_TOKEN=byoa_file\nGATEWAY_URL=http://127.0.0.1:9500/gateway\n');
    expect(loadConfig({ CLAUDE_PLUGIN_DATA: stateDir }).triologueUrl).toBe('http://127.0.0.1:9500');
  });
});
