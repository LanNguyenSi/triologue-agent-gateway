/**
 * Spawns a headless `claude -p` process for a single @mention and
 * feeds it both the room context and a one-shot MCP server
 * configuration that points at the gateway's `/byoa/mcp` endpoint.
 *
 * The response is expected to come out through an MCP `send_message`
 * tool call, NOT via stdout — Claude's job is to decide what to say
 * and post it itself. The bridge just kicks off the run and waits for
 * exit.
 *
 * ## Why write an MCP config file per run
 *
 * Claude Code reads MCP server configs from a JSON file passed with
 * `--mcp-config`. Writing a fresh per-run temp file lets us bake in
 * the BYOA token without leaking it into the persistent
 * `~/.claude.json` and without polluting the user's global MCP
 * registry. The file is deleted after the run regardless of exit
 * status.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BridgeConfig } from './config.js';
import type { IncomingMessage, AgentIdentity } from './mention.js';

/**
 * How long runClaude keeps waiting for the stdio pipes to drain after
 * the child's 'exit' event, before it settles without waiting for
 * 'close'.
 *
 * 'close' only fires once every stdio pipe is closed. A detached
 * grandchild that inherited stdout/stderr keeps them open after the
 * claude child is gone, so waiting for 'close' alone can stall for the
 * grandchild's whole lifetime, and bridge/src/index.ts awaits this run
 * inside a serialized queue, so one such run would block every later
 * @mention.
 *
 * Late-output semantics: once this grace elapses, stdout/stderr are
 * destroyed and the result carries only the chunks collected so far.
 * Anything the grandchild writes after that point is dropped. Because
 * the read end is destroyed, a grandchild that is still writing gets
 * SIGPIPE (EPIPE if it ignores SIGPIPE), so its output is dropped and it
 * may be terminated.
 */
export const STDIO_DRAIN_GRACE_MS = 2_000;

/**
 * Exact environment variable names the spawned `claude -p` child may
 * inherit from the bridge process. Everything else (tracker tokens,
 * GitHub tokens, other providers' API keys, the bridge's own BYOA_TOKEN
 * variable) stays out of the child's environment. The child runs with
 * a restricted tool set (see `buildClaudeArgs`); the BYOA token value still
 * reaches it through the per-run MCP config by design.
 *
 * Exact names only: no prefix matching, no `process.env` spread. A name
 * is copied only when it is set in the bridge process. The list is
 * documented for operators in bridge/README.md ("Child environment").
 */
export const CLAUDE_CHILD_ENV_ALLOWLIST: readonly string[] = [
  // Process basics
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'TZ',
  'TMPDIR',
  // Locale
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  // Proxy
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  // CA bundles
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  // XDG base directories
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  // Credentials `claude -p` authenticates with (file-based login under
  // HOME needs none of these)
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

/**
 * Build the child environment from the allowlist. Copies each allowlisted
 * name that is set in `source` (an empty string counts as set) and nothing
 * else; a name that is unset in `source` is absent from the result, never
 * an empty string.
 */
export function buildClaudeEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CLAUDE_CHILD_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * The only tools a bridge run may call: the three tools of the gateway MCP
 * server. Names are `mcp__<server>__<tool>` as Claude Code derives them
 * from the `triologue-gateway` key in `buildMcpConfig`.
 */
export const GATEWAY_TOOLS: readonly string[] = [
  'mcp__triologue-gateway__list_rooms',
  'mcp__triologue-gateway__get_room_messages',
  'mcp__triologue-gateway__send_message',
];

/**
 * Build the `claude` argument list. What each flag does, as observed with
 * Claude Code 2.1.x:
 *
 *   -p <prompt>                      headless run, prints the result and exits.
 *
 *   --mcp-config <file>              load ONLY our per-run config, do not
 *   --strict-mcp-config              merge with the user's other MCP servers.
 *
 *   --setting-sources user           read the user settings only. Project and
 *                                    local settings come from the working
 *                                    directory; a project settings file can
 *                                    register hooks that run commands, so the
 *                                    bridge does not depend on its cwd.
 *
 *   --tools ""                       remove EVERY built-in tool (Bash, Read,
 *                                    Write, Edit, WebFetch, Task/Agent, ...)
 *                                    from the session. This does not rely on
 *                                    permissions: the tools do not exist, so
 *                                    a call fails with "No such tool". It is
 *                                    a set-the-available-tools flag, not a
 *                                    deny list, so a built-in tool added by
 *                                    a later Claude Code release is absent
 *                                    too. MCP tools are not built-ins and
 *                                    stay.
 *
 *   --permission-mode dontAsk        never prompt; anything not explicitly
 *                                    allowed is denied. NOT bypassPermissions:
 *                                    that mode allows every tool that exists
 *                                    (including any other tool the gateway
 *                                    server might expose) and --allowedTools
 *                                    does not narrow it, it only adds
 *                                    auto-approvals.
 *
 *   --permission-prompts none        belt to the mode: if anything would still
 *                                    prompt, it is denied instead of waiting
 *                                    on a stdin nobody answers.
 *
 *   --allowedTools <name> (x3)       auto-approve exactly the three gateway
 *                                    tools. Under dontAsk this is the whole
 *                                    allow list.
 */
export function buildClaudeArgs(prompt: string, mcpConfigPath: string): string[] {
  return [
    '-p',
    prompt,
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--setting-sources',
    'user',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    ...GATEWAY_TOOLS.flatMap((tool) => ['--allowedTools', tool]),
  ];
}

export interface RunRequest {
  message: IncomingMessage;
  agent: AgentIdentity;
  /**
   * Optional recent history from the room (oldest first). Passed to
   * Claude as context so replies can reference prior messages.
   */
  history?: Array<{ sender: string; content: string }>;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Build the MCP config JSON that Claude Code will load. Uses the
 * Streamable-HTTP transport flavour to point at the gateway's
 * `/byoa/mcp` endpoint with a Bearer header derived from the same
 * BYOA token the bridge authenticates with.
 */
export function buildMcpConfig(cfg: BridgeConfig): Record<string, unknown> {
  return {
    mcpServers: {
      'triologue-gateway': {
        type: 'http',
        url: `${cfg.gatewayUrl}/byoa/mcp`,
        headers: {
          Authorization: `Bearer ${cfg.byoaToken}`,
        },
      },
    },
  };
}

/**
 * Build the prompt text. Keep it terse and unambiguous — Claude's
 * token budget is precious and the runner runs head-less, so the
 * prompt is the ONLY instruction Claude gets.
 */
export function buildPrompt(req: RunRequest): string {
  const { message, agent, history } = req;
  const lines: string[] = [];

  lines.push(
    `You are the Triologue agent @${agent.mentionKey} (username: ${agent.username}).`,
  );
  lines.push(
    `You received a new message in room ${message.room}${
      message.roomName ? ` ("${message.roomName}")` : ''
    }. Read the message, decide on a reply, and post it using the \`send_message\` tool on the \`triologue-gateway\` MCP server. Use \`room_id: "${message.room}"\` and keep your reply concise.`,
  );
  lines.push('');

  if (history && history.length > 0) {
    lines.push('Recent room history (oldest first):');
    for (const m of history) {
      lines.push(`  ${m.sender}: ${m.content}`);
    }
    lines.push('');
  }

  lines.push(`Latest message from @${message.sender}:`);
  lines.push(message.content);
  lines.push('');
  lines.push(
    'Reply by calling `send_message` exactly once. If the message does not need a reply, do not call the tool and finish the run quietly.',
  );

  return lines.join('\n');
}

/**
 * Spawn a single Claude run and wait for it to exit. Writes a
 * throwaway MCP config into a per-run temp directory, passes its
 * path to `claude -p`, and cleans up in a finally block even on
 * failure.
 *
 * The spawned process uses `stdio: ['ignore', 'pipe', 'pipe']` so we
 * can capture stdout + stderr for logging without the child reading
 * from our own stdin.
 */
export async function runClaude(
  cfg: BridgeConfig,
  req: RunRequest,
): Promise<RunResult> {
  const prompt = buildPrompt(req);
  const mcpConfig = buildMcpConfig(cfg);

  const tmp = await mkdtemp(join(tmpdir(), 'triologue-bridge-'));
  const mcpConfigPath = join(tmp, 'mcp.json');
  // Belt to the 0700 mkdtemp braces: explicit 0600 on the JSON file
  // itself so the Bearer token inside is not readable under an
  // aggressive umask or a misconfigured shared workspace.
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });

  const start = Date.now();
  try {
    // Flags and their effect: see buildClaudeArgs. The child gets only the
    // allowlisted variable names (buildClaudeEnv), not the bridge's whole
    // environment.
    const child = spawn(
      cfg.claudeCmd,
      buildClaudeArgs(prompt, mcpConfigPath),
      { stdio: ['ignore', 'pipe', 'pipe'], env: buildClaudeEnv() },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const onStdout = (chunk: Buffer): void => {
      stdoutChunks.push(chunk);
    };
    const onStderr = (chunk: Buffer): void => {
      stderrChunks.push(chunk);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);

    let timedOut = false;
    // `child.killed` is NOT a liveness check: Node flips it to true as
    // soon as the kill('SIGTERM') call itself successfully delivers the
    // signal, not when the process actually exits. A child that installs
    // a SIGTERM handler and ignores it already reads `killed === true`
    // at that point, so gating the hard kill below on `!child.killed`
    // would never escalate. Track real termination via the child's own
    // 'exit' event instead.
    let exited = false;
    let exitCodeFromExit: number | null = null;
    // Assigned by the drain logic below, before any 'exit' can fire.
    let armDrain!: () => void;
    const onExit = (code: number | null): void => {
      exited = true;
      exitCodeFromExit = code;
      armDrain();
    };
    child.once('exit', onExit);
    let killTimer: NodeJS.Timeout | null = null;
    const softTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Hard kill after 5 seconds if SIGTERM is ignored. Track the
      // handle so the clean-exit path can cancel it — unref alone
      // would leave the timer armed and fire an ESRCH-swallowed
      // kill on a dead PID later.
      killTimer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, 5_000);
      killTimer.unref();
    }, cfg.claudeTimeoutMs);
    softTimer.unref();

    // Clear both timers in a finally so a rejection (child.once('error',
    // reject), e.g. ENOENT for a missing claude binary — no 'exit' or
    // 'close' ever fires) doesn't leave softTimer/killTimer armed against
    // a child that was never spawned.
    let exitCode: number;
    let drainTimer: NodeJS.Timeout | null = null;
    // Assigned synchronously by the promise executor below.
    let onClose!: (code: number | null) => void;
    // Settle on 'close' (pipes drained) or, after 'exit', when the drain
    // grace elapses, whichever comes first. The exit code from 'close'
    // wins when it fired; otherwise the one from 'exit' is used.
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        onClose = (code: number | null): void => resolve(code ?? 0);
        armDrain = () => {
          drainTimer = setTimeout(() => {
            // See STDIO_DRAIN_GRACE_MS: late output is dropped.
            child.stdout.destroy();
            child.stderr.destroy();
            resolve(exitCodeFromExit ?? 0);
          }, STDIO_DRAIN_GRACE_MS);
          drainTimer.unref();
        };
        child.once('error', onError);
        child.once('close', onClose);
        // A child that already exited before this executor ran cannot
        // happen (listeners attach synchronously after spawn), so no
        // replay of 'exit' is needed.
      });
    } finally {
      clearTimeout(softTimer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      // Drop runClaude's own listeners (and only those) so nothing fires
      // or collects after settle.
      // The 'error' listener stays attached on purpose: a late 'error'
      // event with no listener would throw, while rejecting a settled
      // promise is a no-op.
      child.off('exit', onExit);
      child.off('close', onClose);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
    }

    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      durationMs: Date.now() - start,
      timedOut,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
