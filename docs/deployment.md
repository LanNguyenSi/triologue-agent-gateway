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

On a host that runs Triologue from its compose file, join the gateway to that
network and publish the port on the Docker bridge address only, where
Triologue's `/gateway/` proxy expects it (`172.17.0.1:9500`). The gateway binds to
all interfaces inside its container, so `--network host` or a plain `-p 9500:9500`
exposes `/metrics`, `/health` and `/byoa?token=` on the public address unless a
firewall stops it. The Triologue API listens on port 3001 on that network, and
Redis runs as a container of its own, because a Redis bound to the host's
loopback is not reachable from the network. In `.env`:
`TRIOLOGUE_URL=http://triologue-api:3001` and
`REDIS_URL=redis://triologue-gateway-redis:6379`. Build one image per release tag,
so going back is starting the previous tag's image with the same env file and
volume:

```bash
git checkout v0.6.0
docker build -t triologue-agent-gateway:0.6.0 .
docker run -d --name triologue-gateway-redis --restart unless-stopped \
  --network triologue-network -v gateway-redis:/data \
  redis:7.4-alpine redis-server --appendonly yes
docker run -d --name triologue-agent-gateway --restart unless-stopped \
  --network triologue-network -p 172.17.0.1:9500:9500 \
  --env-file .env -v gateway-state:/app/state \
  triologue-agent-gateway:0.6.0

# Back to the previous release
docker rm -f triologue-agent-gateway
docker run -d --name triologue-agent-gateway --restart unless-stopped \
  --network triologue-network -p 172.17.0.1:9500:9500 \
  --env-file .env -v gateway-state:/app/state \
  triologue-agent-gateway:0.5.0
```

The image contains only the built `dist/` and the production dependencies. To use
`AGENTS_CONFIG`, mount the file into the container and point the variable at
it.

## Local state

The gateway keeps three files in its state directory, `STATE_DIR`. Unset, that
is the directory above its code directory (the project root, next to `dist/`):

- `.read-tracker.json`: the last message delivered per agent and room, used
  for the webhook and `openclaw-inject` context.
- `metrics.jsonl`: a metrics snapshot appended every 60 seconds.
- `.jwt-cache-gateway.json`: the cached Triologue session token.

The image sets `STATE_DIR=/app/state`, a directory owned by the `app` user
that the process runs as, so the three files can be written. The directory
must exist and be writable by the gateway process; the gateway does not create
it. To keep the state across container replacements, mount a volume at
`/app/state` that is writable by the `app` user (for example
`docker run -v gateway-state:/app/state ...`). Without a volume the state
lives in the container and is lost when it is removed. If a write fails, the
read tracker and the metrics log an error, the session token cache fails
silently, and the state is kept in memory only and lost on restart.

To move existing state files (for example from an older image or a source
checkout) into the state directory, copy them there before the first start
with the new setting.

## Security model

- The gateway token reads every active agent's current token and webhook
  secret through the agent sync, and can rotate any agent's token. Protect the
  gateway host and its `.env` like a credential store, and revoke and re-issue
  the gateway token if it leaks.
- These endpoints need no authentication: `/health` (the running build's
  `version` field, read from the image's `package.json` at startup so a
  rebuild can be verified from outside; plus the names, emoji and connect
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
