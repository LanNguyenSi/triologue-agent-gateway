/**
 * Integration check for the startup order in bridge/src/index.ts
 * main(): the claude preflight runs BEFORE the gateway is authenticated
 * against, and a refusal exits 1 with an error naming the configured
 * command.
 *
 * The daemon entrypoint is not importable (module load starts the
 * daemon), so the test runs the real `main()` by spawning
 * `node node_modules/.bin/tsx src/index.ts` as a child process with
 * CLAUDE_CMD pointed at a stub and GATEWAY_URL at a closed localhost
 * port. stderr is redirected to a FILE, not a pipe: `process.exit` can
 * truncate pending pipe writes, a file is written synchronously.
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BRIDGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TSX_BIN = join(BRIDGE_ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = join(BRIDGE_ROOT, 'src', 'index.ts');

const FULL_HELP = [
  'Options:',
  '  --setting-sources <sources>   comma-separated list of setting sources',
  '  --tools <tools>               comma-separated list of tools to enable',
  '  --permission-mode <mode>      choices: acceptEdits, bypassPermissions, default, dontAsk, plan',
  '  --permission-prompts <mode>   choices: interactive, none',
].join('\n');

/** Help like FULL_HELP but without any occurrence of `token`. */
function helpWithout(token: string): string {
  if (token === 'dontAsk') return FULL_HELP.replace(', dontAsk', '');
  return FULL_HELP.split('\n')
    .filter((line) => !line.includes(`${token} `))
    .join('\n');
}

let scratch: string;
const liveChildren = new Set<ReturnType<typeof spawn>>();

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'bridge-main-preflight-'));
});

afterEach(async () => {
  for (const child of liveChildren) child.kill('SIGKILL');
  liveChildren.clear();
  await rm(scratch, { recursive: true, force: true });
});

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

interface BridgeRun {
  code: number | null;
  stderr: string;
}

/** Run the real daemon entrypoint with the given CLAUDE_CMD. */
async function runBridge(claudeCmd: string): Promise<BridgeRun> {
  const errFile = join(scratch, `stderr-${Math.random().toString(36).slice(2)}.log`);
  const errFd = openSync(errFile, 'w');
  try {
    const child = spawn(process.execPath, [TSX_BIN, ENTRY], {
      cwd: BRIDGE_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        GATEWAY_URL: 'http://127.0.0.1:1',
        BYOA_TOKEN: 'test-token',
        CLAUDE_CMD: claudeCmd,
      },
      stdio: ['ignore', 'ignore', errFd],
    });
    liveChildren.add(child);
    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (c) => resolve(c));
      child.once('error', () => resolve(-1));
      // tsx start + a 10s preflight bound is ample; the SIGKILL in
      // afterEach is the backstop for a wedged run.
      setTimeout(() => child.kill('SIGKILL'), 60_000).unref();
    });
    liveChildren.delete(child);
    await new Promise((r) => setTimeout(r, 50));
    return { code, stderr: await readFile(errFile, 'utf-8') };
  } finally {
    closeSync(errFd);
    await rm(errFile, { force: true });
  }
}

describe('main() calls the preflight before authenticating', () => {
  it(
    'refuses with exit 1 when the help lacks --tools, and never reaches the gateway',
    async () => {
      const stub = await helpStub('claude-no-tools.mjs', helpWithout('--tools'));
      const run = await runBridge(stub);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('Refusing to start');
      expect(run.stderr).toContain('--tools');
      expect(run.stderr).toContain(stub);
      // Before authenticating: no auth attempt happened.
      expect(run.stderr).not.toMatch(/Failed to fetch agent status|fetch failed|SSE/);
    },
    60_000,
  );

  it(
    'refuses with exit 1 when the binary does not exist',
    async () => {
      const missing = join(scratch, 'no-such-claude');
      const run = await runBridge(missing);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('Refusing to start');
      expect(run.stderr).toContain(missing);
      expect(run.stderr).not.toMatch(/Failed to fetch agent status|fetch failed|SSE/);
    },
    60_000,
  );

  it(
    'passes the preflight and proceeds to authenticate when the help lists every token',
    async () => {
      const stub = await helpStub('claude-all.mjs', FULL_HELP);
      const run = await runBridge(stub);
      // Auth against 127.0.0.1:1 fails, so the daemon still exits 1,
      // but only AFTER the preflight passed: the refusal wording is gone
      // and the auth failure is logged instead.
      expect(run.code).toBe(1);
      expect(run.stderr).not.toContain('Refusing to start');
      expect(run.stderr).toContain('fetch failed');
    },
    60_000,
  );
});
