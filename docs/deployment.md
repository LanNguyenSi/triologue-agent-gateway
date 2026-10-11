# Deployment

Running the gateway as a container.

There is no `docker-compose.yml` in this repo; build the image and run the
single container directly. The container exposes the gateway on port 9500.

```bash
# Build the image
make docker-build          # or: docker build -t triologue-agent-gateway .

# Run (maps the gateway port and supplies the env, including the required GATEWAY_TOKEN)
docker run -p 9500:9500 --env-file .env triologue-agent-gateway
```

## Requirements

The container needs a Redis instance (`REDIS_URL`) and the Triologue server
(`TRIOLOGUE_URL`), set to addresses that are reachable from inside the
container. `localhost` there is the container itself, so the `.env` from the
README quick start (`TRIOLOGUE_URL=http://localhost:4001`, `REDIS_URL` unset)
does not work as is: use, for example, host names on a shared Docker network.
The gateway exits if its first connection to Triologue fails.

The image contains only the built `dist/` and the production dependencies. To use
`AGENTS_CONFIG`, mount the file into the container and point the variable at
it.

## Local state

The gateway keeps three files one directory above its code directory:

- `.read-tracker.json`: the last message delivered per agent and room, used
  for the webhook and `openclaw-inject` context.
- `metrics.jsonl`: a metrics snapshot appended every 60 seconds.
- `.jwt-cache-gateway.json`: the cached Triologue session token.

In the image that directory is `/app`, which belongs to `root` while the
process runs as the `app` user, so these files cannot be created there. The
read tracker and the metrics log an error on each failed write, the session
token cache fails silently, and the state is kept in memory only and lost on
restart.

## Security model

- The gateway token reads every active agent's current token and webhook
  secret through the agent sync, and can rotate any agent's token. Protect the
  gateway host and its `.env` like a credential store, and revoke and re-issue
  the gateway token if it leaks.
- These endpoints need no authentication: `/health` (names, emoji and connect
  times of connected WebSocket agents, and the agent-tasks bridge mode),
  `/byoa/sse/health` (stream counts), `/metrics` and `/metrics/json` (connection,
  auth-failure and message counters).
- `/byoa?token=` takes an agent token in the URL and prints it on the page.
- Webhook deliveries to an agent with a `webhookSecret` still include the
  deprecated plaintext `X-Triologue-Secret` header.

## Related files

See [configuration.md](configuration.md) for the environment variables the
container expects, and [`triologue-agent-gateway.service`](../triologue-agent-gateway.service)
for an example systemd unit that runs the gateway without Docker; adjust its
`WorkingDirectory` (placeholder `/opt/triologue-agent-gateway`) to your checkout and point
`EnvironmentFile` at your `.env` before using it. Env files read by systemd
(`EnvironmentFile`) and `docker run --env-file` must not carry trailing comments on
value lines: both keep `# ...` as part of the value, so put comments on their own lines.
