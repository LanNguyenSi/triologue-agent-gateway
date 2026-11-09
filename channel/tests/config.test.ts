import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_CLAUDE_SESSION_ID, claudeSessionIdFrom, defaultStateDir, loadConfig, parseDotEnv, readEnvFile } from '../src/config.js';

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
    expect(() => loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, GATEWAY_URL: 'https://x/gateway' })).toThrow(/BYOA_TOKEN is required/);
  });

  it('merges the state dir .env under the environment and derives the defaults', () => {
    const stateDir = tmpState();
    writeEnv(stateDir, 'GATEWAY_URL=https://opentriologue.ai/gateway/\nBYOA_TOKEN=byoa_file\nALLOWED_SENDERS=User-Lan, lan\n');

    const c = loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_PROJECT_DIR: '/projects/evidence-api', TRIOLOGUE_ROOMS: 'room-1,room-1,room-2' });

    expect(c.gatewayUrl).toBe('https://opentriologue.ai/gateway');
    expect(c.triologueUrl).toBe('https://opentriologue.ai');
    expect(c.byoaToken).toBe('byoa_file');
    expect(c.warnings).toEqual([]);
    expect(c.claudeSessionId).toBeNull();
    expect([...c.allowedSenders]).toEqual(['user-lan', 'lan']);
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
    const env = { CLAUDE_PLUGIN_DATA: stateDir, GATEWAY_URL: 'http://localhost:9500', BYOA_TOKEN: 'byoa_env', TRIOLOGUE_BYOA_TOKEN: 'byoa_env2' };
    expect(() => loadConfig(env)).toThrow(/BYOA_TOKEN is required; put it in .*\.env with mode 600/);
    writeEnv(stateDir, 'BYOA_TOKEN=byoa_file\n');
    const c = loadConfig(env);
    expect(c.byoaToken).toBe('byoa_file');
    expect(c.warnings).toEqual([`BYOA_TOKEN and TRIOLOGUE_BYOA_TOKEN in the environment ignored: the token is read only from ${path.join(stateDir, '.env')}`]);
    expect(c.warnings.join(' ')).not.toContain('byoa_env');
    // TRIOLOGUE_BYOA_TOKEN in the file wins over BYOA_TOKEN in the file.
    writeEnv(stateDir, 'BYOA_TOKEN=byoa_file\nTRIOLOGUE_BYOA_TOKEN=byoa_prefixed\n');
    expect(loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, GATEWAY_URL: 'http://x' }).byoaToken).toBe('byoa_prefixed');
  });

  it.each(['644', '640', '604', '660', '606', '620', '602'])('refuses a .env the group or others may access (mode %s)', (octal) => {
    const mode = parseInt(octal, 8);
    const stateDir = tmpState();
    const file = writeEnv(stateDir, 'GATEWAY_URL=http://x\nBYOA_TOKEN=byoa_file\n', mode);
    expect(() => loadConfig({ CLAUDE_PLUGIN_DATA: stateDir })).toThrow(`${file} holds the token and is open to other users (mode ${mode.toString(8)}); run: chmod 600 "${file}"`);
  });

  it('accepts a .env for the owner only (600, 400), and skips the mode check on Windows', () => {
    const stateDir = tmpState();
    writeEnv(stateDir, 'GATEWAY_URL=http://x\nBYOA_TOKEN=byoa_file\n', 0o400);
    expect(loadConfig({ CLAUDE_PLUGIN_DATA: stateDir }).byoaToken).toBe('byoa_file');
    writeEnv(stateDir, 'GATEWAY_URL=http://x\nBYOA_TOKEN=byoa_file\n', 0o644);
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
    writeEnv(stateDir, 'GATEWAY_URL=http://x\nBYOA_TOKEN=byoa_file\n');
    expect(loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_CODE_SESSION_ID: ' cs-start ' }).claudeSessionId).toBe('cs-start');
    expect(loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, CLAUDE_CODE_SESSION_ID: 'x'.repeat(MAX_CLAUDE_SESSION_ID + 1) }).claudeSessionId).toBeNull();
    expect(claudeSessionIdFrom('x'.repeat(MAX_CLAUDE_SESSION_ID))).toHaveLength(MAX_CLAUDE_SESSION_ID);
    expect(claudeSessionIdFrom('  ')).toBeNull();
    expect(claudeSessionIdFrom(42)).toBeNull();
  });

  it('accepts an explicit TRIOLOGUE_URL and bool/number overrides', () => {
    const stateDir = tmpState();
    writeEnv(stateDir, 'BYOA_TOKEN=byoa_t\n');
    const c = loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, GATEWAY_URL: 'http://localhost:9500', TRIOLOGUE_URL: 'http://localhost:4001/', ALLOW_AGENTS: 'yes', HEARTBEAT_SECONDS: '10', PRESENCE_PORT: '70000', TRIOLOGUE_LOG_LEVEL: 'debug' });
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
