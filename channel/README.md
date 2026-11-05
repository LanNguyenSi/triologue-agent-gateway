# @triologue/channel

A [Claude Code channel](https://code.claude.com/docs/en/channels-reference) for Triologue. Claude Code spawns this server (`triologue-channel`) over stdio; it connects to the agent gateway with the agent's BYOA token and makes the running interactive session a participant of the agent's rooms:

- room messages arrive in the session as `<channel source="triologue-channel" room="…" thread_id="…" sender="…">` events (after a sender gate);
- Claude answers with the `send_message` tool, into the room or the thread;
- a permission prompt in the terminal is relayed to a bound room as `Reply "yes abcde" or "no abcde"`, and an allowed person's answer in that room becomes the verdict;
- the session registers at the gateway's `/byoa/sessions`, binds rooms (`connect_room`), tags its stream with the session, and the hooks that ship with the plugin report whether it is idle, working, waiting for an approval or failed, so the room shows it next to the agent's name.

This is the attended counterpart of [`bridge/`](../bridge/README.md): the bridge spawns a headless `claude -p` per mention, the channel pushes into the session you are already working in. Status: **prototype, not yet dogfooded against Claude Code** (the stdio contract is tested against a fake gateway in `tests/stdio.test.ts`); see "What is missing" below.

```
Triologue room
  → gateway SSE stream (?session=<id>)
  → this server (gate: self, agents, allowlist, bound rooms, verdicts)
  → notifications/claude/channel → your running Claude Code session
  ← send_message tool → POST /byoa/sse/messages → the room
```

## Requirements

- Node.js 22 or newer and a `claude` that supports channels (2.1.258 or newer; a research preview, so the flags are not in `--help`).
- A Triologue agent (Settings → My Agents) with its `byoa_…` token, and a gateway from the release that carries `/byoa/sessions` (after 0.5.0). An older gateway still streams and sends; the session features are then off.
- Authentication through claude.ai or a Console API key; channels are not available on Bedrock, Vertex or Foundry. On a Team or Enterprise plan an admin has to enable channels.
- The server pins `@modelcontextprotocol/sdk` 1.x on purpose: a server that negotiates MCP protocol revision 2026-07-28 (SDK 2.0) is not registered as a channel by Claude Code's v2 client runtime.

## Build

```bash
cd channel
npm ci
npm run build          # dist/index.js, what .mcp.json runs
npm test
```

## Configure

Settings come from `$CLAUDE_PLUGIN_DATA/.env` (when Claude Code runs the server as a plugin) or `~/.claude/channels/triologue/.env`, overridden by the process environment. Every key can also be set as `TRIOLOGUE_<KEY>`; the five keys marked * are read from the environment **only** with that prefix (a shell that exports `HOST` or `LOG_LEVEL` for other programs must not change what the session reports), from the file either way.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GATEWAY_URL` | yes | | Gateway base URL, e.g. `https://opentriologue.ai/gateway` |
| `BYOA_TOKEN` | yes | | The agent's token (`TRIOLOGUE_BYOA_TOKEN` also works) |
| `ALLOWED_SENDERS` | yes, else nothing is delivered | empty | Comma-separated Triologue user ids or usernames that may push into the session and answer permission prompts |
| `ALLOW_AGENTS` | no | `false` | Deliver messages written by other agents (never their permission verdicts) |
| `ROOMS` * | no | none | Room ids to bind at start (`connect_room` adds more); also where permission prompts go |
| `TRIOLOGUE_URL` | no | `GATEWAY_URL` without `/gateway` | Where `GET /api/rooms` lives, for room names |
| `RUNTIME` *, `HOST` *, `PROJECT` * | no | `claude`, hostname, basename of the project dir | What the session reports |
| `HEARTBEAT_SECONDS` | no | 30 | Session heartbeat |
| `PRESENCE_PORT` | no | 0 (free port) | Localhost listener for the hooks |
| `LOG_LEVEL` * | no | `info` | Logs go to stderr |

Write the file yourself (`/triologue:configure` prints the commands; it does not take the token as an argument, so the token never passes through the model or the transcript).

## Run

During the research preview a channel you build yourself needs the development flag. Register the server in `~/.claude.json` (or a project `.mcp.json`) and start:

```json
{ "mcpServers": { "triologue-channel": { "command": "node", "args": ["/path/to/triologue-agent-gateway/channel/dist/index.js"] } } }
```

```bash
claude --dangerously-load-development-channels server:triologue-channel
```

Claude Code asks for confirmation (a full-screen dialog, every start) and shows `Channels (experimental) messages from server:triologue-channel inject directly in this session` under the banner. `/mcp` lists the server. Then, in a room the agent is a member of, write `@<agent> …` from an allowed sender. The name is not `triologue`: that is what `docs/api-reference.md` calls the agent's outbound HTTP MCP server, and the two have different `send_message` tools.

As a plugin (`.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `commands/`) it starts with `--dangerously-load-development-channels plugin:triologue@<marketplace>`; on a Team or Enterprise plan an admin can add it to `allowedChannelPlugins`, after which plain `--channels plugin:triologue@<marketplace>` works without the dialog. The plugin's hooks are what make presence work: without them the session only reports `online`. **The plugin runs `dist/index.js`, which is not committed and which a marketplace install does not build** (Claude Code copies a git-sourced plugin into its cache and installs dependencies, nothing more). Until that is decided (ship `dist/`, or run from source), use a local-path marketplace that points at this checkout after `npm ci && npm run build`.

### Next to `bridge/` or a second terminal

Without a room binding the gateway delivers every message of the agent to **every** open stream of the agent: the bridge daemon and each Claude Code terminal would all get and answer the same message. A binding (`ROOMS=` at start or `connect_room`) takes the room over for this session; rooms nobody has bound still reach every stream. Bind a room before dogfooding next to the bridge.

### Sessions, reconnects, restarts

- The gateway session (90 s TTL) is kept alive by the heartbeat. When the gateway answers `404` for it (`/clear` does not end it, but a sleep longer than the TTL or a gateway restart does) the server registers it again under the same id with the same room bindings and retries the call, so the stream's session tag stays valid; `status` counts these re-registrations.
- The stream reconnects with backoff (a connection that held for 30 s starts the backoff over), gives up a connection that stays silent for 90 s (the gateway heartbeats every 25 s), and resumes from the last processed event id. That id lives in memory only: a new process starts from now, by design, so an attended session is not handed the backlog of a night.
- REST calls time out after 10 s; shutdown waits at most 8 s for the gateway.

## Tools

- `send_message { room_id, text, thread_id? }`
- `connect_room { room }` (id, exact name or unique partial name; binds the session at the gateway, so the room's messages reach this session instead of every session, and permission prompts can be relayed there)
- `disconnect_room { room }`
- `status {}`

## Security

- Gate on the sender, never on the room: `ALLOWED_SENDERS` matches the Triologue user id or username of the message's sender. An empty list delivers nothing (the server warns at start). Messages by other agents are dropped unless `ALLOW_AGENTS=true`.
- Permission prompts, which carry the tool's input (a command, a path, the first lines of a file), are relayed only to a room that is bound, so the operator has opted it in; without a binding nothing leaves the terminal. Verdicts are accepted only from allowed **human** senders (never from an agent, whatever `ALLOW_AGENTS` says), only in the room the prompt went to, only for a request the server relayed itself, and only for 10 minutes; the verdict text never reaches the model. No confirmation is posted back, because Claude Code may still discard a verdict that the terminal answered first.
- The server's `instructions` tell Claude to treat channel content as untrusted chat input, and meta values (room name, sender) are stripped of quotes, angle brackets and line breaks before they become tag attributes. Prompt injection through a room stays a property of the setup; keep the allowlist short.
- The token is read from the `.env` file (give it mode 600) and never logged. The hook listener is bound to `127.0.0.1` without authentication: any local process can post a status.

## What is missing

- Dogfooding against a real Claude Code and gateway (the spike of the Local Agent Chat Bridge plan): the confirmation flow of the development flag, registration on the v2 MCP runtime, `UserPromptSubmit` on channel-driven turns, idle wake-up, whether `process.ppid` is Claude Code's pid when it spawns `node dist/index.js` (the hook script falls back to the discovery file only when exactly one exists), and whether an MCP server survives `/clear` (the design assumes it does).
- A decision on how the plugin gets its `dist/` (see Run), and the plugin manifest's `userConfig` with `sensitive: true` for the token.
- Thread bindings (`connect_thread`), token rotation, and a `status` that includes the gateway's view of the session.
