/**
 * Presence: Claude Code hooks (SessionStart, UserPromptSubmit,
 * PermissionRequest, PreToolUse, Stop, StopFailure, PostToolUseFailure,
 * SessionEnd) post their payload to a localhost listener this server opens;
 * the listener maps the event onto the session status the gateway
 * understands. The port and a secret drawn at every start are written to
 * `${stateDir}/sessions/<claude-pid>.json` (mode 0600 from creation, in a
 * directory narrowed to 0700), where the hook script finds them by its parent
 * process id (the hook shell's parent is Claude Code, and so is this
 * server's) and nothing else: a hook of another Claude Code session never
 * posts here, and a file the user does not own is not used. A post without
 * that secret is refused, so another local user cannot set the session's
 * status.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { claudeSessionIdFrom } from './config.js';

export type SessionStatus = 'online' | 'working' | 'waiting_approval' | 'error';

/** A hook payload carries the whole tool input; a large Write still has to get through. */
export const MAX_HOOK_BODY_BYTES = 1024 * 1024;

/** The header the hook script sends the secret in (lower case, as Node reports headers). */
export const HOOK_SECRET_HEADER = 'x-triologue-hook-secret';

/** Bytes of randomness in the per-start secret. */
export const HOOK_SECRET_BYTES = 32;

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  [key: string]: unknown;
}

export interface PresenceChange {
  status: SessionStatus | 'offline';
  detail: string | null;
  claudeSessionId: string | null;
}

/** Which hook event means which status; events not listed change nothing. */
export function statusForHook(payload: HookPayload): PresenceChange | null {
  const claudeSessionId = claudeSessionIdFrom(payload.session_id);
  const tool = typeof payload.tool_name === 'string' && payload.tool_name.length > 0 ? payload.tool_name : null;
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return { status: 'online', detail: null, claudeSessionId };
    case 'UserPromptSubmit':
      return { status: 'working', detail: null, claudeSessionId };
    case 'PermissionRequest':
      return { status: 'waiting_approval', detail: tool, claudeSessionId };
    case 'PreToolUse':
      // A tool starting means the approval (if any) is behind us.
      return { status: 'working', detail: tool, claudeSessionId };
    case 'Stop':
      return { status: 'online', detail: null, claudeSessionId };
    case 'StopFailure':
    case 'PostToolUseFailure':
      return { status: 'error', detail: tool, claudeSessionId };
    case 'SessionEnd':
      // `/clear` and `/resume` end the Claude session and start a new one while
      // this server lives on, so the gateway session stays; it ends when Claude
      // Code closes stdin (index.ts). Idle until the next prompt.
      return { status: 'online', detail: null, claudeSessionId };
    default:
      return null;
  }
}

/**
 * Whether the header value is the secret. Both sides are hashed first, so
 * the comparison takes the same time whatever the given value's length or
 * content; a missing or repeated header never matches.
 */
export function secretMatches(given: string | string[] | undefined, secret: string): boolean {
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

export interface PresenceListenerOptions {
  stateDir: string;
  /** Claude Code's pid, the key of the discovery file. */
  claudePid: number;
  port?: number;
  onChange: (change: PresenceChange) => void;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export function discoveryFile(stateDir: string, claudePid: number): string {
  return path.join(stateDir, 'sessions', `${claudePid}.json`);
}

/**
 * Create the directory of the discovery files with mode 0700, or narrow an
 * existing one that the group or others may enter (mkdir leaves an existing
 * directory as it is): whoever may write into it could put a file of theirs
 * where the hook looks, and the hook would post its payload to their port.
 * Narrowing rather than warning: the directory holds only these files, which
 * nobody else needs, and a warning on the server's stderr is easily missed.
 * Returns the mode the directory had when it was narrowed, else null; throws
 * when it cannot narrow it (not the owner), so no discovery file is written
 * there. Windows has no such mode bits; nothing is checked there.
 */
export function privateDir(dir: string, platform: NodeJS.Platform = process.platform): number | null {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') return null;
  const mode = fs.statSync(dir).mode & 0o777;
  if ((mode & 0o077) === 0) return null;
  fs.chmodSync(dir, 0o700);
  return mode;
}

/**
 * Write the discovery file so that no other user can read it at any moment:
 * a fresh temporary file created exclusively with mode 0600 (the umask can
 * only narrow it) in a directory only the owner may enter (privateDir), then
 * renamed over the final name. A reader sees either the old file or the whole
 * new one. Returns what privateDir returned.
 */
export function writeDiscoveryFile(file: string, content: string): number | null {
  const dir = path.dirname(file);
  const narrowed = privateDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  return narrowed;
}

/** Start the localhost listener; resolves with the bound port. */
export async function startPresenceListener(opts: PresenceListenerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const secret = crypto.randomBytes(HOOK_SECRET_BYTES).toString('hex');
  const server = http.createServer((req, res) => {
    // Checked before anything else, the path included: without the secret the
    // answer is a bare 401, whatever was asked.
    if (!secretMatches(req.headers[HOOK_SECRET_HEADER], secret)) {
      res.writeHead(401, { Connection: 'close' }).end();
      req.resume();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_HOOK_BODY_BYTES) {
        tooLarge = true;
        body = '';
      }
    });
    req.on('end', () => {
      if (tooLarge) {
        res.writeHead(413).end();
        return;
      }
      let payload: HookPayload;
      try {
        payload = JSON.parse(body) as HookPayload;
      } catch {
        res.writeHead(400).end();
        return;
      }
      const change = statusForHook(payload);
      if (change) opts.onChange(change);
      res.writeHead(204).end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  const file = discoveryFile(opts.stateDir, opts.claudePid);
  try {
    const narrowed = writeDiscoveryFile(file, JSON.stringify({ port, secret, pid: process.pid, startedAt: new Date().toISOString() }));
    if (narrowed !== null) {
      opts.log?.('warn', `${path.dirname(file)} was open to other users (mode ${narrowed.toString(8).padStart(3, '0')}); narrowed it to 700`);
    }
  } catch (err) {
    opts.log?.('warn', `could not write ${file}, the hooks cannot report presence: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    port,
    close: async () => {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
