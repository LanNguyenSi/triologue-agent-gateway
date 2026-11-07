---
type: module
title: Agent sessions, registry, bindings and expiry
description: A session is one running agent runtime speaking for one agent token, registered through /byoa/sessions, kept in Redis as a hash with a 90-second TTL that connect, heartbeat and presence refresh in one MULTI with the write, with room and thread bindings in reverse-lookup sets that lazy reads and a 30-second sweep prune once the hash has expired and that are capped per session; every prune re-checks the hash so a reconnect is not undone, a heartbeat cannot resurrect an expired hash, every route is guarded against a rejected store call, the presence push folds the live sessions into the one status Triologue shows for the agent, and the API scopes every call to the token's own agent and rate-limits it apart from message sends.
tags: [sessions, presence, redis, bindings, routing]
timestamp: 2026-11-05T07:17:39Z
sources:
  - src/sessions.ts
  - src/presence-push.ts
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
  the other way round, and a hash never exists without its TTL.

A session is one running agent runtime (a Claude Code terminal, a Codex
app-server thread, an opencode server) speaking for one agent token. It
registers through `POST /byoa/sessions/connect`
(`src/sessions.ts:522#"router.post('/connect', authenticate, guarded(async (req, res) => {"`).
The hash (runtime, host, working directory, status, start time, last
heartbeat), its TTL and the membership in the agent's session set are
written in one `MULTI`, so a failure between the write and the TTL cannot
leave a hash that never expires
(`src/sessions.ts:163-167#".sadd(AGENTS_KEY, agentId)"`). A client that sends its
own `sessionId` again refreshes the session, keeping the recorded start
time and status
(`src/sessions.ts:148#"const status: SessionStatus = isStatus(existing.status) ? existing.status : 'online';"`)
and adding the given rooms and threads to the existing bindings; a
`sessionId` whose hash has expired starts over, and the bindings its
predecessor left behind are dropped first
(`src/sessions.ts:144#"if (!existing.sessionId) await this.dropBindings(agentId, sessionId);"`).
The registry is one `SessionRegistry` over a Redis client that `src/index.ts`
creates next to the two of `byoa-sse.ts`
(`src/index.ts:95#"const sessionRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {"`)
and mounts under `/byoa/sessions`
(`src/index.ts:101#"app.use('/byoa/sessions', createSessionsRouter(sessionRegistry));"`).

## Keys and expiry

The hash carries a TTL of `SESSION_TTL_SECONDS`
(`src/sessions.ts:31#"export const SESSION_TTL_SECONDS = 90;"`), set on connect
and set again by `heartbeat` and by `setPresence`, which is a heartbeat with
a status; both go through `touch`, which writes the fields and the TTL in
one `MULTI` and then reads the hash back: a hash that expired between the
check and the write would come back holding only the written fields, so
that case deletes the stub, prunes the session and answers false instead
of resurrecting it
(`src/sessions.ts:325#"private async touch(agentId: string, sessionId: string, fields: Record<string, string>): Promise<boolean> {"`).
Clients are told to send one every `HEARTBEAT_SECONDS`
(`src/sessions.ts:32#"export const HEARTBEAT_SECONDS = 30;"`), so three missed
heartbeats end a session.

Around the hash:

- `sessions:<agentId>`, the agent's session ids, and `sessions:agents`, the
  agents the sweep visits; the latter is never shrunk, it is bounded by the
  number of agents and a shrink would race a concurrent connect
  (`src/sessions.ts:120#"const AGENTS_KEY = 'sessions:agents';"`).
- `sessbind:<agentId>:<sessionId>`, the session's own bindings as
  `room:<id>` and `thread:<id>` members, without a TTL so they can still be
  undone after the hash expired
  (`src/sessions.ts:121#"const sessBindKey = (agentId: string, sessionId: string) =>"`).
- `bind:room:<roomId>:<agentId>` and `bind:thread:<threadId>:<agentId>`, the
  reverse lookups a router reads
  (`src/sessions.ts:122-123#"const threadBindKey = (threadId: string, agentId: string) =>"`).

`bind` refuses an unknown session with null, writes both sides in one
`MULTI`, and re-checks the hash afterwards: a session that ended during the
write has its bindings dropped again and gets null, so no binding outlives
the hash unseen
(`src/sessions.ts:202#"async bind(agentId: string, sessionId: string, rooms: string[], threads: string[]): Promise<{ rooms: string[]; threads: string[] } | null> {"`).
One session holds at most `MAX_SESSION_BINDINGS` rooms and threads; a bind
that would exceed it throws `BindingLimitError`, which the API answers as
400 (`src/sessions.ts:35#"export const MAX_SESSION_BINDINGS = 200;"`,
`src/sessions.ts:210#"if (current.size + added.length > MAX_SESSION_BINDINGS) throw new BindingLimitError();"`).

Pruning happens in two places. Every read that lists sessions, `list`,
`sessionsForRoom` and `sessionsForThread`, checks the hash of each member
and drops a member whose hash is gone
(`src/sessions.ts:275#"async list(agentId: string): Promise<AgentSession[]> {"`,
`src/sessions.ts:368#"private async liveMembers(agentId: string, key: string): Promise<string[]> {"`).
The sweep does the same for every agent in `sessions:agents`
(`src/sessions.ts:306#"async sweep(): Promise<number> {"`); `src/index.ts`
runs it every `SWEEP_INTERVAL_MS`
(`src/sessions.ts:33#"export const SWEEP_INTERVAL_MS = 30_000;"`,
`src/index.ts:742#"const sweepTimer = setInterval(() => {"`) and clears the
timer and disconnects the client on shutdown
(`src/index.ts:759#"sessionRedis.disconnect();"`). Both paths end in the same
private `expire`, which re-checks the hash right before it acts (a session
that reconnected with the same id in the meantime keeps its fresh
bindings), then drops the bindings, leaves the session set and announces
`offline`
(`src/sessions.ts:360#"private async expire(agentId: string, sessionId: string): Promise<boolean> {"`).
`remove` (an explicit end, also `status: 'offline'` over HTTP) deletes the
hash and the set entry in one `MULTI` and then drops the bindings
(`src/sessions.ts:243#"async remove(agentId: string, sessionId: string): Promise<boolean> {"`).
The re-check narrows the prune-versus-reconnect race to the moment between
the check and the removals; it does not close it, since the registry uses
no Lua script.

## Presence events

The registry is an `EventEmitter`; `connect`, `setPresence`, `remove` and
`expire` emit `presence` with the agent, the session, the status and the
session snapshot (null once it is gone)
(`src/sessions.ts:93-99#"session: AgentSession | null;"`). `src/presence-push.ts`
listens: `PresencePusher` debounces per agent, folds the agent's live
sessions into one status (an approval wait beats an error beats work beats
idle; that session's host and project and the number of live sessions go
along), posts it to Triologue's `POST /api/agents/me/presence` with the
agent's current token, repeats it on every sweep so Triologue's 120-second
TTL stays alive, and sends `offline` once when the last session is gone
(`src/presence-push.ts:35#"export function aggregatePresence(sessions: AgentSession[]): PresenceBody {"`,
`src/presence-push.ts:137#"if (body.status === 'offline' && this.lastStatus.get(agentId) === 'offline') return;"`,
`src/index.ts:746#"return presencePusher.refreshAll();"`). A failed push is logged
and the next event or refresh tries again; the pusher never throws into
the registry. The token comes from the agent index
(`src/auth.ts:176#"export function getCurrentTokenForAgent(agentUserId: string): string | null {"`),
so an agent the gateway no longer knows is skipped. The delivery side,
how loop 2 in `src/index.ts` uses the bindings and `?session=` on a stream,
is in [message-delivery-routing.md](message-delivery-routing.md).

## The API and its limits

Every route runs inside `guarded`, because Express 4 does not catch a
rejected async handler and the rejection would end the process: a failed
store call answers 500 `Session store unavailable`, a `BindingLimitError`
answers 400 (`src/sessions.ts:465#"function guarded(handler: AsyncHandler) {"`).

The router copies the bearer check of `/byoa/sse`: no or malformed header
and unknown token are 401, an agent whose status is not `active` is 403
(`src/sessions.ts:494#"metrics.recordAuthFailure('Sessions: Agent not active');"`).
Every call then counts against a window of its own, 120 per minute per
agent, apart from the message limiter
(`src/sessions.ts:388#"const MAX_CALLS_PER_WINDOW = 120;"`); the window
counter is the `consumeWindow` that used to live in `byoa-sse.ts` and now
sits in `src/rate-window.ts`
(`src/rate-window.ts:13#"export function consumeWindow("`,
`src/byoa-sse.ts:24#"import { consumeWindow } from './rate-window.js';"`).

The agent id is always the token's user id
(`src/sessions.ts:511#"const agentOf = (req: Request): AgentInfo => (req as Request & { agent: AgentInfo }).agent;"`);
a session of another agent, an expired one and an id outside
`[A-Za-z0-9_-]{1,64}` all answer 404 `Unknown session`, so the API never
reveals whether a foreign session exists
(`src/sessions.ts:384#"const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;"`).
Bodies are bounded: at most 50 room or thread ids per call, each matching
`[A-Za-z0-9_-]{1,128}`
(`src/sessions.ts:385#"const BINDING_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;"`),
`runtime` 32, `host` 255, `cwd` 1024, `project` 255, `claudeSessionId` 128
and `detail` 500 characters. `status` is one of `online`, `working`,
`waiting_approval`, `error`
(`src/sessions.ts:37#"export const SESSION_STATUSES = ['online', 'working', 'waiting_approval', 'error'] as const;"`)
or `offline`, which ends the session
(`src/sessions.ts:548#"if (status === 'offline') {"`).

## What breaks it

- Writing a binding without the hash check in `bind`, or dropping the
  re-check after the write, makes a dead session routable until the next
  sweep.
- Giving `sessbind:*` a TTL loses the reverse bindings of an expired
  session: the sweep could no longer undo them.
- Splitting the hash write and its `expire` out of the `MULTI` reopens the
  immortal-hash case the sweep cannot see.
- Dropping the read-back in `touch` lets a heartbeat recreate an expired
  hash as a stub that lists as dead but answers 204 forever.
- Reading `agentId` from the body instead of the token lets one agent
  bind or end another agent's sessions.
- Registering a route without `guarded` turns the next Redis blip into a
  process exit.
