/**
 * Tests for bridge/src/config.ts - env var validation + parsing.
 *
 * loadConfig() reads directly from process.env, so each test snapshots
 * and restores the relevant keys to avoid bleeding state between tests.
 *
 * Mutation guards (marked inline):
 *   M1: required() stops throwing on missing/empty env var
 *   M2: parseRoomAllowlist stops filtering blank entries
 *   M3: CLAUDE_TIMEOUT_MS validation (`<= 0` / non-finite) removed
 *   M4: parseLogLevel stops falling back to 'info' for unknown values
 *   M5: gatewayUrl trailing-slash strip removed
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const ENV_KEYS = [
  'GATEWAY_URL',
  'BYOA_TOKEN',
  'CLAUDE_CMD',
  'ROOM_ALLOWLIST',
  'CLAUDE_TIMEOUT_MS',
  'LOG_LEVEL',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function setRequired(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): void {
  process.env.GATEWAY_URL = overrides.GATEWAY_URL ?? 'https://gateway.test';
  process.env.BYOA_TOKEN = overrides.BYOA_TOKEN ?? 'byoa_test_token';
  for (const [k, v] of Object.entries(overrides)) {
    if (k === 'GATEWAY_URL' || k === 'BYOA_TOKEN') continue;
    (process.env as Record<string, string>)[k] = v as string;
  }
}

describe('loadConfig - required env vars', () => {
  it('throws when GATEWAY_URL is missing', () => {
    process.env.BYOA_TOKEN = 'byoa_test_token';
    // MUTATION GUARD M1: if `required()` stops throwing, this test fails.
    expect(() => loadConfig()).toThrow(/Missing required env var: GATEWAY_URL/);
  });

  it('throws when BYOA_TOKEN is missing', () => {
    process.env.GATEWAY_URL = 'https://gateway.test';
    expect(() => loadConfig()).toThrow(/Missing required env var: BYOA_TOKEN/);
  });

  it('throws when a required env var is set but empty', () => {
    process.env.GATEWAY_URL = 'https://gateway.test';
    process.env.BYOA_TOKEN = '';
    expect(() => loadConfig()).toThrow(/Missing required env var: BYOA_TOKEN/);
  });

  it('succeeds and returns the values once both required vars are set', () => {
    setRequired();
    const cfg = loadConfig();
    expect(cfg.gatewayUrl).toBe('https://gateway.test');
    expect(cfg.byoaToken).toBe('byoa_test_token');
  });
});

describe('loadConfig - gatewayUrl trailing slash (M5)', () => {
  it('strips a single trailing slash from GATEWAY_URL', () => {
    setRequired({ GATEWAY_URL: 'https://gateway.test/' });
    // MUTATION GUARD M5: remove `.replace(/\/$/, '')` → keeps the slash; fails
    expect(loadConfig().gatewayUrl).toBe('https://gateway.test');
  });

  it('leaves a URL without a trailing slash unchanged', () => {
    setRequired({ GATEWAY_URL: 'https://gateway.test' });
    expect(loadConfig().gatewayUrl).toBe('https://gateway.test');
  });
});

describe('loadConfig - optional defaults', () => {
  it('defaults claudeCmd to "claude" when CLAUDE_CMD is unset', () => {
    setRequired();
    expect(loadConfig().claudeCmd).toBe('claude');
  });

  it('uses CLAUDE_CMD when set to a non-empty value', () => {
    setRequired({ CLAUDE_CMD: '/usr/local/bin/claude' });
    expect(loadConfig().claudeCmd).toBe('/usr/local/bin/claude');
  });

  it('falls back to the default when CLAUDE_CMD is set but empty', () => {
    setRequired({ CLAUDE_CMD: '' });
    expect(loadConfig().claudeCmd).toBe('claude');
  });

  it('defaults claudeTimeoutMs to 120000 when unset', () => {
    setRequired();
    expect(loadConfig().claudeTimeoutMs).toBe(120_000);
  });

  it('uses a custom CLAUDE_TIMEOUT_MS when provided', () => {
    setRequired({ CLAUDE_TIMEOUT_MS: '5000' });
    expect(loadConfig().claudeTimeoutMs).toBe(5000);
  });
});

describe('loadConfig - CLAUDE_TIMEOUT_MS validation (M3)', () => {
  it('throws for a non-numeric CLAUDE_TIMEOUT_MS', () => {
    setRequired({ CLAUDE_TIMEOUT_MS: 'not-a-number' });
    // MUTATION GUARD M3: remove the `!Number.isFinite` check → NaN passes; fails
    expect(() => loadConfig()).toThrow(/CLAUDE_TIMEOUT_MS must be a positive integer/);
  });

  it('throws for a zero CLAUDE_TIMEOUT_MS', () => {
    setRequired({ CLAUDE_TIMEOUT_MS: '0' });
    // MUTATION GUARD M3: remove the `<= 0` check → 0 passes; fails
    expect(() => loadConfig()).toThrow(/CLAUDE_TIMEOUT_MS must be a positive integer/);
  });

  it('throws for a negative CLAUDE_TIMEOUT_MS', () => {
    setRequired({ CLAUDE_TIMEOUT_MS: '-100' });
    expect(() => loadConfig()).toThrow(/CLAUDE_TIMEOUT_MS must be a positive integer/);
  });
});

describe('loadConfig - parseRoomAllowlist (M2)', () => {
  it('returns null when ROOM_ALLOWLIST is unset', () => {
    setRequired();
    expect(loadConfig().roomAllowlist).toBeNull();
  });

  it('returns null when ROOM_ALLOWLIST is an empty string', () => {
    setRequired({ ROOM_ALLOWLIST: '' });
    expect(loadConfig().roomAllowlist).toBeNull();
  });

  it('parses a comma-separated list into a Set', () => {
    setRequired({ ROOM_ALLOWLIST: 'room-1,room-2,room-3' });
    expect(loadConfig().roomAllowlist).toEqual(new Set(['room-1', 'room-2', 'room-3']));
  });

  it('trims whitespace around each room id', () => {
    setRequired({ ROOM_ALLOWLIST: ' room-1 , room-2 ' });
    expect(loadConfig().roomAllowlist).toEqual(new Set(['room-1', 'room-2']));
  });

  it('filters out blank entries from trailing/double commas', () => {
    setRequired({ ROOM_ALLOWLIST: 'room-1,,room-2,' });
    // MUTATION GUARD M2: remove `.filter((s) => s.length > 0)` → a '' entry
    // would sneak into the Set; fails
    expect(loadConfig().roomAllowlist).toEqual(new Set(['room-1', 'room-2']));
  });

  it('returns null when the list is entirely blank entries', () => {
    setRequired({ ROOM_ALLOWLIST: ' , , ' });
    expect(loadConfig().roomAllowlist).toBeNull();
  });
});

describe('loadConfig - parseLogLevel (M4)', () => {
  it.each(['debug', 'info', 'warn', 'error'] as const)('accepts "%s" as-is', (level) => {
    setRequired({ LOG_LEVEL: level });
    expect(loadConfig().logLevel).toBe(level);
  });

  it('defaults to "info" when LOG_LEVEL is unset', () => {
    setRequired();
    expect(loadConfig().logLevel).toBe('info');
  });

  it('falls back to "info" for an unrecognised LOG_LEVEL value', () => {
    setRequired({ LOG_LEVEL: 'verbose' });
    // MUTATION GUARD M4: remove the allow-list check → 'verbose' would pass
    // through as-is instead of falling back; fails
    expect(loadConfig().logLevel).toBe('info');
  });
});
