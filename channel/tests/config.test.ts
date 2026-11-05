import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultStateDir, loadConfig, parseDotEnv } from '../src/config.js';

const dirs: string[] = [];
function tmpState(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'triologue-channel-'));
  dirs.push(d);
  return d;
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
    fs.writeFileSync(path.join(stateDir, '.env'), 'GATEWAY_URL=https://opentriologue.ai/gateway/\nBYOA_TOKEN=byoa_file\nALLOWED_SENDERS=User-Lan, lan\n');

    const c = loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, BYOA_TOKEN: 'byoa_env', CLAUDE_PROJECT_DIR: '/projects/evidence-api', ROOMS: 'room-1,room-1,room-2' });

    expect(c.gatewayUrl).toBe('https://opentriologue.ai/gateway');
    expect(c.triologueUrl).toBe('https://opentriologue.ai');
    expect(c.byoaToken).toBe('byoa_env');
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

  it('accepts TRIOLOGUE_BYOA_TOKEN, an explicit TRIOLOGUE_URL and bool/number overrides', () => {
    const stateDir = tmpState();
    const c = loadConfig({ CLAUDE_PLUGIN_DATA: stateDir, GATEWAY_URL: 'http://localhost:9500', TRIOLOGUE_BYOA_TOKEN: 'byoa_t', TRIOLOGUE_URL: 'http://localhost:4001/', ALLOW_AGENTS: 'yes', HEARTBEAT_SECONDS: '10', PRESENCE_PORT: '70000', LOG_LEVEL: 'debug' });
    expect(c.triologueUrl).toBe('http://localhost:4001');
    expect(c.byoaToken).toBe('byoa_t');
    expect(c.allowAgents).toBe(true);
    expect(c.heartbeatSeconds).toBe(10);
    expect(c.presencePort).toBe(0);
    expect(c.logLevel).toBe('debug');
  });

  it('defaults the state dir to ~/.claude/channels/triologue outside a plugin', () => {
    expect(defaultStateDir({})).toBe(path.join(os.homedir(), '.claude', 'channels', 'triologue'));
    expect(defaultStateDir({ CLAUDE_PLUGIN_DATA: '/data' })).toBe('/data');
  });
});
