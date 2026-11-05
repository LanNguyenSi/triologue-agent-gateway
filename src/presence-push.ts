/**
 * Presence push: turns the session registry's state into Triologue's
 * `POST /api/agents/me/presence` calls, so the room participant list shows
 * what an agent's sessions are doing.
 *
 * One call per agent, with the agent's own token: the "best" status across
 * its live sessions (an approval wait beats an error beats work beats idle),
 * the host and project of that session and the number of live sessions.
 * Pushes are debounced per agent (a burst of status changes becomes one
 * call) and repeated on every refresh so Triologue's TTL stays alive while
 * sessions exist; `offline` is sent once when the last session is gone.
 * Every push is best effort: a failure is logged and the next event or
 * refresh tries again.
 */

import type { AgentSession, SessionRegistry, SessionStatus } from './sessions.js';

export interface PresenceBody {
  status: SessionStatus | 'offline';
  sessionId: string | null;
  host: string | null;
  project: string | null;
  detail: string | null;
  sessions: number;
  ttlSeconds: number;
}

/** Longer than two refresh intervals, so one missed refresh does not flicker. */
export const PRESENCE_TTL_SECONDS = 120;
export const PRESENCE_DEBOUNCE_MS = 500;

const RANK: Record<SessionStatus, number> = { online: 1, working: 2, error: 3, waiting_approval: 4 };

/** The one status Triologue shows for an agent with these live sessions. */
export function aggregatePresence(sessions: AgentSession[]): PresenceBody {
  if (sessions.length === 0) {
    return { status: 'offline', sessionId: null, host: null, project: null, detail: null, sessions: 0, ttlSeconds: PRESENCE_TTL_SECONDS };
  }
  const best = [...sessions].sort((a, b) => RANK[b.status] - RANK[a.status] || a.lastHeartbeat.localeCompare(b.lastHeartbeat))[0];
  return {
    status: best.status,
    sessionId: best.sessionId,
    host: best.host,
    project: best.project,
    detail: best.detail,
    sessions: sessions.length,
    ttlSeconds: PRESENCE_TTL_SECONDS,
  };
}

export interface PresencePusherDeps {
  registry: SessionRegistry;
  /** The agent's current bearer token, null when the agent is unknown. */
  tokenForAgent: (agentId: string) => string | null;
  /** Perform the HTTP call; rejects on failure. */
  post: (token: string, body: PresenceBody) => Promise<void>;
  debounceMs?: number;
  log?: (message: string) => void;
}

export class PresencePusher {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastStatus = new Map<string, PresenceBody['status']>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private stopped = false;
  private readonly onPresence = (event: { agentId: string }) => this.schedule(event.agentId);

  constructor(private readonly deps: PresencePusherDeps) {
    deps.registry.on('presence', this.onPresence);
  }

  /** Push the agent's aggregate soon; several events in the window become one call. */
  schedule(agentId: string): void {
    if (this.stopped) return;
    const existing = this.timers.get(agentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(agentId);
      void this.push(agentId);
    }, this.deps.debounceMs ?? PRESENCE_DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  /** Push the agent's aggregate now. Resolves when the attempt is over; never rejects. */
  push(agentId: string): Promise<void> {
    const running = this.inFlight.get(agentId);
    if (running) return running;
    const attempt = this.pushNow(agentId).finally(() => this.inFlight.delete(agentId));
    this.inFlight.set(agentId, attempt);
    return attempt;
  }

  /** Re-push every agent that has or had sessions, keeping Triologue's TTL alive. */
  async refreshAll(): Promise<void> {
    if (this.stopped) return;
    for (const agentId of await this.deps.registry.agents()) {
      await this.push(agentId);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.deps.registry.off('presence', this.onPresence);
  }

  private async pushNow(agentId: string): Promise<void> {
    try {
      const body = aggregatePresence(await this.deps.registry.list(agentId));
      if (body.status === 'offline' && this.lastStatus.get(agentId) === 'offline') return;
      const token = this.deps.tokenForAgent(agentId);
      if (!token) {
        this.deps.log?.(`[presence] no current token for agent ${agentId}, skipped`);
        return;
      }
      await this.deps.post(token, body);
      this.lastStatus.set(agentId, body.status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`[presence] push for agent ${agentId} failed: ${message}`);
    }
  }
}
