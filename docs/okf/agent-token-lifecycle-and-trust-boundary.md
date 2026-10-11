---
type: invariant
title: Agent token lifecycle and the gateway trust boundary
description: The gateway logs in as a Triologue service account, syncs every active agent's token and webhook secret into an in-memory index every 60 seconds (AGENTS_CONFIG only as a startup fallback), accepts a rotated token's predecessor until its grace expiry, brokers rotation only for the current token, and lets revocation take effect per path at different times; Triologue checks every send itself.
tags: [auth, tokens, rotation, revocation, trust-boundary, gateway-account]
timestamp: 2026-10-11T17:08:47Z
sources:
  - src/auth.ts
  - src/byoa-sse.ts
  - src/index.ts
  - src/triologue-bridge.ts
  - src/byoa-mcp.ts
  - src/webhook-dispatch.ts
---

# Agent token lifecycle and the gateway trust boundary

## The invariant

- The gateway never decides on its own who an agent is: every agent token it
  accepts comes from Triologue (the `gateway-config` sync or the startup
  file), and every message it posts to a room goes out with a BYOA token
  that Triologue checks again on each request.
- Between two syncs the gateway's view can lag Triologue's, and how long a
  revoked token keeps working depends on the path (see "Revocation latency").

## The gateway service account

The bridge logs in to Triologue with `GATEWAY_USERNAME` and `GATEWAY_TOKEN`
as an `AI_AGENT` user (`src/triologue-bridge.ts:336-340#"userType: this.config.userType,"`).
If the first connection fails, the process exits
(`src/index.ts:637-644#"process.exit(1);"`). The same token is the bearer for
the agent sync (`src/auth.ts:65-69#"signal: AbortSignal.timeout(5000),"`) and for
token rotation (`src/auth.ts:227-233#"'X-Agent-Token': currentToken,"`). Triologue
accepts those two calls only from its reserved service-account usernames; the
server-side rule and the `gateway-config` response are described in the
triologue repository's knowledge bundle,
[agent-integration-surfaces.md](https://github.com/LanNguyenSi/triologue/blob/master/docs/okf/agent-integration-surfaces.md).
A non-2xx sync answer (for example when Triologue refuses the account) is
logged and ignored, so the gateway keeps whatever list it already has
(`src/auth.ts:72-74#"return false;"`).

## Where the token index comes from

- At startup `loadAgents` reads `AGENTS_CONFIG` (default `./agents.json`) and
  falls back to an empty list when the file is missing or invalid
  (`src/auth.ts:53-59#"agents = [];"`).
- `startSync` then runs a first sync and repeats it every 60 seconds
  (`src/auth.ts:36-39#"const SYNC_INTERVAL_MS = 60_000;"`,
  `src/auth.ts:102-115#"}, SYNC_INTERVAL_MS);"`). A successful sync replaces the
  whole list and rebuilds the index (`src/auth.ts:83-85#"buildTokenIndex();"`);
  a failed one, by status or by exception, leaves the previous list in place
  (`src/auth.ts:92-94#"return false;"`), for as long as syncs keep failing.
- Each synced entry carries the agent's current token, its webhook secret and,
  during a rotation, the previous token and its expiry
  (`src/auth.ts:15-31#"previousTokenExpiresAt?: string | null;"`).
- `toAgentInfo` copies no `status` field
  (`src/auth.ts:136-150#"delivery: a.delivery ?? 'webhook',"`), so the
  `agent.status` check in the SSE middleware
  (`src/byoa-sse.ts:92-95#"return res.status(403).json({ error: 'Agent not active' });"`)
  never fires; an inactive agent is excluded because Triologue does not return
  it in `gateway-config`.

## Current and grace tokens

`buildTokenIndex` keeps two maps: current tokens, and previous tokens with
their expiry. A previous token whose expiry does not parse is skipped, and a
token that is some agent's current token is never stored as a grace entry
(`src/auth.ts:160-167#"previousTokenMap.set(prev, { agent: toAgentInfo(a), expiresAtMs });"`).

- `authenticateToken` accepts a current token, or a previous token strictly
  before its expiry instant
  (`src/auth.ts:180-186#"return null;"`). The `/send` route, the WebSocket
  `auth` event, the `/byoa` info page, the SSE middleware and the MCP endpoint
  all use it (`src/index.ts:320-324#"const agent = authenticateToken(token);"`,
  `src/index.ts:534#"const agent = authenticateToken(event.token);"`,
  `src/index.ts:378#"const agent = authenticateToken(token);"`,
  `src/byoa-sse.ts:78-85#"const agent = authenticateToken(token);"`,
  `src/byoa-mcp.ts:206#"const agent = authenticateToken(token);"`).
- `authenticateCurrentToken` accepts only a current token
  (`src/auth.ts:172-173#"return tokenMap.get(token) ?? null;"`); only the
  rotate route uses it.

## Rotation brokering

`POST /byoa/sse/tokens/rotate` passes the SSE middleware, then refuses any
token that is not the agent's current one with 403 `stale_token`
(`src/byoa-sse.ts:263-267#"error: 'stale_token',"`). Only after that check does
it spend the rotate budget, five calls per agent per hour, kept apart from the
message limiter
(`src/byoa-sse.ts:69-70#"const ROTATE_MAX_REQUESTS = 5;"`,
`src/byoa-sse.ts:274#"const limit = consumeWindow(rotateRateLimits"`).

`rotateTokenUpstream` needs the AgentToken row id, which `gateway-config`
does not ship. It resolves the id once per agent through
`GET /api/agents/me/context` with the agent's current token and caches it
(`src/auth.ts:201-212#"agentTokenIdCache.set(userId, id);"`), then calls
Triologue's rotate route with the gateway token as bearer and the agent's
current token in `X-Agent-Token` (`src/auth.ts:227-233#"'X-Agent-Token': currentToken,"`).
A 404 drops the cached id so the next attempt resolves it again
(`src/auth.ts:239-244#"return { ok: false, status: 404, error: 'agent_not_found' };"`).
On success the new token is applied to the local list at once and the index
is rebuilt, so it authenticates before the next sync, which stays the source
of truth (`src/auth.ts:259-266#"buildTokenIndex();"`). Upstream bodies are never
echoed; failures map to fixed error strings
(`src/auth.ts:275-277#"return { ok: false, status: 502, error: 'upstream_unavailable' };"`),
and the success answer is sent with `Cache-Control: no-store`
(`src/byoa-sse.ts:287#"res.set('Cache-Control', 'no-store');"`).

## Revocation latency, per path

When Triologue revokes or deactivates an agent, the paths catch up at
different times:

- Sends. `POST /send`, `POST /byoa/sse/messages` and the MCP endpoint check
  the token against the in-memory index on each request, which lags until
  the next successful sync. A WebSocket checks it only once, at `auth`, and
  later `message` events reuse the token stored then
  (`src/index.ts:591-592#"await bridge.sendAsAgent(token, event.room, event.content);"`).
  `sendAsAgent` then posts to
  `/api/agents/message` with the agent's own token
  (`src/triologue-bridge.ts:179#"/api/agents/message"`), and Triologue checks
  that token on the request, so a revoked token cannot post. The gateway
  reports the upstream refusal as 502 on `POST /byoa/sse/messages`
  (`src/byoa-sse.ts:227-229#"return res.status(502).json({ error: 'Failed to deliver message', detail: err.message });"`),
  500 on `POST /send` (`src/index.ts:333-334#"res.status(500).json({ error: err.message });"`)
  and a `SEND_FAILED` frame on WebSocket
  (`src/index.ts:594-595#"code: 'SEND_FAILED'"`).
- SSE receive. A stream is authenticated once, when it opens
  (`src/byoa-sse.ts:105#"sseRouter.get('/stream', authenticateSSE"`), and is not
  closed later. Loop 2 of the routing iterates the synced agents
  (`src/index.ts:178#"for (const agent of getAllAgents()) {"`), so the stream
  stops getting messages after the sync that drops the agent, while staying
  open.
- Webhook and openclaw-inject. Loop 3 reads the synced agents too
  (`src/auth.ts:288-289#"return [...tokenMap.values()].filter("`), so delivery
  stops after the same sync.
- WebSocket receive. The authenticated client is stored once
  (`src/index.ts:549-550#"clients.set(agent.userId, client);"`) and loop 1
  iterates that map (`src/index.ts:116#"for (const [agentId, client] of clients) {"`)
  without checking the token again, so a connection that authenticated
  before the revocation keeps receiving until it disconnects.
- Rotation. The previous token keeps authenticating at the gateway until its
  grace expiry, as above. An SSE stream or WebSocket connection opened with
  the previous token is not closed at grace expiry: delivery is keyed by the
  agent's user id, not the token
  (`src/index.ts:178-179#"if (!hasSSEClient(agent.userId)) continue;"`,
  `src/index.ts:549-550#"clients.set(agent.userId, client);"`), and the
  rotated agent stays in the synced list, so the connection keeps receiving
  until it disconnects.

Routing per loop is in [message-delivery-routing.md](message-delivery-routing.md).

## What the gateway token reaches

- Every synced entry holds an agent's current token and webhook secret
  (`src/auth.ts:15-31#"previousTokenExpiresAt?: string | null;"`), so the gateway
  process holds the credentials of every active agent, and with them it can
  rotate any agent's token.
- The unread context for webhook deliveries, and for openclaw-inject agents
  not connected over WebSocket, is fetched with the gateway token
  (`src/index.ts:219#"bridge.fetchMessagesSince(GATEWAY_TOKEN"`,
  `src/index.ts:248#"bridge.fetchMessagesSince(GATEWAY_TOKEN"`).
- When an agent has a webhook secret, each delivery still carries it in
  plain text in `X-Triologue-Secret`, next to the HMAC signature
  (`src/webhook-dispatch.ts:79#"headers['X-Triologue-Secret'] = secret;"`).
- The `/byoa?token=` info page renders the bearer token into the HTML
  (`src/index.ts:438#"<pre><code>${token}</code></pre>"`).
- `GET /health`, `GET /metrics`, `GET /metrics/json` and
  `GET /byoa/sse/health` have no auth
  (`src/index.ts:340#"app.get('/health'"`,
  `src/index.ts:499#"app.get('/metrics'"`,
  `src/index.ts:504#"app.get('/metrics/json'"`,
  `src/byoa-sse.ts:313#"sseRouter.get('/health'"`); `/health` lists the names,
  emoji and connect times of WebSocket agents.

## What breaks it

- Re-authenticating WebSocket clients on each sync (or closing SSE streams of
  agents a sync removed) would shorten the receive-side lag; nothing does
  that today.
- Letting `authenticateToken` serve the rotate route would let a grace-window
  token mint the replacement.
- Clearing the agent list on a failed sync would turn a Triologue outage into
  a gateway that authenticates nobody.
