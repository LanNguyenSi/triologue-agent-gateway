#!/usr/bin/env node
/**
 * Entrypoint: Claude Code spawns this over stdio (see .mcp.json). Logs go to
 * stderr; stdout is the MCP transport and must stay clean.
 */
import { loadConfig } from './config.js';
import { GatewayClient } from './gateway.js';
import { ChannelServer } from './server.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

async function main(): Promise<void> {
  const config = loadConfig();
  const threshold = LEVELS[config.logLevel];
  const log = (level: keyof typeof LEVELS, message: string) => {
    if (LEVELS[level] >= threshold) process.stderr.write(`[triologue-channel] ${level}: ${message}\n`);
  };
  const gateway = new GatewayClient({ gatewayUrl: config.gatewayUrl, triologueUrl: config.triologueUrl, token: config.byoaToken, log });
  const server = new ChannelServer({ config, gateway, log });

  const shutdown = (signal: string) => {
    log('info', `${signal}, shutting down`);
    server.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Claude Code closes stdin when the session ends.
  process.stdin.on('close', () => shutdown('stdin closed'));

  await server.start();
  log('info', `channel ready (gateway ${config.gatewayUrl}, allowed senders: ${config.allowedSenders.size})`);
}

main().catch((err) => {
  process.stderr.write(`[triologue-channel] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
