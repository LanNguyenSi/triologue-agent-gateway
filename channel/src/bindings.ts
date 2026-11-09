/**
 * Which session answers a room. The gateway delivers a room's messages to
 * every session of the agent that is bound to it, so with two terminals bound
 * to the same room both would answer. The rule here: of the sessions bound to
 * a room, only the most recently bound one delivers the room's messages to its
 * Claude Code session; the others drop them (they still take the permission
 * verdicts for their own prompts). Binding again makes a session the most
 * recent; when the most recent one disconnects the room or exits, the next
 * most recent one that is still bound answers again.
 *
 * The order lives in the state directory, so it covers the sessions that
 * share it (same user, same machine): one file per agent, room and session,
 * `<dir>/<roomId>/<instance>.json`, holding the bind time. The server writes
 * a session's entries only once the gateway knows the session, or at once
 * against a gateway without the sessions API, where no gateway session ever
 * exists (server.ts, activate). Both directories are kept at mode 0700; an
 * existing one that others may enter is narrowed with a warning, and when that
 * fails no entry is written there. A process writes only its own files and
 * removes its own on unbind and exit; reading a room's entries, it also
 * removes those of a process that no longer exists and those under its own
 * pid with another instance id (a dead predecessor whose pid came round
 * again). Another session's entry counts while its process exists and it has
 * been refreshed within BINDING_STALE_MS of the newest entry of the room; so
 * a session that crashed and whose pid was reused stops counting once the
 * live ones have refreshed past it.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Log } from './gateway.js';
import { privateDir } from './presence.js';

/** How often a session touches its own entries. */
export const BINDING_REFRESH_MS = 30_000;
/** An entry this much older than the newest entry of its room no longer counts. */
export const BINDING_STALE_MS = 4 * BINDING_REFRESH_MS;

/** Room ids the gateway accepts for a binding; anything else never becomes a path segment. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ENTRY_FILE_RE = /^[0-9]+-[0-9a-f]{8}\.json$/;

export interface BindingEntry {
  instance: string;
  pid: number;
  sessionId: string | null;
  boundAt: number;
}

/** Where the order of one agent's bindings lives: keyed by a hash of the token, never the token. */
export function bindingDir(stateDir: string, token: string): string {
  const agentKey = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
  return path.join(stateDir, 'bindings', agentKey);
}

/** Whether a process exists (EPERM: it exists but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface BindingOrderOptions {
  dir: string;
  /** Test seams. */
  instance?: string;
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  log?: Log;
}

export class BindingOrder {
  readonly instance: string;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  /** roomId -> this session's bind time. */
  private readonly own = new Map<string, number>();
  private sessionId: string | null = null;
  private lastBoundAt = 0;
  private lastRefreshAt = 0;

  constructor(private readonly opts: BindingOrderOptions) {
    this.pid = opts.pid ?? process.pid;
    this.instance = opts.instance ?? `${this.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.now = opts.now ?? Date.now;
    this.isAlive = opts.isAlive ?? isProcessAlive;
  }

  /** The gateway session id, recorded in the entries (for `status` and debugging). */
  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  /** Bind (or bind again): this session becomes the most recent one for the room. */
  bind(roomId: string): void {
    // Strictly increasing, so two binds in the same millisecond keep their order.
    const boundAt = Math.max(this.now(), this.lastBoundAt + 1);
    this.lastBoundAt = boundAt;
    this.own.set(roomId, boundAt);
    this.lastRefreshAt = this.now();
    this.writeEntry(roomId, boundAt);
  }

  unbind(roomId: string): void {
    this.own.delete(roomId);
    const file = this.entryFile(roomId);
    if (file) removeQuietly(file);
  }

  /** Drop every binding of this session (shutdown). */
  clear(): void {
    for (const roomId of [...this.own.keys()]) this.unbind(roomId);
  }

  /** Touch this session's entries so the other sessions keep counting them. */
  refresh(): void {
    this.lastRefreshAt = this.now();
    const at = new Date(this.lastRefreshAt);
    for (const roomId of this.own.keys()) {
      const file = this.entryFile(roomId);
      if (!file) continue;
      try {
        fs.utimesSync(file, at, at);
      } catch {
        // Gone (removed by hand?): write it again with the same bind time.
        this.writeEntry(roomId, this.own.get(roomId)!);
      }
    }
  }

  /** Whether this session answers the room: bound here, and no live session on this machine bound it later. */
  answers(roomId: string): boolean {
    const mine = this.own.get(roomId);
    if (mine === undefined) return false;
    return this.newer(roomId, mine).length === 0;
  }

  /** The live sessions that bound the room after this one (empty when this one answers or is not bound). */
  newerSessions(roomId: string): BindingEntry[] {
    const mine = this.own.get(roomId);
    return mine === undefined ? [] : this.newer(roomId, mine);
  }

  private newer(roomId: string, mine: number): BindingEntry[] {
    const others = this.readOthers(roomId);
    const newest = Math.max(this.lastRefreshAt, ...others.map((o) => o.mtimeMs));
    return others
      .filter((o) => o.mtimeMs >= newest - BINDING_STALE_MS)
      .filter((o) => o.entry.boundAt > mine || (o.entry.boundAt === mine && o.entry.instance > this.instance))
      .map((o) => o.entry);
  }

  /** The other sessions' entries for the room whose process exists; entries of a dead process are removed. */
  private readOthers(roomId: string): Array<{ entry: BindingEntry; mtimeMs: number }> {
    if (!ROOM_ID_RE.test(roomId)) return [];
    const dir = path.join(this.opts.dir, roomId);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: Array<{ entry: BindingEntry; mtimeMs: number }> = [];
    for (const name of names) {
      if (!ENTRY_FILE_RE.test(name) || name === `${this.instance}.json`) continue;
      const file = path.join(dir, name);
      try {
        const mtimeMs = fs.statSync(file).mtimeMs;
        const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as BindingEntry;
        if (!Number.isInteger(entry.pid) || entry.pid <= 0 || typeof entry.boundAt !== 'number') continue;
        // An entry under this process's own pid but another instance is a dead
        // predecessor whose pid came round again.
        if (entry.pid === this.pid || !this.isAlive(entry.pid)) {
          removeQuietly(file);
          continue;
        }
        out.push({ entry, mtimeMs });
      } catch {
        // Unreadable or half-written by hand: not an entry.
      }
    }
    return out;
  }

  private writeEntry(roomId: string, boundAt: number): void {
    const file = this.entryFile(roomId);
    if (!file) return;
    const entry: BindingEntry = { instance: this.instance, pid: this.pid, sessionId: this.sessionId, boundAt };
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      // An existing directory keeps its mode under mkdir: narrow one that other
      // users may enter, or write no entry (privateDir throws when it cannot).
      for (const dir of [this.opts.dir, path.dirname(file)]) {
        const narrowed = privateDir(dir);
        if (narrowed !== null) this.opts.log?.('warn', `${dir} was open to other users (mode ${narrowed.toString(8).padStart(3, '0')}); narrowed it to 700`);
      }
      fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file);
    } catch (err) {
      removeQuietly(tmp);
      this.opts.log?.('warn', `could not record the binding of room ${roomId}, other sessions on this machine will not see it: ${errorMessage(err)}`);
    }
  }

  private entryFile(roomId: string): string | null {
    if (!ROOM_ID_RE.test(roomId)) return null;
    return path.join(this.opts.dir, roomId, `${this.instance}.json`);
  }
}

function removeQuietly(file: string): void {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
