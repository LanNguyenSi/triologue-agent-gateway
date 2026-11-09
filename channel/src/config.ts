/**
 * Configuration of the channel server. Zero-dependency on purpose: the server
 * runs on the user's machine as a Claude Code subprocess.
 *
 * Sources, later wins: `${STATE_DIR}/.env` (`KEY=value` lines, `#` comments),
 * then the process environment. In the environment every key is also read
 * with a `TRIOLOGUE_` prefix (`TRIOLOGUE_GATEWAY_URL`), and the keys whose
 * plain names other programs use too (`HOST`, `PROJECT`, `ROOMS`, `RUNTIME`,
 * `LOG_LEVEL`) are read from the environment only with the prefix, so a shell
 * that exports `HOST=0.0.0.0` does not change what the session reports.
 * The token is the exception: it is read from the file only, never from the
 * environment (Claude Code hands its whole environment to every stdio server),
 * and the file must not be readable or writable by anyone but its owner.
 * STATE_DIR is `CLAUDE_PLUGIN_DATA` when Claude Code runs the server as a
 * plugin, else `~/.claude/channels/triologue`, like the official channel
 * plugins.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ChannelConfig {
  /** Gateway base URL, e.g. https://opentriologue.ai/gateway. */
  gatewayUrl: string;
  /** Triologue base URL for the room list; defaults to gatewayUrl without a trailing /gateway. */
  triologueUrl: string;
  /** The agent's BYOA token. */
  byoaToken: string;
  /**
   * Who may push messages into the session and answer permission prompts:
   * Triologue user ids or usernames. Empty means nobody (fail closed).
   */
  allowedSenders: Set<string>;
  /** Deliver messages written by other agents (default: dropped). */
  allowAgents: boolean;
  /** Rooms to bind at start (ids); bindings can also be added with connect_room. */
  rooms: string[];
  runtime: string;
  host: string;
  cwd: string;
  project: string | null;
  /**
   * Claude Code's own session id: `CLAUDE_CODE_SESSION_ID` at start (Claude
   * Code sets it for the stdio servers it spawns, and the SessionStart hook
   * fires before this server listens), then whatever the hooks report.
   */
  claudeSessionId: string | null;
  /** Where the channel keeps its state (.env, session discovery files). */
  stateDir: string;
  /** Port of the local hook listener; 0 picks a free one. */
  presencePort: number;
  heartbeatSeconds: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Problems that do not stop the server; the entrypoint logs them. */
  warnings: string[];
}

/** Keys other programs set in a shell too; from the environment they count only as `TRIOLOGUE_<KEY>`. */
export const PREFIX_ONLY_IN_ENV = new Set(['HOST', 'PROJECT', 'ROOMS', 'RUNTIME', 'LOG_LEVEL']);

/** Names under which a token in the environment is ignored (and reported). */
export const TOKEN_KEYS = ['BYOA_TOKEN', 'TRIOLOGUE_BYOA_TOKEN'] as const;

/** The gateway accepts a Claude session id of at most this many characters. */
export const MAX_CLAUDE_SESSION_ID = 128;

/** A usable Claude session id (non-empty, within the gateway's limit), else null. */
export function claudeSessionIdFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_CLAUDE_SESSION_ID ? trimmed : null;
}

/**
 * Read the `.env` file of the state dir: no file is an empty config; a file
 * that the group or others may read or write is refused, because it holds
 * the token. The mode is read from the open descriptor, so the check and the
 * read see the same file. Windows has no such mode bits; the check is skipped
 * there.
 */
export function readEnvFile(file: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const mode = fs.fstatSync(fd).mode & 0o777;
    if (platform !== 'win32' && (mode & 0o077) !== 0) {
      throw new Error(`${file} holds the token and is open to other users (mode ${mode.toString(8).padStart(3, '0')}); run: chmod 600 "${file}"`);
    }
    return parseDotEnv(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_PLUGIN_DATA && env.CLAUDE_PLUGIN_DATA.length > 0
    ? env.CLAUDE_PLUGIN_DATA
    : path.join(os.homedir(), '.claude', 'channels', 'triologue');
}

/** Parse `KEY=value` lines; quotes around the value are stripped, `#` lines ignored. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function parseLogLevel(raw: string | undefined): ChannelConfig['logLevel'] {
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ChannelConfig {
  const stateDir = defaultStateDir(env);
  const envFile = path.join(stateDir, '.env');
  const fileValues = readEnvFile(envFile, platform);
  const warnings: string[] = [];
  const nonEmpty = (v: string | undefined): string | undefined => (v !== undefined && v !== '' ? v : undefined);
  const get = (key: string): string | undefined => {
    const prefixed = key.startsWith('TRIOLOGUE_') ? key : `TRIOLOGUE_${key}`;
    return nonEmpty(env[prefixed])
      ?? (PREFIX_ONLY_IN_ENV.has(key) ? undefined : nonEmpty(env[key]))
      ?? nonEmpty(fileValues[prefixed])
      ?? nonEmpty(fileValues[key]);
  };

  const gatewayUrl = (get('GATEWAY_URL') ?? '').replace(/\/+$/, '');
  if (!gatewayUrl) throw new Error('GATEWAY_URL is required (e.g. https://opentriologue.ai/gateway); set it in the environment or in ' + path.join(stateDir, '.env'));
  const ignoredTokens = TOKEN_KEYS.filter((key) => nonEmpty(env[key]) !== undefined);
  if (ignoredTokens.length > 0) {
    warnings.push(`${ignoredTokens.join(' and ')} in the environment ignored: the token is read only from ${envFile}`);
  }
  const byoaToken = nonEmpty(fileValues.TRIOLOGUE_BYOA_TOKEN) ?? nonEmpty(fileValues.BYOA_TOKEN) ?? '';
  if (!byoaToken) throw new Error('BYOA_TOKEN is required; put it in ' + envFile + ' with mode 600 (see /triologue:configure)');

  const triologueUrl = (get('TRIOLOGUE_URL') ?? gatewayUrl.replace(/\/gateway$/, '')).replace(/\/+$/, '');
  const cwd = nonEmpty(env.CLAUDE_PROJECT_DIR) ?? process.cwd();
  const heartbeatSeconds = Number(get('HEARTBEAT_SECONDS') ?? '30');
  const presencePort = Number(get('PRESENCE_PORT') ?? '0');

  return {
    gatewayUrl,
    triologueUrl,
    byoaToken,
    allowedSenders: new Set(parseList(get('ALLOWED_SENDERS')).map((s) => s.toLowerCase())),
    allowAgents: parseBool(get('ALLOW_AGENTS'), false),
    rooms: parseList(get('ROOMS')),
    runtime: get('RUNTIME') ?? 'claude',
    host: get('HOST') ?? os.hostname(),
    cwd,
    project: get('PROJECT') ?? (path.basename(cwd) || null),
    claudeSessionId: claudeSessionIdFrom(env.CLAUDE_CODE_SESSION_ID),
    stateDir,
    presencePort: Number.isInteger(presencePort) && presencePort >= 0 && presencePort <= 65535 ? presencePort : 0,
    heartbeatSeconds: Number.isFinite(heartbeatSeconds) && heartbeatSeconds >= 5 ? heartbeatSeconds : 30,
    logLevel: parseLogLevel(get('LOG_LEVEL')),
    warnings,
  };
}
