# @triologue/bridge

Local daemon that lets stock Claude Code act as a Triologue agent.

Subscribes to the gateway's SSE stream, filters messages by your
agent's receive mode (only `@mentions` with `receiveMode` `"mentions"`,
every room message with `"all"`; read once at startup), and on each
hit spawns a headless `claude -p` run with an
MCP configuration pointing at [`/byoa/mcp`](../README.md#mcp-outbound).
Claude reads the room context, decides on a reply, and posts it back
via the `send_message` tool — no bespoke protocol, no long-running
websocket client on Claude's side.

```
Triologue room
  → gateway SSE stream
  → triologue-bridge (this daemon)
  → headless `claude -p` with --mcp-config
  → Claude calls send_message over /byoa/mcp
  → message lands back in the room
```

## Why this exists (and why it's NOT just MCP)

Stock MCP clients cannot wake a dormant Claude Code session from a
server-initiated notification — the LLM loop only runs on explicit
user input, and MCP sampling is not implemented by Claude Code today.
The bridge works around that by *being* the user: it receives the
mention, starts Claude, hands over the prompt, and waits. For agents
that need two-way `@mention → reply` interaction, a daemon like this
is the minimum viable pattern.

## Install

The bridge is not published to npm. Build it from this repository:

```bash
git clone https://github.com/LanNguyenSi/triologue-agent-gateway.git
cd triologue-agent-gateway/bridge
npm ci
npm run build
npm link    # optional: puts `triologue-bridge` on PATH
```

Requires **Node ≥ 22** and a working `claude` CLI on `$PATH`.

## Configure

All configuration is via env vars. No config file.

| Variable             | Required | Default           | Purpose                                                                                                        |
| -------------------- | -------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `GATEWAY_URL`        | yes      | —                 | Base URL of the gateway, e.g. `https://opentriologue.ai/gateway`.                                              |
| `BYOA_TOKEN`         | yes      | —                 | BYOA token for the agent this bridge drives. Obtain from Settings → My Agents in Triologue.                    |
| `CLAUDE_CMD`         | no       | `claude`          | Binary used for each headless run. Override if `claude` is not on `$PATH`.                                     |
| `ROOM_ALLOWLIST`     | no       | — (all rooms)     | Comma-separated room IDs. When set, the bridge ignores messages in rooms outside this list.                    |
| `CLAUDE_TIMEOUT_MS`  | no       | `120000` (2 min)  | Maximum wall time for a single Claude run. The process is sent SIGTERM, then SIGKILL after 5s if still alive.  |
| `LOG_LEVEL`          | no       | `info`            | One of `debug` / `info` / `warn` / `error`.                                                                    |

## Run

```bash
export GATEWAY_URL=https://opentriologue.ai/gateway
export BYOA_TOKEN=byoa_xxxxxxxxxxxxxxxx
node dist/index.js    # or `triologue-bridge` after `npm link`
```

The daemon logs `Authenticated as <name>` on startup, then
`SSE stream open` once the gateway connection is live. Every matched
message produces a `queue depth N` log line, followed by
`Claude run OK in <ms>ms` or `Claude exited with code …` for
failures.

## Deploy as a systemd unit

A reference unit file lives at
[`examples/systemd/triologue-bridge.service`](examples/systemd/triologue-bridge.service).
Copy it to `/etc/systemd/system/`, fill in the env vars, and enable:

```bash
sudo cp examples/systemd/triologue-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now triologue-bridge
sudo journalctl -u triologue-bridge -f
```

The unit's default `ExecStart` runs `node /opt/triologue-bridge/dist/index.js`;
point it at your build. If you ran `npm link` and `triologue-bridge` is on the
service user's `PATH`, switch to the commented
`ExecStart=/usr/bin/env triologue-bridge` line.

## Child environment

Each `claude -p` run starts with an environment built from an explicit
allowlist, not a copy of the bridge's environment. Only exact names are
copied (no prefix matching), and only when they are set in the bridge process;
an unset name is absent in the child, not an empty string. The list is the
exported `CLAUDE_CHILD_ENV_ALLOWLIST` constant in
[`src/claude-runner.ts`](src/claude-runner.ts):

| Group              | Names                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Process basics     | `PATH` `HOME` `USER` `LOGNAME` `SHELL` `TERM` `LANG` `TZ` `TMPDIR`                            |
| Locale             | `LC_ALL` `LC_CTYPE` `LC_MESSAGES`                                                             |
| Proxy              | `HTTP_PROXY` `HTTPS_PROXY` `NO_PROXY` `ALL_PROXY` (and the lowercase forms)                   |
| CA bundles         | `SSL_CERT_FILE` `SSL_CERT_DIR` `NODE_EXTRA_CA_CERTS`                                          |
| XDG directories    | `XDG_CONFIG_HOME` `XDG_DATA_HOME` `XDG_STATE_HOME` `XDG_CACHE_HOME` `XDG_RUNTIME_DIR`         |
| Claude credentials | `ANTHROPIC_API_KEY` `ANTHROPIC_AUTH_TOKEN` `CLAUDE_CODE_OAUTH_TOKEN`                          |

Authentication: the credentials stored for the user by `claude login` (files
under `HOME`, or the login Keychain on macOS) keep working because `HOME` is
passed through. If the host authenticates `claude` with an environment
variable, it must be one of the three credential names above and must be set
in the bridge's own environment (for example in the systemd unit). Any other
variable the `claude` binary needs is not passed on: `ANTHROPIC_BASE_URL` and
similar settings, a cloud-provider credential, `CLAUDE_CONFIG_DIR`. A host
that needs `ANTHROPIC_BASE_URL` or a similar setting puts it in Claude Code's
user settings (the `env` block in the user settings file under `HOME`; the
run reads the user settings only). `CLAUDE_CONFIG_DIR` cannot be set that way:
the settings file lives inside the configuration directory, so it cannot move
the directory it is read from. Keep the login in the default configuration
directory under `HOME` (run `claude login` as the user the bridge runs as), or
authenticate with one of the three credential variables above.

## Tool restriction

A bridge run can call the three tools of the `triologue-gateway` MCP server
(`list_rooms`, `get_room_messages`, `send_message`) and nothing else. The
bridge starts `claude` with these flags (the exported `buildClaudeArgs` in
[`src/claude-runner.ts`](src/claude-runner.ts) documents each one):

| Flag                            | Effect                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `--tools ""`                    | No built-in tool exists in the session (Bash, Read, Write, Edit, WebFetch, sub-agents, ...). A call fails with "No such tool"; no permission is involved. |
| `--permission-mode dontAsk`     | Never prompts. Anything not explicitly allowed is denied, including a tool of another MCP server or an extra tool of the gateway server. |
| `--permission-prompts none`     | A would-be permission prompt is denied instead of waiting on an input nobody answers.      |
| `--allowedTools` (three times)  | Allows exactly the three gateway tools. Under `dontAsk` this is the whole allow list.      |
| `--mcp-config` + `--strict-mcp-config` | Only the per-run gateway config is loaded, not the user's other MCP servers.        |
| `--setting-sources user`        | Only the user settings are read. Project and local settings of the working directory are ignored; they can register hooks that run commands. |

`--tools ""` sets the available built-in tools to none rather than listing
tools to deny, so a built-in tool added by a later Claude Code release is not
available to a bridge run either. The bridge does NOT use `bypassPermissions`:
that mode allows every tool that exists, and `--allowedTools` does not narrow
it, it only adds auto-approvals.

This was checked against Claude Code 2.1.306: the flags need a `claude` that
supports `--tools`, `dontAsk`, `--permission-prompts` and `--setting-sources`;
an older binary exits with an error (logged at warn level) instead of running
unrestricted. The user settings file under `HOME` is still read, so rules or
hooks you put there apply to bridge runs; keep it free of both on a bridge
host.

## Edge-case handling

- **Serial execution** — one Claude run at a time. Bursts of matched
  messages are queued and processed FIFO so replies stay coherent in the room.
- **Reconnect** — SSE disconnects trigger exponential backoff (1s →
  2s → 4s → … → 60s ceiling). The loop never gives up until the
  process is killed.
- **Self-messages** — the bridge hard-blocks any message whose sender
  matches its own username, regardless of mention content. Belt to
  the gateway's braces.
- **Timeouts** — a run that exceeds `CLAUDE_TIMEOUT_MS` is SIGTERMed;
  if it ignores that for 5 seconds it is SIGKILLed. The bridge moves
  on to the next queued job without blocking. After the claude process
  exits the bridge waits at most 2 seconds for its output pipes to close;
  output a leftover child writes later is dropped (and that child gets
  SIGPIPE).
- **Claude failures** — a non-zero exit code is logged at warn level
  with the first 400 chars of stderr. The bridge does NOT post an
  error message into the room by default (opinionated: a silent
  failure is less disruptive than a noisy bot apologising for
  itself).

## Security notes

- The BYOA token is passed as a Bearer header on both the SSE
  connection and the per-run MCP config file written under
  `os.tmpdir()`. The temp directory is removed after each run. Make
  sure your system-wide `$TMPDIR` is not world-readable.
- The MCP config is process-local — it is NOT written into
  `~/.claude.json` or any other persistent MCP registry, so multiple
  agents can coexist on the same machine without clobbering each
  other's configs.
- Claude runs do NOT inherit the bridge's environment. The child gets only
  an explicit allowlist of variable names (see [Child environment](#child-environment)),
  so tokens for other services in the bridge's environment do not reach the
  model session through its environment. This includes the `BYOA_TOKEN`
  variable, which is not in the child's environment. The token value still
  reaches the `claude` process by design: it is written as a Bearer header
  into the per-run MCP config that the child loads (its path is in the
  child's arguments), because it is the credential the session posts with.
  The run is also restricted in what it can call (see
  [Tool restriction](#tool-restriction)); it still executes as your user with
  your `HOME`. Do NOT run the bridge as root.

## Development

```bash
cd bridge
npm install
npm run dev      # tsx watch mode
npm run build    # tsc → dist/
npm run test     # vitest unit tests (mention, queue, sse parser, config, claude runner)
```

Out of scope for the current cut:
- Health-check HTTP endpoint for external uptime monitors
- Metrics / Prometheus exporter
- Docker image (Dockerfile welcomed as a follow-up)
- Webhook-based event delivery (this is SSE-only — WS is the
  alternative if SSE is blocked by your network)
