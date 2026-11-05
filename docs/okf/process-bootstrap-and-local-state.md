---
type: module
title: Process bootstrap and local state
description: What importing src/index.ts already does (router mount order for the raw-body HMAC route, Redis clients, metrics timer), the module-is-main guard and its extensionless-invocation trap, the startup order from the GATEWAY_TOKEN check to listen, and where the gateway keeps local state, including under the Docker runtime user.
tags: [bootstrap, startup, entrypoint, local-state, redis, docker]
timestamp: 2026-11-05T06:49:28Z
sources:
  - src/index.ts
  - src/agent-tasks-bridge.ts
  - src/byoa-sse.ts
  - src/metrics.ts
  - src/openclaw-inject.ts
  - src/read-tracker.ts
  - src/state-dir.ts
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
  (`src/index.ts:759-762#"main();"`).
- `start()`, `src/index.ts`, called by `main()` after local state is loaded.
- Container: `node dist/index.js` (`Dockerfile:23#"dist/index.js"`).

## What importing src/index.ts already does

Importing the module, as the tests do to reach the exported `app`, runs these
steps without the guard:

- Mounts the agent-tasks bridge router before the global JSON parser
  (`src/index.ts:55-60#"app.use("`, `src/index.ts:76-78#"app.use(express.json());"`).
  The bridge route parses its own body with `express.raw`, so the HMAC check
  sees the exact bytes received
  (`src/agent-tasks-bridge.ts:230-234#"express.raw({ type: 'application/json', limit: '256kb' }),"`).
  Moving `express.json()` above it would consume the body first. Building
  the router logs a warning when the bridge is disabled or runs in unsigned
  mode (`src/agent-tasks-bridge.ts:220-227#"ALLOW_UNSIGNED=true , accepting"`).
- Mounts `/byoa/sse`, `/byoa/mcp` and `/byoa/sessions` behind the JSON parser
  (`src/index.ts:93#"app.use('/byoa/sessions', createSessionsRouter(sessionRegistry));"`).
- Constructs the `TriologueBridge` without connecting it
  (`src/index.ts:112-116#"userType: 'AI_AGENT',"`) and attaches the
  WebSocket server at `/byoa/ws` to the HTTP server
  (`src/index.ts:530#"const wss = new WebSocketServer({ server, path: '/byoa/ws' });"`).
- Opens three Redis clients for `REDIS_URL`, defaulting to
  `redis://localhost:6379`: two through the `byoa-sse` import
  (`src/byoa-sse.ts:36-37#"const redisSub = new Redis("`) and one of its own
  for the session registry
  (`src/index.ts:90#"const sessionRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');"`);
  starts the metrics flush timer, which appends a snapshot every 60 seconds
  (`src/metrics.ts:41-61#"this.flushInterval = setInterval(() => this.flush(), 60_000);"`);
  and reads the OpenClaw config and device files once
  (`src/openclaw-inject.ts:24-27#"return cfg.gateway?.auth?.token as string;"`,
  `src/openclaw-inject.ts:33-35#"return JSON.parse(fs.readFileSync(openClawDevicePath(), 'utf-8'));"`).

## The module-is-main guard and its trap

`isMainModule` compares `process.argv[1]` with the module's own file path
(`src/index.ts:759-762#"main();"`). That path always carries its extension,
while `argv[1]` is the absolute path of what was typed, without extension
resolution, so `node dist/index` (without `.js`) never matches: `main()`
does not run, and the Redis clients opened at import keep the event loop
alive, so the process stays up without listening
(`src/index.ts:747-756#"Always invoke with the explicit"`). The Docker `CMD`
uses the explicit extension (`Dockerfile:23#"dist/index.js"`).

## Startup order

`main()` runs these steps in order:

1. Exits with code 1 when `GATEWAY_TOKEN` is unset
   (`src/index.ts:726-728#"process.exit(1);"`).
2. Loads `AGENTS_CONFIG`, builds the token index and loads the read tracker
   (`src/index.ts:731-733#"loadReadTracker();"`), then calls `start()`
   (`src/index.ts:735#"await start();"`).
3. `start()` connects the bridge: it authenticates, with a fresh login
   unless the cached session token is still valid
   (`src/triologue-bridge.ts:327-348#"// Fresh login"`), then
   opens the Socket.io connection
   (`src/triologue-bridge.ts:71-73#"await this.createSocket();"`), which
   rejects after 10 seconds without a connection
   (`src/triologue-bridge.ts:160-163#"reject(new Error('Connection timeout (10s)'));"`).
   A failure here exits the process with code 1; on success the bridge is
   handed to the SSE and MCP modules
   (`src/index.ts:667-674#"process.exit(1);"`).
4. Awaits the first agent sync, which also starts the 60-second sync timer
   (`src/index.ts:678#"await startSync();"`). A failed first sync does not
   stop startup.
5. Starts listening on `PORT` (`src/index.ts:680#"server.listen(PORT, () => {"`)
   and updates the agent counts in the metrics every 30 seconds
   (`src/index.ts:688-692#"}, 30_000);"`).
6. Registers `SIGTERM` and `SIGINT` handlers that stop the sync, disconnect
   the bridge, flush the metrics, end the SSE streams, close WebSocket
   clients and exit with code 0
   (`src/index.ts:705-716#"process.on('SIGINT', shutdown);"`).

After the first connection the bridge reconnects on its own, with a delay
that starts at 2 seconds and doubles up to 30 seconds
(`src/triologue-bridge.ts:53-54#"private baseReconnectDelay = 2_000;"`,
`src/triologue-bridge.ts:267-283#"setTimeout(() => this.doReconnect(), delay);"`).
It drops the cached session token first, except after a disconnect that
Triologue did not initiate
(`src/triologue-bridge.ts:106-109#"this.scheduleReconnect(reason === 'io server disconnect');"`).

## Key files and local state

Three files live in the state directory, `STATE_DIR`
(`src/state-dir.ts:15-17#"return configured ? path.resolve(configured) : path.join(moduleDir, '..');"`).
Unset or blank, it is the parent of the running module's directory: the
repository root under `tsx src/index.ts`, the package root (`/app` in the
image) under `node dist/index.js`. The image sets `STATE_DIR=/app/state`.
The directory is not created by the gateway; it must exist and be writable.

- `.read-tracker.json`: last message id per agent and room, used for the
  unread context of webhook and openclaw-inject deliveries
  (`src/read-tracker.ts:13#"const TRACKER_FILE = stateFile('.read-tracker.json');"`),
  rewritten on every update.
- `metrics.jsonl`: one metrics snapshot appended per flush
  (`src/metrics.ts:42#"this.logPath = stateFile('metrics.jsonl');"`).
- `.jwt-cache-gateway.json`: the gateway's cached Triologue session token
  and its expiry (`src/triologue-bridge.ts:60#"this.cachePath = stateFile('.jwt-cache-gateway.json');"`).

`AGENTS_CONFIG` is different: its default `./agents.json` is resolved
against the working directory (`src/auth.ts:36#"const AGENTS_FILE = process.env.AGENTS_CONFIG ?? './agents.json';"`).

Redis holds the SSE state that outlives a request: the global event counter
`sse:eventId`, one replay set `sse:replay:<agentId>` per agent, and
`idempotency:<agentId>:<key>` entries for `POST /byoa/sse/messages`, kept for
one hour (`src/byoa-sse.ts:245-250#"3600"`).

## Local state under the Docker runtime user

The runtime stage creates `/app` with `WORKDIR` and fills it with `COPY` as
root, so `/app` stays root-owned, creates `/app/state` owned by `app`, then
switches to the unprivileged `app` user
(`Dockerfile:9-18#"USER app"`) and sets `STATE_DIR` to that directory
(`Dockerfile:20#"ENV STATE_DIR=/app/state"`). The three state files are
therefore written to a directory the process user owns. A volume mounted over
`/app/state` replaces it and must be writable by `app`, or the writes fail
again. Each writer catches the error: the read tracker and the metrics flush log it on every write
(`src/read-tracker.ts:40-44#"Failed to save read tracker"`,
`src/metrics.ts:124-128#"Failed to flush metrics"`), and the session-token
cache write is dropped silently
(`src/triologue-bridge.ts:358-364#"} catch {}"`). The state then lives in
memory only and is gone after a restart. Without a volume the files live in
the container and are lost when it is removed. The image contains only
`package.json`, the lockfile, `dist/` and the production dependencies
(`Dockerfile:12-14#"COPY --from=builder /app/dist dist/"`), so an `AGENTS_CONFIG` file has to be mounted to be read.

## Invariants enforced here

- The agent-tasks router stays above `express.json()`; see "What importing
  src/index.ts already does".
- Nothing listens before the bridge has connected and the first sync has run.
