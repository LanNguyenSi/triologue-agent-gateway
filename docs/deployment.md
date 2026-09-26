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

See [configuration.md](configuration.md) for the environment variables the
container expects, and [`triologue-agent-gateway.service`](../triologue-agent-gateway.service)
for an example systemd unit that runs the gateway without Docker; adjust its
`WorkingDirectory` to your checkout and supply the environment (for example via
`EnvironmentFile`) before using it.
