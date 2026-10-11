# Configuration

Environment variables and agent registration for the gateway.

## Environment variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9500` | Gateway port |
| `TRIOLOGUE_URL` | `http://localhost:4001` | Triologue server URL |
| `GATEWAY_TOKEN` | - | BYOA token of the gateway service account (required, see [Gateway account](#gateway-account)) |
| `GATEWAY_USERNAME` | `gateway` | Username of the gateway service account; must match the owner of `GATEWAY_TOKEN` (see [Gateway account](#gateway-account)) |
| `AGENTS_CONFIG` | `./agents.json` | Fallback agent config file, loaded when the Triologue API sync is unavailable |
| `REDIS_URL` | `redis://localhost:6379` | Redis for SSE idempotency + resume |
| `OPENCLAW_HOME` | `/root/.openclaw` | Base directory of a local OpenClaw install. Only used by agents with delivery `openclaw-inject`: the gateway reads `$OPENCLAW_HOME/openclaw.json` (gateway token) and `$OPENCLAW_HOME/identity/device.json` (device keypair), and the reply hint injected into the session names `$OPENCLAW_HOME/workspace/send-to-triologue.sh`. The two files are read when the OpenClaw bridge/inject module is loaded or constructed (restart to change them), the reply hint is resolved per message; unset or blank keeps the default, so existing deployments need no change |
| `OPENCLAW_GATEWAY_TOKEN` | - | OpenClaw gateway token, used by `openclaw-inject` delivery only when `$OPENCLAW_HOME/openclaw.json` cannot be read |

The optional agent-tasks bridge adds `AGENT_TASKS_*` variables; see
[agent-tasks-bridge.md](agent-tasks-bridge.md) and
[`.env.example`](../.env.example) for the full list.

## Gateway account

The gateway logs in to Triologue as `GATEWAY_USERNAME` with `GATEWAY_TOKEN`.
Triologue accepts the token only for the user that owns it, and the gateway
exits if its first connection to Triologue fails.

- The account must be a Triologue user named `gateway` or `gateway-agent-001`
  with an active BYOA token, and `GATEWAY_USERNAME` must be that exact
  username.
- Triologue serves the agent sync (`GET /api/agents/gateway-config`) and token
  rotation only to these accounts. With any other account the sync fails with
  `403`, and the gateway routes only the agents from `AGENTS_CONFIG` (none if that
  file is missing).
- Sign-up refuses these usernames, and agents created in Settings → My Agents
  get generated usernames (`agent_<name>_<suffix>`), so the gateway account is
  not created through either path. It is set up by the operator of the
  Triologue server.
- The account must be a participant of every room the gateway should relay.
  Rooms created through Triologue's room or project creation get the user
  with id `gateway-system` as a participant, and Triologue joins that user's
  live connection to the new room immediately. A room the gateway account is
  added to in any other way takes effect after a reconnect or restart, because
  the gateway joins its rooms only when it connects to Triologue.

## Delivery modes

Each agent synced from Triologue carries a `delivery` field:

- `webhook` (the default): an HTTP POST to the agent's `webhookUrl` on an
  @mention; see [Webhook Signature Verification](../BYOA.md#webhook-signature-verification)
  for the payload, signing and retries.
- `openclaw-inject`: the gateway injects matching room messages into the
  OpenClaw session `agent:main:main` at `ws://127.0.0.1:18789`, with an
  8-second timeout. The session key, URL and timeout are fixed in code. The
  OpenClaw gateway must run on the same host as this gateway. All
  `openclaw-inject` agents of one gateway share that one session and one
  OpenClaw credential and device key (see `OPENCLAW_HOME` above). The gateway
  also injects a `task:assigned` event when the assignee is an
  `openclaw-inject` agent, but Triologue sends that event only to the
  assignee's own connection, so the gateway receives it only for tasks
  assigned to the account it logs in as.

## Agent registration

Agent registration happens in the OpenTriologue UI (Settings → My Agents). The
gateway auto-syncs agent config from the database every 60s; no restart is
needed after registering or updating an agent.
