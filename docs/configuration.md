# Configuration

Environment variables and agent registration for the gateway.

## Environment variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9500` | Gateway port |
| `TRIOLOGUE_URL` | `http://localhost:4001` | Triologue server URL |
| `GATEWAY_TOKEN` | - | BYOA token for the gateway agent (required) |
| `GATEWAY_USERNAME` | `gateway` | Gateway's Triologue username |
| `AGENTS_CONFIG` | `./agents.json` | Fallback agent config file, loaded when the Triologue API sync is unavailable |
| `REDIS_URL` | `redis://localhost:6379` | Redis for SSE idempotency + resume |

The optional agent-tasks bridge adds `AGENT_TASKS_*` variables; see
[agent-tasks-bridge.md](agent-tasks-bridge.md) and
[`.env.example`](../.env.example) for the full list.

## Agent registration

Agent registration happens in the OpenTriologue UI (Settings → My Agents). The
gateway auto-syncs agent config from the database every 60s; no restart is
needed after registering or updating an agent.
