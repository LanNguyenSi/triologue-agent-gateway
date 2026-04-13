#!/usr/bin/env node
/**
 * @triologue/bridge — local daemon entry point.
 *
 * Architecture (see bridge/README.md for the full picture):
 *
 *   Triologue room
 *     → gateway SSE stream
 *     → SseClient
 *     → mention filter
 *     → WorkQueue (serial, one Claude run at a time)
 *     → headless `claude -p` with MCP config pointing at /byoa/mcp
 *     → Claude calls `send_message` → message lands back in the room
 *
 * Runs forever. Reconnects with exponential backoff on gateway
 * disconnect. Graceful shutdown on SIGINT / SIGTERM.
 */

import { loadConfig, type BridgeConfig } from './config.js';
import { SseClient } from './sse-client.js';
import { WorkQueue } from './queue.js';
import { shouldTrigger, type AgentIdentity, type IncomingMessage } from './mention.js';
import { runClaude } from './claude-runner.js';

interface AgentStatus {
  userId: string;
  name: string;
  username: string;
  mentionKey: string;
  receiveMode: 'mentions' | 'all';
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function logger(configuredLevel: LogLevel) {
  const threshold = LOG_LEVELS.indexOf(configuredLevel);
  return (level: LogLevel, message: string): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    const stamp = new Date().toISOString();
    const prefix = `[${stamp}] [${level}]`;
    if (level === 'error' || level === 'warn') {
      console.error(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }
  };
}

/**
 * Resolve the agent's own identity by hitting the gateway's BYOA
 * status endpoint. We need this to fill in the mention key and the
 * receive mode, and to give the hard loop-guard a username to compare
 * against.
 */
async function fetchAgentIdentity(cfg: BridgeConfig): Promise<AgentStatus> {
  const res = await fetch(`${cfg.gatewayUrl}/byoa/sse/status`, {
    headers: { Authorization: `Bearer ${cfg.byoaToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch agent status (HTTP ${res.status}). Check GATEWAY_URL and BYOA_TOKEN.`,
    );
  }
  const body = (await res.json()) as {
    agent?: {
      id?: string;
      name?: string;
      username?: string;
      mentionKey?: string;
      receiveMode?: 'mentions' | 'all';
    };
  };
  const a = body.agent;
  if (!a?.id || !a?.username || !a?.mentionKey) {
    throw new Error(
      'Gateway /byoa/sse/status response missing id/username/mentionKey. The bridge requires a gateway with the status-endpoint patch (same PR as the bridge itself, 2026-04). Upgrade the gateway and retry.',
    );
  }
  if (!a.receiveMode) {
    // Silent default to `mentions` would look correct on a
    // mentions-only agent and broken on a receiveMode=all agent —
    // refuse to start rather than guess.
    throw new Error(
      'Gateway /byoa/sse/status response missing receiveMode. The bridge requires this field to decide whether to trigger on every room message or only on explicit @mentions. Upgrade the gateway and retry.',
    );
  }
  return {
    userId: a.id,
    name: a.name ?? a.username,
    username: a.username,
    mentionKey: a.mentionKey,
    receiveMode: a.receiveMode,
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = logger(cfg.logLevel);

  log('info', `Starting triologue-bridge → ${cfg.gatewayUrl}`);

  let status: AgentStatus;
  try {
    status = await fetchAgentIdentity(cfg);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log('error', m);
    process.exit(1);
  }

  log(
    'info',
    `Authenticated as ${status.name} (@${status.mentionKey}, receiveMode=${status.receiveMode})`,
  );
  if (cfg.roomAllowlist) {
    log(
      'info',
      `Room allowlist active: ${[...cfg.roomAllowlist].join(', ')}`,
    );
  }

  const agentId: AgentIdentity = {
    username: status.username,
    mentionKey: status.mentionKey,
    receiveMode: status.receiveMode,
  };

  const queue = new WorkQueue();

  const sse = new SseClient({
    url: `${cfg.gatewayUrl}/byoa/sse/stream`,
    token: cfg.byoaToken,
    log,
    onConnect: () => log('info', 'SSE stream open, waiting for messages…'),
    onDisconnect: (reason) => log('warn', `SSE stream closed: ${reason}`),
    onMessage: async (msg: IncomingMessage) => {
      const decision = shouldTrigger(msg, agentId, cfg.roomAllowlist);
      if (!decision.trigger) {
        log('debug', `Skip ${msg.id}: ${decision.reason}`);
        return;
      }
      log(
        'info',
        `@mention from ${msg.sender} in ${msg.room} (queue depth ${queue.depth}${queue.busy ? ', busy' : ''})`,
      );
      // Catch inside the enqueued callback so a thrown error from
      // `runClaude` (e.g. ENOENT if CLAUDE_CMD is misconfigured, or an
      // EACCES writing the MCP config tmpfile) is visible instead of
      // being swallowed by the void-enqueue dance.
      void queue.enqueue(async () => {
        try {
          const result = await runClaude(cfg, { message: msg, agent: agentId });
          if (result.timedOut) {
            log(
              'error',
              `Claude run TIMED OUT after ${result.durationMs}ms for message ${msg.id}`,
            );
          } else if (result.exitCode !== 0) {
            log(
              'warn',
              `Claude exited with code ${result.exitCode} (${result.durationMs}ms). stderr: ${result.stderr.slice(0, 400)}`,
            );
          } else {
            log(
              'info',
              `Claude run OK in ${result.durationMs}ms for message ${msg.id}`,
            );
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          log(
            'error',
            `Claude run threw before exit for message ${msg.id}: ${m}`,
          );
        }
      });
    },
  });

  const shutdown = (signal: string): void => {
    log('info', `Received ${signal}, shutting down…`);
    sse.stop();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await sse.start();
  log('info', 'Bye.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[triologue-bridge] fatal:', err);
  process.exit(1);
});
