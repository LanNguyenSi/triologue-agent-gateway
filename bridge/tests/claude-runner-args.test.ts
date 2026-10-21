/**
 * Argument list of the spawned `claude -p` process.
 *
 * Nothing is mocked: the real `spawn` starts a stub `claudeCmd` (a tiny node
 * script) that prints the argv it actually received as JSON, so the
 * assertions cover what the child is started with.
 *
 * The restriction under test: a bridge run can call only the three gateway
 * MCP tools. In Claude Code, `--permission-mode bypassPermissions` allows
 * every tool that exists and `--allowedTools` only adds auto-approvals, so
 * the narrowing comes from `--tools ""` (no built-in tool exists in the
 * session) plus `--permission-mode dontAsk` (anything not allowed is denied,
 * nothing prompts).
 *
 * Mutation guards (marked inline):
 *   A1: `--tools ""` removed or its value changed (built-ins available)
 *   A2: permission mode switched back to `bypassPermissions`, or `dontAsk`
 *       replaced by a mode that allows more
 *   A3: the MCP allowance widened (a wildcard, or a fourth tool)
 *   A4: `--permission-prompts none` dropped
 *   A5: `--setting-sources user` dropped or widened
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeConfig } from '../src/config.js';
import type { AgentIdentity, IncomingMessage } from '../src/mention.js';
import { GATEWAY_TOOLS, buildClaudeArgs, buildPrompt, runClaude } from '../src/claude-runner.js';

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

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'bridge-args-test-'));
  stubPath = join(scratch, 'stub-claude.mjs');
  await writeFile(
    stubPath,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    'utf-8',
  );
  await chmod(stubPath, 0o755);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** The restriction flags, in the exact order the bridge passes them. */
const RESTRICTION_ARGS = [
  '--strict-mcp-config',
  '--setting-sources',
  'user',
  '--tools',
  '',
  '--permission-mode',
  'dontAsk',
  '--permission-prompts',
  'none',
  '--allowedTools',
  'mcp__triologue-gateway__list_rooms',
  '--allowedTools',
  'mcp__triologue-gateway__get_room_messages',
  '--allowedTools',
  'mcp__triologue-gateway__send_message',
];

describe('argv of the spawned claude process', () => {
  it('passes exactly the pinned argument list, as seen by the child', async () => {
    const result = await runClaude(makeCfg(), { message, agent });
    expect(result.exitCode).toBe(0);
    const argv = JSON.parse(result.stdout) as string[];

    // The mcp-config path is a per-run temp path: check its shape, then pin
    // everything else literally.
    expect(argv.slice(0, 2)).toEqual(['-p', buildPrompt({ message, agent })]);
    expect(argv[2]).toBe('--mcp-config');
    expect(argv[3]).toMatch(/triologue-bridge-[^/]+\/mcp\.json$/);
    // MUTATION GUARDS A1-A5: any change to a restriction flag or its value,
    // or an added/removed flag, fails this exact comparison.
    expect(argv.slice(4)).toEqual(RESTRICTION_ARGS);
  });

  it('removes every built-in tool with an empty --tools value', () => {
    const args = buildClaudeArgs('p', '/m.json');
    const i = args.indexOf('--tools');
    // MUTATION GUARD A1: the value must be the empty string, not "default"
    // or a tool list, and must follow the flag directly.
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('');
    expect(args.filter((a) => a === '--tools')).toHaveLength(1);
  });

  it('uses dontAsk, never bypassPermissions or another mode', () => {
    const args = buildClaudeArgs('p', '/m.json');
    // MUTATION GUARD A2
    expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).not.toContain('bypassPermissions');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
  });

  it('allows exactly the three gateway tools, with no wildcard', () => {
    const args = buildClaudeArgs('p', '/m.json');
    const allowed = args.flatMap((a, i) => (a === '--allowedTools' ? [args[i + 1]] : []));
    // MUTATION GUARD A3
    expect(allowed).toEqual([
      'mcp__triologue-gateway__list_rooms',
      'mcp__triologue-gateway__get_room_messages',
      'mcp__triologue-gateway__send_message',
    ]);
    expect(allowed).toEqual([...GATEWAY_TOOLS]);
    for (const name of allowed) {
      expect(name).toMatch(/^mcp__triologue-gateway__[a-z_]+$/);
      expect(name).not.toContain('*');
    }
    expect(args).not.toContain('--disallowedTools');
  });

  it('never lets a prompt wait for an answer and reads user settings only', () => {
    const args = buildClaudeArgs('p', '/m.json');
    // MUTATION GUARD A4
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
    // MUTATION GUARD A5
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
  });
});
