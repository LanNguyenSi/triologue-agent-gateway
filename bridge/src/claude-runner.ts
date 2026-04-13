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
    // Headless invocation needs three non-obvious flags to actually
    // work in a daemon context:
    //
    //   --mcp-config <file>          — load ONLY our per-run config,
    //   --strict-mcp-config             do not merge with ~/.claude.json
    //                                   (avoids both leaking the user's
    //                                   other MCP servers into the run
    //                                   and a subtle footgun where a
    //                                   stale global config shadows the
    //                                   gateway binding).
    //
    //   --permission-mode              — without this, the first time
    //     bypassPermissions              Claude tries to call an MCP
    //                                    tool it prompts for permission
    //                                    and hangs forever on stdin in
    //                                    a non-interactive shell. The
    //                                    tradeoff is explicit: the run
    //                                    is allowed to call the gateway
    //                                    tools without a human gate,
    //                                    which is exactly the whole
    //                                    point of the bridge.
    //
    //   --allowedTools <glob>          — narrows the permission bypass
    //                                    to the three gateway tools
    //                                    only, so a prompt-injection
    //                                    that tricks Claude into
    //                                    calling Bash / Write / any
    //                                    other built-in tool still
    //                                    needs explicit permission.
    const child = spawn(
      cfg.claudeCmd,
      [
        '-p',
        prompt,
        '--mcp-config',
        mcpConfigPath,
        '--strict-mcp-config',
        '--permission-mode',
        'bypassPermissions',
        '--allowedTools',
        'mcp__triologue-gateway__list_rooms',
        '--allowedTools',
        'mcp__triologue-gateway__get_room_messages',
        '--allowedTools',
        'mcp__triologue-gateway__send_message',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const softTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Hard kill after 5 seconds if SIGTERM is ignored. Track the
      // handle so the clean-exit path can cancel it — unref alone
      // would leave the timer armed and fire an ESRCH-swallowed
      // kill on a dead PID later.
      killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5_000);
      killTimer.unref();
    }, cfg.claudeTimeoutMs);
    softTimer.unref();

    const exitCode: number = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 0));
    });
    clearTimeout(softTimer);
    if (killTimer) clearTimeout(killTimer);

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
