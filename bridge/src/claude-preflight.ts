/**
 * Startup preflight for the configured `claude` binary.
 *
 * Every bridge run depends on the tool-restriction flags documented on
 * `buildClaudeArgs` (bridge/src/claude-runner.ts). A `claude` older than
 * those flags does not silently ignore them: it rejects the unknown
 * option, so every @mention fails while the bridge itself looks healthy.
 * To make that failure visible at startup instead of on the first
 * mention, the bridge runs `<claudeCmd> --help` once and refuses to
 * start unless the help output lists every required flag and the
 * `dontAsk` permission-mode choice.
 *
 * The child is spawned with the same environment allowlist as a real
 * run (buildClaudeEnv in claude-runner.ts); the check hands it nothing
 * more. A wedged `--help` is killed at the timeout so the check itself
 * can never hang the bridge or leave a stray process.
 */

import { spawn } from 'node:child_process';
import { buildClaudeEnv } from './claude-runner.js';

/** Bounded wait for `<claudeCmd> --help` (ms). */
export const CLAUDE_PREFLIGHT_TIMEOUT_MS = 10_000;

/** Grace between the timeout's SIGTERM and the SIGKILL escalation. */
const KILL_ESCALATION_MS = 2_000;

/**
 * Fallback settle if a killed child never reports 'exit'/'close'. The
 * SIGKILL above is unblockable, so this only guards against a kernel
 * wedging the wait, not against a child that ignores signals.
 */
const EXIT_GRACE_MS = 5_000;

/**
 * Tokens `claude --help` must list for a bridge run to be restricted.
 * `--tools`, `--permission-prompts` and `--setting-sources` are flags
 * `buildClaudeArgs` passes; `dontAsk` is the permission-mode choice the
 * run relies on. Matched as whole tokens (see matchHelpToken).
 */
export const TOOL_RESTRICTION_TOKENS: readonly string[] = [
  '--tools',
  '--permission-prompts',
  '--setting-sources',
  'dontAsk',
];

/**
 * True when `token` occurs in `output` as a whole token. Output is split
 * on whitespace and each piece is trimmed of surrounding punctuation
 * that help formatting adds around a flag name (`--tools <tools>`,
 * `dontAsk,`, `(choices: dontAsk)`). Trimming never strips characters
 * that are part of a flag name, so `--allowedTools` and `--tools-foo`
 * stay single tokens that do NOT satisfy `--tools`.
 */
export function matchHelpToken(output: string, token: string): boolean {
  for (const raw of output.split(/\s+/)) {
    const piece = raw.replace(/^[^A-Za-z0-9_-]+/, '').replace(/[^A-Za-z0-9_-]+$/, '');
    if (piece === token) return true;
  }
  return false;
}

export type PreflightFailure =
  | { ok: false; kind: 'missing-flags'; missing: string[] }
  | { ok: false; kind: 'spawn-error'; message: string }
  | { ok: false; kind: 'nonzero-exit'; exitCode: number | null; signal: string | null }
  | { ok: false; kind: 'timeout'; timeoutMs: number };

export type PreflightResult = { ok: true } | PreflightFailure;

type HelpOutcome =
  | { kind: 'spawn-error'; message: string }
  | {
      kind: 'run';
      timedOut: boolean;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      output: string;
    };

/**
 * Run `<claudeCmd> --help` once and report whether it supports the
 * tool-restriction flags. stdout and stderr are combined (different
 * Claude Code releases print usage to either). Refusals: the binary
 * cannot be spawned at all, `--help` exits non-zero, the run exceeds
 * `timeoutMs` (the child is killed), or the help output does not list
 * every required token.
 */
export async function preflightClaude(
  claudeCmd: string,
  timeoutMs: number = CLAUDE_PREFLIGHT_TIMEOUT_MS,
): Promise<PreflightResult> {
  const run = await runHelp(claudeCmd, timeoutMs);
  if (run.kind === 'spawn-error') {
    return { ok: false, kind: 'spawn-error', message: run.message };
  }
  if (run.timedOut) {
    return { ok: false, kind: 'timeout', timeoutMs };
  }
  if (run.exitCode !== 0) {
    return { ok: false, kind: 'nonzero-exit', exitCode: run.exitCode, signal: run.signal };
  }
  const missing = TOOL_RESTRICTION_TOKENS.filter((token) => !matchHelpToken(run.output, token));
  if (missing.length > 0) {
    return { ok: false, kind: 'missing-flags', missing };
  }
  return { ok: true };
}

function runHelp(claudeCmd: string, timeoutMs: number): Promise<HelpOutcome> {
  return new Promise<HelpOutcome>((resolve) => {
    const child = spawn(claudeCmd, ['--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildClaudeEnv(),
    });

    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    const output = (): string => Buffer.concat(chunks).toString('utf-8');

    let settled = false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let escalationTimer: NodeJS.Timeout | null = null;
    let exitGraceTimer: NodeJS.Timeout | null = null;
    const finish = (result: HelpOutcome): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      resolve(result);
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      // Kill the child so a hanging --help leaves no process behind:
      // SIGTERM first, SIGKILL for one that ignores it, and a final
      // bounded wait so the check itself can never hang the bridge.
      child.kill('SIGTERM');
      escalationTimer = setTimeout(() => child.kill('SIGKILL'), KILL_ESCALATION_MS);
      escalationTimer.unref();
      exitGraceTimer = setTimeout(
        () => finish({ kind: 'run', timedOut: true, exitCode: null, signal: null, output: output() }),
        EXIT_GRACE_MS,
      );
      exitGraceTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();

    // ENOENT (missing binary) and friends fire 'error' with no 'exit'.
    // The listener stays attached after settle on purpose: a late
    // 'error' with no listener would throw.
    child.once('error', (err: Error) => {
      finish({ kind: 'spawn-error', message: err.message });
    });
    child.once('exit', () => {
      if (timedOut) {
        finish({ kind: 'run', timedOut: true, exitCode: null, signal: null, output: output() });
      }
    });
    // 'close' fires after 'exit' once the pipes drained, so on the
    // non-timeout path the full help output is collected by then.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ kind: 'run', timedOut, exitCode: code, signal, output: output() });
    });
  });
}

/**
 * One-line operator explanation of a refusal, for a log('error', ...)
 * at startup. Always names the configured command; the missing-flags
 * case names exactly the missing tokens.
 */
export function describePreflightFailure(claudeCmd: string, failure: PreflightFailure): string {
  switch (failure.kind) {
    case 'missing-flags':
      return (
        `Refusing to start: "${claudeCmd} --help" does not list the tool-restriction flag(s) ` +
        `this bridge requires: ${failure.missing.join(', ')}. Every run starts claude with those ` +
        `flags and an older binary rejects them, so every mention would fail. ` +
        `Upgrade claude or point CLAUDE_CMD at a supported binary (checked against Claude Code 2.1.306).`
      );
    case 'spawn-error':
      return (
        `Refusing to start: cannot run "${claudeCmd} --help": ${failure.message}. ` +
        `Install claude or fix CLAUDE_CMD.`
      );
    case 'nonzero-exit':
      return (
        `Refusing to start: "${claudeCmd} --help" exited with ` +
        `${failure.signal ? `signal ${failure.signal}` : `code ${failure.exitCode}`} instead of 0. ` +
        `Install a claude that supports the tool-restriction flags or fix CLAUDE_CMD.`
      );
    case 'timeout':
      return (
        `Refusing to start: "${claudeCmd} --help" did not exit within ${failure.timeoutMs}ms ` +
        `and was killed. Fix CLAUDE_CMD so it runs non-interactively.`
      );
  }
}
