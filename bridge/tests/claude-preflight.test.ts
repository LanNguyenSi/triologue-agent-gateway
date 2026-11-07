/**
 * Startup preflight for the configured `claude` binary
 * (bridge/src/claude-preflight.ts).
 *
 * Nothing is mocked: the real `spawn` starts a stub `claudeCmd` (a tiny
 * node script written into a mkdtemp dir, the style of the existing
 * runner tests) that prints a canned `--help` output, exits non-zero, or
 * hangs, so the assertions cover what the check really observes.
 *
 * Mutation guards (marked inline):
 *   P1: a required token drops out of TOOL_RESTRICTION_TOKENS or the
 *       missing-token check (its per-flag test fails)
 *   P2: whole-token matching weakens to substring (the decoy tests fail)
 *   P3: the timeout stops killing the child (the kill/pid-gone test fails)
 *   P4: stdout is read alone or stderr is read alone (the split-stream
 *       test and the stderr-only test fail)
 *   P5: spawn 'error' (ENOENT) or a non-zero exit is no longer a refusal
 *   P6: describePreflightFailure drops the configured command or the
 *       missing-token names from the message
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TOOL_RESTRICTION_TOKENS,
  describePreflightFailure,
  matchHelpToken,
  preflightClaude,
  type PreflightFailure,
} from '../src/claude-preflight.js';

/**
 * Help text in the shape a recent Claude Code prints, with all four
 * required tokens present as whole tokens. `--allowedTools` is here too:
 * a run of it must never stand in for `--tools`.
 */
const FULL_HELP = [
  'Usage: claude [options] [prompt]',
  '',
  'Options:',
  '  -p, --print                        print the response and exit',
  '  --mcp-config <files>               load MCP servers from JSON file(s)',
  '  --strict-mcp-config                only use MCP servers from --mcp-config',
  '  --setting-sources <sources>        comma-separated list of setting sources',
  '  --tools <tools>                    comma-separated list of tools to enable',
  '  --permission-mode <mode>           permission mode (choices: acceptEdits, bypassPermissions, default, dontAsk, plan)',
  '  --permission-prompts <prompts>     prompt handling (choices: interactive, none)',
  '  --allowedTools <tools>             comma-separated list of tool names to auto-approve',
  '',
].join('\n');

/** FULL_HELP with every occurrence of `token` gone. */
function helpWithout(token: string): string {
  if (token === 'dontAsk') return FULL_HELP.replace(', dontAsk', '');
  const prefix = `${token} `;
  return FULL_HELP.split('\n')
    .filter((line) => !line.includes(prefix))
    .join('\n');
}

let scratch: string;

async function writeStub(name: string, body: string): Promise<string> {
  const p = join(scratch, name);
  await writeFile(p, `#!/usr/bin/env node\n${body}\n`, 'utf-8');
  await chmod(p, 0o755);
  return p;
}

async function helpStub(name: string, helpText: string): Promise<string> {
  return writeStub(
    name,
    `process.stdout.write(${JSON.stringify(helpText)});\nprocess.exit(0);`,
  );
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'bridge-preflight-test-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('TOOL_RESTRICTION_TOKENS', () => {
  it('pins the exact required token list, written out literally', () => {
    // MUTATION GUARD P1: dropping an entry from the required list (and
    // with it the loop-generated per-flag test) must be a deliberate
    // edit of this literal list too.
    expect([...TOOL_RESTRICTION_TOKENS].sort()).toEqual(
      ['--tools', '--permission-prompts', '--setting-sources', 'dontAsk'].sort(),
    );
  });
});

describe('matchHelpToken (whole-token matching)', () => {
  it('matches a flag only as a whole token', () => {
    expect(matchHelpToken('--tools <tools>', '--tools')).toBe(true);
    // MUTATION GUARD P2: substring matching would satisfy these.
    expect(matchHelpToken('--allowedTools <tools>', '--tools')).toBe(false);
    expect(matchHelpToken('--tools-foo x', '--tools')).toBe(false);
    expect(matchHelpToken('xx --tools xx', '--tools')).toBe(true);
  });

  it('tolerates punctuation help formats add around a token', () => {
    expect(matchHelpToken('(choices: acceptEdits, dontAsk, plan)', 'dontAsk')).toBe(true);
    expect(matchHelpToken('--tools:', '--tools')).toBe(true);
    expect(matchHelpToken('<dontAsk>', 'dontAsk')).toBe(true);
  });
});

describe('preflightClaude (real spawn, stub claudeCmd)', () => {
  it('passes when the help lists every required token', async () => {
    const stub = await helpStub('claude-all.mjs', FULL_HELP);
    expect(await preflightClaude(stub)).toEqual({ ok: true });
  });

  it('reads the help from stdout and stderr together (P4)', async () => {
    const lines = FULL_HELP.split('\n');
    const cut = lines.findIndex((l) => l.includes('--dontAsk-anchor') || l.includes('--tools '));
    const before = lines.slice(0, cut).join('\n');
    const after = lines.slice(cut).join('\n');
    const stub = await writeStub(
      'claude-split.mjs',
      [
        `process.stdout.write(${JSON.stringify(before)});`,
        `process.stderr.write(${JSON.stringify('\n' + after)});`,
        'process.exit(0);',
      ].join('\n'),
    );
    // MUTATION GUARD P4: collecting only one stream loses half the tokens.
    expect(await preflightClaude(stub)).toEqual({ ok: true });
  });

  it('accepts a help printed entirely on stderr', async () => {
    const stub = await writeStub(
      'claude-stderr.mjs',
      `process.stderr.write(${JSON.stringify(FULL_HELP)});\nprocess.exit(0);`,
    );
    expect(await preflightClaude(stub)).toEqual({ ok: true });
  });

  // One test case per required flag: its absence is what refuses.
  for (const token of TOOL_RESTRICTION_TOKENS) {
    it(`refuses and names ${token} alone when it is missing`, async () => {
      const stub = await helpStub(`claude-no-${token}.mjs`, helpWithout(token));
      const result = await preflightClaude(stub);
      // MUTATION GUARD P1: dropping the token from the required list
      // makes this ok -> fails.
      expect(result.ok).toBe(false);
      const failure = result as PreflightFailure;
      expect(failure.kind).toBe('missing-flags');
      if (failure.kind !== 'missing-flags') return;
      expect(failure.missing).toEqual([token]);
      // MUTATION GUARD P6: the message names exactly the missing flag
      // and the configured command.
      const msg = describePreflightFailure(stub, failure);
      expect(msg).toContain(token);
      expect(msg).toContain(stub);
      for (const other of TOOL_RESTRICTION_TOKENS.filter((t) => t !== token)) {
        expect(msg).not.toContain(other);
      }
    });
  }

  it('names every missing flag when all four are absent', async () => {
    const stub = await helpStub('claude-none.mjs', 'Usage: claude [options]\n');
    const result = await preflightClaude(stub);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('missing-flags');
    if (result.kind !== 'missing-flags') return;
    expect(result.missing).toEqual([
      '--tools',
      '--permission-prompts',
      '--setting-sources',
      'dontAsk',
    ]);
    const msg = describePreflightFailure(stub, result);
    for (const token of [
      '--tools',
      '--permission-prompts',
      '--setting-sources',
      'dontAsk',
    ]) {
      expect(msg).toContain(token);
    }
  });

  it('refuses when --allowedTools is present but --tools is not (P2)', async () => {
    const help = FULL_HELP.split('\n')
      .map((line) =>
        line.startsWith('  --tools ')
          ? '  --tools-foo <x>                    decoy flag, a look-alike of the real one'
          : line,
      )
      .join('\n');
    const stub = await helpStub('claude-allowed-only.mjs', help);
    const result = await preflightClaude(stub);
    // MUTATION GUARD P2: substring matching would see --tools inside
    // --allowedTools and pass -> fails.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('missing-flags');
    if (result.kind !== 'missing-flags') return;
    expect(result.missing).toEqual(['--tools']);
  });

  it('hands the --help child only the allowlisted environment', async () => {
    const envFile = join(scratch, 'child-env.json');
    const saved = { ...process.env };
    try {
      process.env.GH_TOKEN = 'forbidden-gh';
      process.env.PATH = saved.PATH ?? '/usr/bin'; // the stub's shebang needs it
      const stub = await writeStub(
        'claude-env.mjs',
        [
          `import { writeFileSync } from 'node:fs';`,
          `writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));`,
          'process.exit(0);',
        ].join('\n'),
      );
      await preflightClaude(stub);
      const childEnv = JSON.parse(await readFile(envFile, 'utf-8')) as Record<string, string>;
      // buildClaudeEnv is reused, not a raw process.env handoff.
      expect(childEnv).not.toHaveProperty('GH_TOKEN');
      expect(childEnv.PATH).toBe(process.env.PATH);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it('refuses when the binary does not exist (P5)', async () => {
    const result = await preflightClaude(join(scratch, 'no-such-claude'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('spawn-error');
    if (result.kind !== 'spawn-error') return;
    expect(result.message).toContain('ENOENT');
    const msg = describePreflightFailure(join(scratch, 'no-such-claude'), result);
    expect(msg).toContain('no-such-claude');
  });

  it('refuses when --help exits non-zero even with a complete help (P5)', async () => {
    const stub = await writeStub(
      'claude-fail.mjs',
      `process.stdout.write(${JSON.stringify(FULL_HELP)});\nprocess.exit(7);`,
    );
    const result = await preflightClaude(stub);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('nonzero-exit');
    if (result.kind !== 'nonzero-exit') return;
    expect(result.exitCode).toBe(7);
    expect(describePreflightFailure(stub, result)).toContain('code 7');
  });

  it('refuses on timeout and kills the hanging child (P3)', async () => {
    const pidFile = join(scratch, 'hanging.pid');
    const termFile = join(scratch, 'hanging.term');
    const stub = await writeStub(
      'claude-hang.mjs',
      [
        `import { writeFileSync } from 'node:fs';`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        `process.on('SIGTERM', () => {`,
        `  writeFileSync(${JSON.stringify(termFile)}, 'term');`,
        '  process.exit(0);',
        '});',
        'setTimeout(() => {}, 600000);',
      ].join('\n'),
    );
    const result = await preflightClaude(stub, 300);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('timeout');
    const timeoutMsg = describePreflightFailure(stub, result);
    expect(timeoutMsg).toContain(stub);
    expect(timeoutMsg).toContain('did not exit');

    // The timeout path killed the child with SIGTERM, not just waited:
    // only a SIGTERM handler can write the marker (the SIGKILL
    // escalation at +2s cannot). MUTATION GUARD P3: without the kill,
    // the marker never appears.
    const term = await waitFile(termFile, 2_000);
    expect(term).toBe('term');

    // And no process is left behind: poll until the stub's pid is gone.
    const pid = Number(await readFileWithRetry(pidFile));
    const goneBy = Date.now() + 3_000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        break; // ESRCH: the child is gone.
      }
      if (Date.now() > goneBy) {
        throw new Error(`stub claude (pid ${pid}) still alive after preflight timeout`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  });
});

async function waitFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      if (Date.now() > deadline) throw new Error(`file never appeared: ${path}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

async function readFileWithRetry(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw new Error(`pid file never appeared: ${path}`);
}
