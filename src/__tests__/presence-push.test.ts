/**
 * Tests for src/presence-push.ts: the aggregate one agent reports to
 * Triologue and the pusher's debounce, refresh, offline-once and
 * best-effort behaviour, against a fake registry (an EventEmitter with
 * list() and agents()) and a recording post().
 *
 * Mutation guards:
 *   M-rank: ranking by status order makes "picks the most urgent" fail
 *   M-once: pushing offline on every event makes "offline once" fail
 *   M-debounce: pushing per event makes "debounces" fail
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../sessions.js';
import { aggregatePresence, PresencePusher, PRESENCE_TTL_SECONDS } from '../presence-push.js';

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    sessionId: 's1', agentId: 'agent-a', runtime: 'claude', host: 'mac-studio-01', cwd: '/p', project: 'evidence-api',
    claudeSessionId: null, status: 'online', detail: null, startedAt: '2026-11-05T07:00:00.000Z',
    lastHeartbeat: '2026-11-05T07:00:00.000Z', rooms: [], threads: [], ...overrides,
  };
}

describe('aggregatePresence', () => {
  it('reports offline with no sessions', () => {
    expect(aggregatePresence([])).toEqual({ status: 'offline', sessionId: null, host: null, project: null, detail: null, sessions: 0, ttlSeconds: PRESENCE_TTL_SECONDS });
  });

  it('picks the most urgent session: waiting_approval over error over working over online (M-rank)', () => {
    const sessions = [
      session({ sessionId: 'idle', status: 'online', host: 'h-idle' }),
      session({ sessionId: 'busy', status: 'working', host: 'h-busy' }),
      session({ sessionId: 'wait', status: 'waiting_approval', host: 'h-wait', detail: 'Bash' }),
      session({ sessionId: 'err', status: 'error', host: 'h-err' }),
    ];
    expect(aggregatePresence(sessions)).toMatchObject({ status: 'waiting_approval', sessionId: 'wait', host: 'h-wait', detail: 'Bash', sessions: 4 });
    expect(aggregatePresence(sessions.filter((s) => s.sessionId !== 'wait'))).toMatchObject({ status: 'error', sessionId: 'err' });
    expect(aggregatePresence(sessions.filter((s) => s.status === 'online' || s.status === 'working'))).toMatchObject({ status: 'working', sessionId: 'busy' });
  });
});

class FakeRegistry extends EventEmitter {
  sessions = new Map<string, AgentSession[]>();
  list = vi.fn(async (agentId: string) => this.sessions.get(agentId) ?? []);
  agents = vi.fn(async () => [...this.sessions.keys()]);
}

let registry: FakeRegistry;
let post: ReturnType<typeof vi.fn<(token: string, body: unknown) => Promise<void>>>;
let log: ReturnType<typeof vi.fn<(message: string) => void>>;
let pusher: PresencePusher;

beforeEach(() => {
  vi.useFakeTimers();
  registry = new FakeRegistry();
  post = vi.fn<(token: string, body: unknown) => Promise<void>>().mockResolvedValue(undefined);
  log = vi.fn<(message: string) => void>();
  pusher = new PresencePusher({
    registry: registry as unknown as ConstructorParameters<typeof PresencePusher>[0]['registry'],
    tokenForAgent: (agentId) => (agentId === 'agent-a' ? 'tok-a' : null),
    post,
    log,
    debounceMs: 100,
  });
});

afterEach(() => {
  pusher.stop();
  vi.useRealTimers();
});

describe('PresencePusher', () => {
  it('debounces a burst of presence events into one post with the agent token (M-debounce)', async () => {
    registry.sessions.set('agent-a', [session({ status: 'working' })]);

    registry.emit('presence', { agentId: 'agent-a' });
    registry.emit('presence', { agentId: 'agent-a' });
    registry.emit('presence', { agentId: 'agent-a' });
    await vi.advanceTimersByTimeAsync(150);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('tok-a', expect.objectContaining({ status: 'working', host: 'mac-studio-01', project: 'evidence-api', sessions: 1 }));
  });

  it('posts offline once when the sessions are gone, then stays quiet until something is live again (M-once)', async () => {
    registry.sessions.set('agent-a', [session({})]);
    await pusher.push('agent-a');
    registry.sessions.set('agent-a', []);

    await pusher.push('agent-a');
    await pusher.push('agent-a');
    await pusher.refreshAll();

    expect(post.mock.calls.map(([, body]) => (body as { status: string }).status)).toEqual(['online', 'offline']);

    registry.sessions.set('agent-a', [session({ status: 'working' })]);
    await pusher.push('agent-a');
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('skips agents without a current token and logs it', async () => {
    registry.sessions.set('agent-x', [session({ agentId: 'agent-x' })]);
    await pusher.push('agent-x');
    expect(post).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('agent-x'));
  });

  it('refreshAll re-posts every agent the registry knows, and a failed post is logged, not thrown', async () => {
    registry.sessions.set('agent-a', [session({})]);
    registry.sessions.set('agent-x', [session({ agentId: 'agent-x' })]);
    post.mockRejectedValueOnce(new Error('503'));

    await expect(pusher.refreshAll()).resolves.toBeUndefined();

    expect(post).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed: 503'));
    // The failure is not remembered as pushed: the next refresh tries again.
    await pusher.refreshAll();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('stop() drops pending timers and stops listening', async () => {
    registry.sessions.set('agent-a', [session({})]);
    registry.emit('presence', { agentId: 'agent-a' });
    pusher.stop();
    registry.emit('presence', { agentId: 'agent-a' });
    await vi.advanceTimersByTimeAsync(500);
    expect(post).not.toHaveBeenCalled();
  });
});
