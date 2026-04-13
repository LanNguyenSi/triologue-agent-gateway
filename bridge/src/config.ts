/**
 * Minimal config loader for the bridge daemon. Reads env vars and a
 * couple of optional CLI flags. Intentionally zero-dep — no zod, no
 * commander — because the bridge runs on user machines and every
 * extra transitive dep is a new footgun.
 */

export interface BridgeConfig {
  /** Base URL of the gateway, e.g. https://opentriologue.ai/gateway. */
  gatewayUrl: string;
  /** BYOA token for the agent this bridge is driving. */
  byoaToken: string;
  /** Command invoked for each Claude run. Defaults to `claude`. */
  claudeCmd: string;
  /**
   * Optional comma-separated list of allowed room IDs. When set, the
   * bridge only acts on messages in these rooms — useful for pinning
   * a dev instance to one test room.
   */
  roomAllowlist: Set<string> | null;
  /**
   * Maximum time (ms) a Claude run is allowed to take before the
   * bridge kills it. Defaults to 2 minutes.
   */
  claudeTimeoutMs: number;
  /** Log verbosity. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `Missing required env var: ${name}. See bridge/README.md for the full config surface.`,
    );
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function parseRoomAllowlist(raw: string | undefined): Set<string> | null {
  if (!raw || raw.length === 0) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

function parseLogLevel(raw: string): BridgeConfig['logLevel'] {
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

export function loadConfig(): BridgeConfig {
  const gatewayUrl = required('GATEWAY_URL').replace(/\/$/, '');
  const byoaToken = required('BYOA_TOKEN');
  const claudeCmd = optional('CLAUDE_CMD', 'claude');
  const roomAllowlist = parseRoomAllowlist(process.env.ROOM_ALLOWLIST);
  const claudeTimeoutMs = Number(optional('CLAUDE_TIMEOUT_MS', '120000'));
  const logLevel = parseLogLevel(optional('LOG_LEVEL', 'info'));

  if (!Number.isFinite(claudeTimeoutMs) || claudeTimeoutMs <= 0) {
    throw new Error(
      `CLAUDE_TIMEOUT_MS must be a positive integer (got: ${process.env.CLAUDE_TIMEOUT_MS})`,
    );
  }

  return {
    gatewayUrl,
    byoaToken,
    claudeCmd,
    roomAllowlist,
    claudeTimeoutMs,
    logLevel,
  };
}
