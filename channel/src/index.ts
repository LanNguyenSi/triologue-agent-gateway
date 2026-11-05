#!/usr/bin/env node
/**
 * Entrypoint: Claude Code spawns this over stdio (see .mcp.json). Logs go to
 * stderr; stdout is the MCP transport and must stay clean.
 */
import { loadConfig } from './config.js';
import { GatewayClient } from './gateway.js';
import { ChannelServer } from './server.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
/** Shutdown waits this long for the gateway at most; then the process exits anyway. */
const SHUTDOWN_GRACE_MS = 8_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const threshold = LEVELS[config.logLevel];
  const log = (level: keyof typeof LEVELS, message: string) => {
    if (LEVELS[level] >= threshold) process.stderr.write(`[triologue-channel] ${level}: ${message}\n`);
  };
  const gateway = new GatewayClient({ gatewayUrl: config.gatewayUrl, triologueUrl: config.triologueUrl, token: config.byoaToken, log });
  const server = new ChannelServer({ config, gateway, log });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `${signal}, shutting down`);
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    server.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Claude Code closes stdin when it exits; that is when the gateway session ends.
  process.stdin.on('close', () => shutdown('stdin closed'));

  await server.start();
  if (config.allowedSenders.size === 0) {
    log('warn', 'ALLOWED_SENDERS is empty: every room message is dropped until a Triologue user id or username is listed');
  }
  log('info', `channel ready (gateway ${config.gatewayUrl}, allowed senders: ${config.allowedSenders.size}, rooms bound at start: ${config.rooms.length})`);
}

main().catch((err) => {
  process.stderr.write(`[triologue-channel] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
