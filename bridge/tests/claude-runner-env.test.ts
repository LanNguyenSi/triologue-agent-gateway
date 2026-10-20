/**
 * Child-environment allowlist for the spawned `claude -p` process.
 *
 * Unlike claude-runner.test.ts these tests mock nothing: the real `spawn`
 * starts a stub `claudeCmd` (a tiny node script) that prints the
 * environment it actually received as JSON, so the assertions cover what
 * the child sees, not what the code meant to pass.
 *
 * Mutation guards (marked inline):
 *   E1: the spawn passes the bridge's whole environment (process.env or a
 *       spread of it) instead of the allowlisted copy
 *   E2: the spawn drops the `env` option (child inherits everything)
 *   E3: an allowlisted name that is unset in the bridge is copied as ''
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeConfig } from '../src/config.js';
import type { AgentIdentity, IncomingMessage } from '../src/mention.js';
import { CLAUDE_CHILD_ENV_ALLOWLIST, buildClaudeEnv, runClaude } from '../src/claude-runner.js';

const FORBIDDEN: Record<string, string> = {
  AGENT_TASKS_TOKEN: 'forbidden-agent-tasks',
  GH_TOKEN: 'forbidden-gh',
  GITHUB_TOKEN: 'forbidden-github',
  OPENAI_API_KEY: 'forbidden-openai',
  FOO_TOKEN: 'forbidden-foo',
  // Same prefix as an allowlisted credential, but not on the list.
  ANTHROPIC_BASE_URL_EVIL: 'forbidden-anthropic-prefix',
  BYOA_TOKEN: 'forbidden-byoa',
};

const agent: AgentIdentity = { username: 'claude-bot', mentionKey: 'code', receiveMode: 'mentions' };
const message: IncomingMessage = {
  id: 'm1',
  room: 'room-1',
  roomName: 'General',
  sender: 'alice',
  senderType: 'HUMAN',
  content: 'hello',
  timestamp: '2026-01-01T00:00:00Z',
};

let scratch: string;
let stubPath: string;
let savedEnv: NodeJS.ProcessEnv;

function makeCfg(): BridgeConfig {
  return {
    gatewayUrl: 'https://gateway.test',
    byoaToken: 'byoa_test_token',
    claudeCmd: stubPath,
    roomAllowlist: null,
    claudeTimeoutMs: 20_000,
    logLevel: 'info',
  };
}

/** Run the stub through the real runClaude and return the env it saw. */
async function childEnv(): Promise<Record<string, string>> {
  const result = await runClaude(makeCfg(), { message, agent });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string>;
}

beforeEach(async () => {
  savedEnv = { ...process.env };
  scratch = await mkdtemp(join(tmpdir(), 'bridge-env-test-'));
  stubPath = join(scratch, 'stub-claude.mjs');
  await writeFile(
    stubPath,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.env));\n',
    'utf-8',
  );
  await chmod(stubPath, 0o755);
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(scratch, { recursive: true, force: true });
});

describe('buildClaudeEnv', () => {
  it('copies exactly the allowlisted names that are set', () => {
    const source: NodeJS.ProcessEnv = { PATH: '/bin', LANG: 'C', ...FORBIDDEN };
    expect(buildClaudeEnv(source)).toEqual({ PATH: '/bin', LANG: 'C' });
  });

  it('omits an unset name instead of copying an empty string, but keeps a set empty one', () => {
    const env = buildClaudeEnv({ PATH: '/bin', TZ: '' });
    expect(Object.keys(env).sort()).toEqual(['PATH', 'TZ']);
    expect(env.TZ).toBe('');
    expect('LANG' in env).toBe(false);
  });

  it('matches names exactly, with no prefix matching', () => {
    const env = buildClaudeEnv({
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL_EVIL: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      CLAUDE_CODE_OTHER: 'x',
      LC_ALL: 'C',
      LC_TIME: 'x',
      XDG_CONFIG_HOME: '/c',
      XDG_EVIL: 'x',
    });
    expect(env).toEqual({
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      LC_ALL: 'C',
      XDG_CONFIG_HOME: '/c',
    });
  });

  it('names the credentials claude -p authenticates with', () => {
    expect(CLAUDE_CHILD_ENV_ALLOWLIST).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']),
    );
  });
});

describe('runClaude child environment (real spawn)', () => {
  it('does not pass forbidden names to the child (E1, E2)', async () => {
    Object.assign(process.env, FORBIDDEN);
    const env = await childEnv();
    // MUTATION GUARD E1/E2: env: process.env, a spread of it, or no env
    // option at all makes the forbidden names reach the child -> fails.
    for (const name of Object.keys(FORBIDDEN)) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it('passes every allowlisted name and credential that is set, with its value', async () => {
    const expected: Record<string, string> = {};
    for (const name of CLAUDE_CHILD_ENV_ALLOWLIST) {
      // Keep PATH, HOME and TMPDIR real: the stub's `#!/usr/bin/env node`
      // shebang needs PATH, and runClaude itself calls os.tmpdir().
      if (name === 'PATH' || name === 'HOME' || name === 'TMPDIR') {
        expected[name] = process.env[name] ?? (name === 'TMPDIR' ? tmpdir() : '/usr/bin');
        process.env[name] = expected[name];
      } else {
        expected[name] = `value-of-${name}`;
        process.env[name] = expected[name];
      }
    }
    // Settings that would change node's behaviour beyond the env check.
    delete process.env.NODE_EXTRA_CA_CERTS;
    delete expected.NODE_EXTRA_CA_CERTS;
    const env = await childEnv();
    for (const [name, value] of Object.entries(expected)) {
      expect(env[name], name).toBe(value);
    }
  });

  it('delivers the credential names to the child', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-api';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'auth-test';
    const env = await childEnv();
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-api');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-test');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('auth-test');
  });

  it('leaves a name that is unset in the bridge absent in the child, not empty (E3)', async () => {
    const unset = CLAUDE_CHILD_ENV_ALLOWLIST.filter((n) => n !== 'PATH');
    for (const name of unset) delete process.env[name];
    const env = await childEnv();
    // MUTATION GUARD E3: copying `source[name] ?? ''` creates the key.
    for (const name of unset) {
      expect(env, name).not.toHaveProperty(name);
    }
  });
});
