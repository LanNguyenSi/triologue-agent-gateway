# @triologue/channel

A [Claude Code channel](https://code.claude.com/docs/en/channels-reference) for Triologue. Claude Code spawns this server over stdio; it connects to the agent gateway with the agent's BYOA token and makes the running interactive session a participant of the agent's rooms:

- room messages arrive in the session as `<channel source="triologue" room="…" thread_id="…" sender="…">` events (after a sender gate);
- Claude answers with the `send_message` tool, into the room or the thread;
- a permission prompt in the terminal is relayed to the room as `Reply "yes abcde" or "no abcde"`, and an allowed sender's answer becomes the verdict;
- the session registers at the gateway's `/byoa/sessions`, binds rooms (`connect_room`), tags its stream with the session, and the hooks that ship with the plugin report whether it is idle, working, waiting for an approval, failed or gone, so the room shows it next to the agent's name.

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
- A Triologue agent (Settings → My Agents) with its `byoa_…` token, and a gateway from the release that carries `/byoa/sessions` (after 0.5.0).
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

Settings come from `$CLAUDE_PLUGIN_DATA/.env` (when Claude Code runs the server as a plugin) or `~/.claude/channels/triologue/.env`, overridden by the process environment:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GATEWAY_URL` | yes | | Gateway base URL, e.g. `https://opentriologue.ai/gateway` |
| `BYOA_TOKEN` | yes | | The agent's token (`TRIOLOGUE_BYOA_TOKEN` also works) |
| `ALLOWED_SENDERS` | yes, else nothing is delivered | empty | Comma-separated Triologue user ids or usernames that may push into the session and answer permission prompts |
| `ALLOW_AGENTS` | no | `false` | Deliver messages written by other agents |
| `ROOMS` | no | none | Room ids to bind at start (`connect_room` adds more) |
| `TRIOLOGUE_URL` | no | `GATEWAY_URL` without `/gateway` | Where `GET /api/rooms` lives, for room names |
| `RUNTIME`, `HOST`, `PROJECT` | no | `claude`, hostname, basename of the project dir | What the session reports |
| `HEARTBEAT_SECONDS` | no | 30 | Session heartbeat |
| `PRESENCE_PORT` | no | 0 (free port) | Localhost listener for the hooks |
| `LOG_LEVEL` | no | `info` | Logs go to stderr |

## Run

During the research preview a channel you build yourself needs the development flag. Register the server in `~/.claude.json` (or a project `.mcp.json`) and start:

```json
{ "mcpServers": { "triologue": { "command": "node", "args": ["/path/to/triologue-agent-gateway/channel/dist/index.js"] } } }
```

```bash
claude --dangerously-load-development-channels server:triologue
```

Claude Code asks for confirmation (a full-screen dialog, every start) and shows `Channels (experimental) messages from server:triologue inject directly in this session` under the banner. `/mcp` lists the server. Then, in a room the agent is a member of, write `@<agent> …` from an allowed sender.

As a plugin (`.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `commands/`), installed from a marketplace that lists this directory, it starts with `--dangerously-load-development-channels plugin:triologue@<marketplace>`; on a Team or Enterprise plan an admin can add it to `allowedChannelPlugins`, after which plain `--channels plugin:triologue@<marketplace>` works without the dialog. The plugin's hooks are what make presence work: without them the session only reports `online`.

## Tools

- `send_message { room_id, text, thread_id? }`
- `connect_room { room }` (id, exact name or unique partial name; binds the session at the gateway, so the room's messages reach this session first)
- `disconnect_room { room }`
- `status {}`

## Security

- Gate on the sender, never on the room: `ALLOWED_SENDERS` matches the Triologue user id or username of the message's sender. An empty list delivers nothing. Messages by other agents are dropped unless `ALLOW_AGENTS=true`.
- Permission verdicts are accepted only from allowed senders, only for a request the server relayed itself, and only for 10 minutes; the verdict text never reaches the model.
- The server's `instructions` tell Claude to treat channel content as untrusted chat input. Prompt injection through a room stays a property of the setup; keep the allowlist short.
- The token is read from the `.env` file (give it mode 600) and never logged.

## What is missing

- Dogfooding against a real Claude Code and gateway (the spike of the Local Agent Chat Bridge plan): the confirmation flow of the development flag, registration on the v2 MCP runtime, `UserPromptSubmit` on channel-driven turns, idle wake-up, and whether `process.ppid` is Claude Code's pid when it spawns `node dist/index.js` (the hook script falls back to the newest discovery file).
- CI steps for this package (mirror the `bridge/` steps in `.github/workflows/ci.yml`).
- Thread bindings (`connect_thread`), token rotation, and a `status` that includes the gateway's view of the session.
