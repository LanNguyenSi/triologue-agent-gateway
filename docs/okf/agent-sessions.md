---
type: module
title: Agent sessions, registry, bindings and expiry
description: A session is one running agent runtime speaking for one agent token, registered through /byoa/sessions, kept in Redis as a hash with a 90-second TTL that connect, heartbeat and presence refresh, with room and thread bindings in reverse-lookup sets that lazy reads and a 30-second sweep prune once the hash has expired; the registry emits presence events that nothing consumes yet, and the sessions API scopes every call to the token's own agent and rate-limits it apart from message sends.
tags: [sessions, presence, redis, bindings, routing]
timestamp: 2026-11-05T06:36:21Z
sources:
  - src/sessions.ts
  - src/rate-window.ts
  - src/byoa-sse.ts
  - src/index.ts
---

# Agent sessions, registry, bindings and expiry

## The invariant

- A session exists exactly as long as its Redis hash
  `session:<agentId>:<sessionId>` exists. Everything else about it (its
  place in the agent's session set, its bindings and their reverse
  lookups) is derived state that is pruned when the hash is gone, never
  the other way round.

A session is one running agent runtime (a Claude Code terminal, a Codex
app-server thread, an opencode server) speaking for one agent token. It
registers through `POST /byoa/sessions/connect`
(`src/sessions.ts:403#"router.post('/connect', authenticate, async (req, res) => {"`),
which creates the hash with the runtime, host, working directory, status
`online` and the start time, or refreshes an existing one when the client
sends its own `sessionId` again, keeping the recorded start time and status
(`src/sessions.ts:105-108#"const status: SessionStatus = isStatus(existing.status) ? existing.status : 'online';"`).
The registry is one `SessionRegistry` over a Redis client that `src/index.ts`
creates next to the two of `byoa-sse.ts`
(`src/index.ts:90#"const sessionRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');"`)
and mounts under `/byoa/sessions`
(`src/index.ts:93#"app.use('/byoa/sessions', createSessionsRouter(sessionRegistry));"`).

## Keys and expiry

The hash carries a TTL of `SESSION_TTL_SECONDS`
(`src/sessions.ts:32#"export const SESSION_TTL_SECONDS = 90;"`), set on connect
and set again by `heartbeat`
(`src/sessions.ts:137#"async heartbeat(agentId: string, sessionId: string): Promise<boolean> {"`)
and by `setPresence`, which is a heartbeat with a status
(`src/sessions.ts:146#"async setPresence(agentId: string, sessionId: string, status: SessionStatus, detail: string | null = null): Promise<boolean> {"`).
Clients are told to send one every `HEARTBEAT_SECONDS`
(`src/sessions.ts:33#"export const HEARTBEAT_SECONDS = 30;"`), so three missed
heartbeats end a session.

Around the hash:

- `sessions:<agentId>`, the agent's session ids, and `sessions:agents`, the
  agents the sweep visits
  (`src/sessions.ts:88#"const AGENTS_KEY = 'sessions:agents';"`).
- `sessbind:<agentId>:<sessionId>`, the session's own bindings as
  `room:<id>` and `thread:<id>` members, without a TTL so they can still be
  undone after the hash expired
  (`src/sessions.ts:89#"const sessBindKey = (agentId: string, sessionId: string) =>"`).
- `bind:room:<roomId>:<agentId>` and `bind:thread:<threadId>:<agentId>`, the
  reverse lookups a router reads
  (`src/sessions.ts:90-91#"const threadBindKey = (threadId: string, agentId: string) =>"`).

`bind` and `unbind` write both sides and refuse an unknown session with
null (`src/sessions.ts:157#"async bind(agentId: string, sessionId: string, rooms: string[], threads: string[]): Promise<{ rooms: string[]; threads: string[] } | null> {"`).

Pruning happens in two places. Every read that lists sessions, `list`,
`sessionsForRoom` and `sessionsForThread`, checks the hash of each member
and drops a member whose hash is gone
(`src/sessions.ts:218#"async list(agentId: string): Promise<AgentSession[]> {"`,
`src/sessions.ts:278#"private async liveMembers(agentId: string, key: string): Promise<string[]> {"`).
The sweep does the same for every agent in `sessions:agents` and forgets
agents without sessions
(`src/sessions.ts:240#"async sweep(): Promise<number> {"`); `src/index.ts`
runs it every `SWEEP_INTERVAL_MS`
(`src/sessions.ts:34#"export const SWEEP_INTERVAL_MS = 30_000;"`,
`src/index.ts:696#"const sweepTimer = setInterval(() => {"`) and clears the
timer and disconnects the client on shutdown
(`src/index.ts:710#"sessionRedis.disconnect();"`). Both paths end in the same
private `expire`, which drops the bindings, leaves the session set and
announces `offline`
(`src/sessions.ts:272#"private async expire(agentId: string, sessionId: string): Promise<void> {"`).
`remove` (an explicit end, also `status: 'offline'` over HTTP) does the
same and additionally deletes the hash
(`src/sessions.ts:185#"async remove(agentId: string, sessionId: string): Promise<boolean> {"`).

## Presence events

The registry is an `EventEmitter`; `connect`, `setPresence`, `remove` and
`expire` emit `presence` with the agent, the session, the status and the
session snapshot (null once it is gone)
(`src/sessions.ts:69-75#"session: AgentSession | null;"`). Nothing in the
gateway listens yet: the push of this presence to Triologue is a later
change, and session-aware routing in `src/index.ts` is another; today the
delivery loops described in
[message-delivery-routing.md](message-delivery-routing.md) ignore sessions.

## The API and its limits

The router copies the bearer check of `/byoa/sse`: no or malformed header
and unknown token are 401, an agent whose status is not `active` is 403
(`src/sessions.ts:375#"metrics.recordAuthFailure('Sessions: Agent not active');"`).
Every call then counts against a window of its own, 120 per minute per
agent, apart from the message limiter
(`src/sessions.ts:297#"const MAX_CALLS_PER_WINDOW = 120;"`); the window
counter is the `consumeWindow` that used to live in `byoa-sse.ts` and now
sits in `src/rate-window.ts`
(`src/rate-window.ts:13#"export function consumeWindow("`,
`src/byoa-sse.ts:24#"import { consumeWindow } from './rate-window.js';"`).

The agent id is always the token's user id
(`src/sessions.ts:392#"const agentOf = (req: Request): AgentInfo => (req as Request & { agent: AgentInfo }).agent;"`);
a session of another agent, an expired one and an id outside
`[A-Za-z0-9_-]{1,64}` all answer 404 `Unknown session`, so the API never
reveals whether a foreign session exists
(`src/sessions.ts:294#"const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;"`).
Bodies are bounded: at most 50 rooms or threads per call
(`src/sessions.ts:295#"const MAX_BINDINGS = 50;"`), `runtime` 32, `host` 255,
`cwd` 1024, `project` 255, `claudeSessionId` 128 and `detail` 500
characters. `status` is one of `online`, `working`, `waiting_approval`,
`error` (`src/sessions.ts:36#"export const SESSION_STATUSES = ['online', 'working', 'waiting_approval', 'error'] as const;"`)
or `offline`, which ends the session
(`src/sessions.ts:439#"if (status === 'offline') {"`).

## What breaks it

- Writing a binding without the hash check in `bind` makes a dead session
  routable until the next sweep.
- Giving `sessbind:*` a TTL loses the reverse bindings of an expired
  session: the sweep could no longer undo them.
- Reading `agentId` from the body instead of the token lets one agent
  bind or end another agent's sessions.
