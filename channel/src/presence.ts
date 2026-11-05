/**
 * Presence: Claude Code hooks (SessionStart, UserPromptSubmit,
 * PermissionRequest, PreToolUse, Stop, StopFailure, PostToolUseFailure,
 * SessionEnd) post their payload to a localhost listener this server opens;
 * the listener maps the event onto the session status the gateway
 * understands. The port is written to `${stateDir}/sessions/<claude-pid>.json`,
 * where the hook script finds it by its parent process id (the hook shell's
 * parent is Claude Code, and so is this server's).
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

export type SessionStatus = 'online' | 'working' | 'waiting_approval' | 'error';

/** A hook payload carries the whole tool input; a large Write still has to get through. */
export const MAX_HOOK_BODY_BYTES = 1024 * 1024;

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
  const claudeSessionId = typeof payload.session_id === 'string' && payload.session_id.length > 0 ? payload.session_id : null;
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

/** Start the localhost listener; resolves with the bound port. */
export async function startPresenceListener(opts: PresenceListenerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  } catch (err) {
    opts.log?.('warn', `could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    port,
    close: async () => {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
