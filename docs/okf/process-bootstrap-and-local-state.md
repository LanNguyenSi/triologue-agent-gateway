---
type: module
title: Process bootstrap and local state
description: What importing src/index.ts already does (router mount order for the raw-body HMAC route, Redis clients, metrics timer), the module-is-main guard and its extensionless-invocation trap, the startup order from the GATEWAY_TOKEN check to listen, and where the gateway keeps local state, including under the Docker runtime user.
tags: [bootstrap, startup, entrypoint, local-state, redis, docker]
timestamp: 2026-10-11T17:08:47Z
sources:
  - src/index.ts
  - src/agent-tasks-bridge.ts
  - src/byoa-sse.ts
  - src/metrics.ts
  - src/openclaw-inject.ts
  - src/read-tracker.ts
  - src/triologue-bridge.ts
  - src/auth.ts
  - Dockerfile
---

# Process bootstrap and local state

## Responsibility

- `src/index.ts` wires the Express app, the WebSocket server and the
  Triologue bridge at import time and starts the process only when it is the
  entrypoint. It does not decide routing or authentication itself; those are
  in [message-delivery-routing.md](message-delivery-routing.md) and
  [agent-token-lifecycle-and-trust-boundary.md](agent-token-lifecycle-and-trust-boundary.md).

## Entry points

- `main()`, `src/index.ts`, guarded by `isMainModule`
  (`src/index.ts:719-722#"main();"`).
- `start()`, `src/index.ts`, called by `main()` after local state is loaded.
- Container: `node dist/index.js` (`Dockerfile:19#"dist/index.js"`).

## What importing src/index.ts already does

Importing the module, as the tests do to reach the exported `app`, runs these
steps without the guard:

- Mounts the agent-tasks bridge router before the global JSON parser
  (`src/index.ts:52-57#"app.use("`, `src/index.ts:73-75#"app.use(express.json());"`).
  The bridge route parses its own body with `express.raw`, so the HMAC check
  sees the exact bytes received
  (`src/agent-tasks-bridge.ts:230-234#"express.raw({ type: 'application/json', limit: '256kb' }),"`).
  Moving `express.json()` above it would consume the body first. Building
  the router logs a warning when the bridge is disabled or runs in unsigned
  mode (`src/agent-tasks-bridge.ts:220-227#"ALLOW_UNSIGNED=true , accepting"`).
- Mounts `/byoa/sse` and `/byoa/mcp` behind the JSON parser
  (`src/index.ts:78-82#"app.use('/byoa/mcp', mcpRouter);"`).
- Constructs the `TriologueBridge` without connecting it
  (`src/index.ts:101-105#"userType: 'AI_AGENT',"`) and attaches the
  WebSocket server at `/byoa/ws` to the HTTP server
  (`src/index.ts:510#"const wss = new WebSocketServer({ server, path: '/byoa/ws' });"`).
- Through its imports: opens two Redis clients for `REDIS_URL`, defaulting
  to `redis://localhost:6379` (`src/byoa-sse.ts:34-35#"const redisSub = new Redis("`);
  starts the metrics flush timer, which appends a snapshot every 60 seconds
  (`src/metrics.ts:46-65#"this.flushInterval = setInterval(() => this.flush(), 60_000);"`);
  and reads the OpenClaw config and device files once
  (`src/openclaw-inject.ts:24-27#"return cfg.gateway?.auth?.token as string;"`,
  `src/openclaw-inject.ts:33-35#"return JSON.parse(fs.readFileSync(openClawDevicePath(), 'utf-8'));"`).

## The module-is-main guard and its trap

`isMainModule` compares `process.argv[1]` with the module's own file path
(`src/index.ts:719-722#"main();"`). That path always carries its extension,
while `argv[1]` is the absolute path of what was typed, without extension
resolution, so `node dist/index` (without `.js`) never matches: `main()`
does not run, and the Redis clients opened at import keep the event loop
alive, so the process stays up without listening
(`src/index.ts:707-716#"Always invoke with the explicit"`). The Docker `CMD`
uses the explicit extension (`Dockerfile:19#"dist/index.js"`).

## Startup order

`main()` runs these steps in order:

1. Exits with code 1 when `GATEWAY_TOKEN` is unset
   (`src/index.ts:686-688#"process.exit(1);"`).
2. Loads `AGENTS_CONFIG`, builds the token index and loads the read tracker
   (`src/index.ts:691-693#"loadReadTracker();"`), then calls `start()`
   (`src/index.ts:695#"await start();"`).
3. `start()` connects the bridge: it authenticates, with a fresh login
   unless the cached session token is still valid
   (`src/triologue-bridge.ts:315-336#"// Fresh login"`), then
   opens the Socket.io connection
   (`src/triologue-bridge.ts:73-75#"await this.createSocket();"`), which
   rejects after 10 seconds without a connection
   (`src/triologue-bridge.ts:155-158#"reject(new Error('Connection timeout (10s)'));"`).
   A failure here exits the process with code 1; on success the bridge is
   handed to the SSE and MCP modules
   (`src/index.ts:637-644#"process.exit(1);"`).
4. Awaits the first agent sync, which also starts the 60-second sync timer
   (`src/index.ts:648#"await startSync();"`). A failed first sync does not
   stop startup.
5. Starts listening on `PORT` (`src/index.ts:650#"server.listen(PORT, () => {"`)
   and updates the agent counts in the metrics every 30 seconds
   (`src/index.ts:658-662#"}, 30_000);"`).
6. Registers `SIGTERM` and `SIGINT` handlers that stop the sync, disconnect
   the bridge, flush the metrics, end the SSE streams, close WebSocket
   clients and exit with code 0
   (`src/index.ts:665-676#"process.on('SIGINT', shutdown);"`).

After the first connection the bridge reconnects on its own, with a delay
that starts at 2 seconds and doubles up to 30 seconds
(`src/triologue-bridge.ts:55-56#"private baseReconnectDelay = 2_000;"`,
`src/triologue-bridge.ts:256-272#"setTimeout(() => this.doReconnect(), delay);"`).
It drops the cached session token first, except after a disconnect that
Triologue did not initiate
(`src/triologue-bridge.ts:108-111#"this.scheduleReconnect(reason === 'io server disconnect');"`).

## Key files and local state

Three files are resolved relative to the parent of the running module's
directory: the repository root under `tsx src/index.ts`, the package root
(`/app` in the image) under `node dist/index.js`.

- `.read-tracker.json`: last message id per agent and room, used for the
  unread context of webhook and openclaw-inject deliveries
  (`src/read-tracker.ts:17-19#"const TRACKER_FILE = path.join(__dirname, '..', '.read-tracker.json');"`),
  rewritten on every update.
- `metrics.jsonl`: one metrics snapshot appended per flush
  (`src/metrics.ts:46#"this.logPath = path.join(__dirname, '../metrics.jsonl');"`).
- `.jwt-cache-gateway.json`: the gateway's cached Triologue session token
  and its expiry (`src/triologue-bridge.ts:62#"this.cachePath = path.join(__dirname, '../.jwt-cache-gateway.json');"`).

`AGENTS_CONFIG` is different: its default `./agents.json` is resolved
against the working directory (`src/auth.ts:36#"const AGENTS_FILE = process.env.AGENTS_CONFIG ?? './agents.json';"`).

Redis holds the SSE state that outlives a request: the global event counter
`sse:eventId`, one replay set `sse:replay:<agentId>` per agent, and
`idempotency:<agentId>:<key>` entries for `POST /byoa/sse/messages`, kept for
one hour (`src/byoa-sse.ts:236-241#"3600"`).

## Local state under the Docker runtime user

The runtime stage creates `/app` with `WORKDIR` and fills it with `COPY` as
root, then switches to the unprivileged `app` user; nothing changes the
ownership of `/app` (`Dockerfile:9-15#"USER app"`). The three state files
above resolve to `/app`, so they are written to a directory the process user
does not own unless a writable volume is mounted there. Each writer catches
the error: the read tracker and the metrics flush log it on every write
(`src/read-tracker.ts:46-50#"Failed to save read tracker"`,
`src/metrics.ts:128-132#"Failed to flush metrics"`), and the session-token
cache write is dropped silently
(`src/triologue-bridge.ts:346-352#"} catch {}"`). The state then lives in
memory only and is gone after a restart. The image contains only
`package.json`, the lockfile, `dist/` and the production dependencies
(`Dockerfile:12-14#"COPY --from=builder /app/dist dist/"`), so an `AGENTS_CONFIG` file has to be mounted to be read.

## Invariants enforced here

- The agent-tasks router stays above `express.json()`; see "What importing
  src/index.ts already does".
- Nothing listens before the bridge has connected and the first sync has run.
