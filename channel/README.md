# @triologue/channel

A [Claude Code channel](https://code.claude.com/docs/en/channels-reference) for Triologue. Claude Code spawns this server (`triologue-channel`) over stdio; it connects to the agent gateway with the agent's BYOA token and makes the running interactive session a participant of the rooms you bind it to:

- messages from a bound room arrive in the session as `<channel source="triologue-channel" room="…" thread_id="…" sender="…">` events (after a sender gate); a session with no bound room or thread receives nothing;
- a session can be bound to one thread of a room (`connect_thread`) and then gets only that thread;
- Claude answers with the `send_message` tool, into the room or the thread;
- a permission prompt in the terminal is relayed to the bound thread, else a bound room, as `Reply "yes abcde" or "no abcde"`, and an allowed person's answer there becomes the verdict;
- the session registers at the gateway's `/byoa/sessions`, binds rooms (`ROOMS` at start or `connect_room`) and threads (`connect_thread`), tags its stream with the session, and the hooks that ship with the plugin report whether it is idle, working, waiting for an approval or failed, so the room shows it next to the agent's name.

This is the attended counterpart of [`bridge/`](../bridge/README.md): the bridge spawns a headless `claude -p` per mention, the channel pushes into the session you are already working in. Status: **prototype**. A spike ran the server form (below) end to end against Claude Code 2.1.319 and a gateway with `/byoa/sessions`; the room-binding rules, the hook listener's secret, the token-file rules and the failure reporting described here came after it and are tested against a fake gateway (`tests/stdio.test.ts` spawns the server the way Claude Code does), not yet live. The plugin form and a packaged release are not done yet (see "What is missing").

```
Triologue room
  → gateway SSE stream (?session=<id>)
  → this server (gate: self, agents, allowlist, bound rooms and threads, most recent binding, verdicts)
  → notifications/claude/channel → your running Claude Code session
  ← send_message tool → POST /byoa/sse/messages → the room
```

## Requirements

- Node.js 22 or newer and a `claude` that supports channels (2.1.258 or newer; a research preview, so the flags are not in `--help`). Last verified against Claude Code 2.1.319; run the smoke check under "Run" after every Claude Code update.
- A Triologue agent (Settings → My Agents) with its `byoa_…` token, and a gateway from the release that carries `/byoa/sessions` (0.6.0 or newer). An older gateway still streams and sends; the session features are then off.
- Authentication through claude.ai or a Console API key; channels are not available on Bedrock, Vertex or Foundry. On a Team or Enterprise plan an admin has to enable channels.
- The server pins `@modelcontextprotocol/sdk` 1.x on purpose: a server that negotiates MCP protocol revision 2026-07-28 (SDK 2.0) is not registered as a channel by Claude Code's v2 client runtime. `renovate.json` at the repository root disables major updates of the SDK for `channel/`.

## Build

```bash
cd channel
npm ci
npm run build          # dist/index.js, what .mcp.json runs
npm test
```

`dist/` is not committed (it is ignored); CI type-checks, tests with coverage and builds `channel/` on Node 22 and 24. Shipping a built `dist/` with a release is the packaging step, not done yet.

## Configure

Settings come from `$CLAUDE_PLUGIN_DATA/.env` (when Claude Code runs the server as a plugin) or `~/.claude/channels/triologue/.env`, and from the process environment. Every key except the token can also be set as `TRIOLOGUE_<KEY>`. Which one wins depends on the key:

- The four keys marked † decide where the token is sent and who may command the session. **The file wins** for them; the environment counts only as `TRIOLOGUE_<KEY>` and only when the file does not set the key. A plain `GATEWAY_URL`, `ALLOWED_SENDERS` or `ALLOW_AGENTS` in the environment (`bridge/` asks you to export `GATEWAY_URL`) is ignored, and the server warns with the variable's name, never its value; when the file has no `GATEWAY_URL` either, the "`GATEWAY_URL` is required" error says that the exported one was ignored. `TRIOLOGUE_URL` already has the prefix, so it follows where the gateway URL comes from: when the file sets `GATEWAY_URL` but not `TRIOLOGUE_URL`, the Triologue URL is derived from the file's `GATEWAY_URL` and a `TRIOLOGUE_URL` exported in a shell (the gateway server's own variable) is ignored with a warning naming it; an environment `TRIOLOGUE_URL` counts only when the gateway URL also comes from the environment (`TRIOLOGUE_GATEWAY_URL`) and the file has neither key.
- The five keys marked * are read from the environment **only** with the prefix (a shell that exports `HOST` or `LOG_LEVEL` for other programs must not change what the session reports), and the environment wins over the file.
- The rest: the environment wins, with or without the prefix.
- In the file, `TRIOLOGUE_<KEY>` wins over `<KEY>`. An empty value counts as not set, in the file and in the environment.
- `CLAUDE_PLUGIN_DATA` still comes from the environment (Claude Code sets it for a plugin): it says where the file is, so it cannot come from the file. The file found there still has to pass the mode check below.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GATEWAY_URL` † | yes | | Gateway base URL, e.g. `https://opentriologue.ai/gateway`. Must be `https`; plain `http` only to `localhost`, `127.0.0.1` or `::1`, since the token is sent there |
| `BYOA_TOKEN` | yes, **file only** | | The agent's token (`TRIOLOGUE_BYOA_TOKEN` in the file also works). Read only from the `.env` file; see Security |
| `ALLOWED_SENDERS` † | yes, else nothing is delivered | empty | Comma-separated entries for who may push into the session and answer permission prompts: a plain entry is a Triologue **user id** and matches only the sender's id; `user:<username>` matches only the username |
| `ALLOW_AGENTS` † | no | `false` | Deliver messages written by other agents (never their permission verdicts) |
| `ROOMS` * | no | none | Room ids to bind at start (`connect_room` adds more); also where permission prompts go |
| `TRIOLOGUE_URL` † | no | `GATEWAY_URL` without `/gateway` | Where `GET /api/rooms` lives, for room names; the token is sent there too, so the same `https` rule applies. Set it in the file; see the precedence above for the environment |
| `RUNTIME` *, `HOST` *, `PROJECT` * | no | `claude`, hostname, basename of the project dir | What the session reports |
| `HEARTBEAT_SECONDS` | no | 30 | Session heartbeat |
| `PRESENCE_PORT` | no | 0 (free port) | Localhost listener for the hooks |
| `LOG_LEVEL` * | no | `info` | Logs go to stderr |

Your user id is the `sender_id` of the `<channel>` tags: start with `user:<your username>`, read the id off your first message, and list it instead. An entry written as a bare username matches nobody, since a plain entry is an id.

Write the file yourself, readable by you only (`/triologue:configure` prints the commands; it does not take the token as an argument, so the token never passes through the model or the transcript):

```bash
mkdir -p ~/.claude/channels/triologue
umask 077
$EDITOR ~/.claude/channels/triologue/.env
chmod 600 ~/.claude/channels/triologue/.env
```

The server refuses to start when the file is readable or writable by the group or others (`chmod 600` fixes it). A `BYOA_TOKEN` or `TRIOLOGUE_BYOA_TOKEN` in the environment is ignored with a warning: Claude Code hands its whole environment to every stdio server, and the MCP config's `env` block and the command line are visible to other programs, so the token belongs in the file and nowhere else.

## Run

During the research preview a channel you build yourself needs the development flag. Register the server in `~/.claude.json` (or a project `.mcp.json`) and start:

```json
{ "mcpServers": { "triologue-channel": { "command": "node", "args": ["/path/to/triologue-agent-gateway/channel/dist/index.js"] } } }
```

```bash
claude --dangerously-load-development-channels server:triologue-channel
```

Claude Code shows a confirmation dialog titled "warning loading development channels" on every start (one confirmation; an unattended start with the development flag therefore does not work). Then, in a bound room the agent is a member of, write `@<agent> …` from an allowed sender. The name is not `triologue`: that is what `docs/api-reference.md` calls the agent's outbound HTTP MCP server, and the two have different `send_message` tools.

**Smoke check after every Claude Code update** (the channel protocol is a research preview and may change): start as above, confirm the dialog, check that the channel start line appears under the banner and that `/mcp` lists `triologue-channel` as connected, then send one message from a bound room and see the reply arrive. If the server is listed but no message arrives, start Claude Code with `--debug` and look for `Channel notifications registered`.

As a plugin (`.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `commands/`) it starts with `--dangerously-load-development-channels plugin:triologue@<marketplace>`; on a Team or Enterprise plan an admin can add it to `allowedChannelPlugins`, after which plain `--channels plugin:triologue@<marketplace>` works without the dialog. The plugin's hooks are what make presence work: without them the session only reports `online` (in the server form, add the entries of `hooks/hooks.json` to your settings with the script's absolute path). The hook script finds the server by Claude Code's process id, so it works when Claude Code starts the server directly (`node …/dist/index.js`); under `tsx` or `npm run dev` the server's parent is another process and the hooks report nothing. The plugin runs `dist/index.js`, which a marketplace install does not build (Claude Code copies a git-sourced plugin into its cache and installs dependencies, nothing more); until the packaged release exists, use a local-path marketplace that points at this checkout after `npm ci && npm run build`.

### Permission modes

What a room message can make the session do depends on the session's permission mode, not on this server:

- In the default mode every tool call that needs an approval asks in the terminal, and the prompt is relayed to the bound room (`yes <id>` / `no <id>`).
- **In auto mode and in acceptEdits mode (and with `bypassPermissions`) a message from an allowed sender can make the session run tools without any relayed approval.** A Bash command requested from a room ran without a prompt in auto mode. Claude treats channel content as untrusted chat input (the server's instructions say so), but that is not a boundary. Switch to the default mode (Shift+Tab) before you bind a room, or keep `ALLOWED_SENDERS` to yourself.
- `send_message` itself needs an approval in the default mode, so each answered request costs two relayed approvals (the tool, then the reply). To answer without asking, allow the reply tool in your settings (`~/.claude/settings.json` or the project's `.claude/settings.json`); `settings.example.json` holds the entry:

  ```json
  { "permissions": { "allow": ["mcp__triologue-channel__send_message"] } }
  ```

  That name is the server form's. With the rule in place Claude can post into any room of the agent without asking, including text from files it has read; leave it out if that is not acceptable.

### Rooms and sessions

- **A session receives only the rooms it is bound to.** Without a binding (no `ROOMS`, no `connect_room`, or after `disconnect_room` of its last room) it receives nothing; the gateway still streams the agent's messages, and the server drops them (`status` counts them as `room-not-bound`).
- **Several sessions bound to the same room: only the most recently bound one answers.** It gets the room's messages; the other sessions get nothing for that room (dropped, counted as `answered-by-newer-session`, no notice in the session). They still take the verdicts for permission prompts they relayed to the room themselves, so a pending approval keeps working. `connect_room` on a room that is already bound binds it again and makes the session the most recent one; `disconnect_room` (or the session's exit) hands the room to the next most recent session that is still bound. `status` lists each bound room under `answering` or `standby`.
- The order is kept in the state directory (`bindings/<hash of the token>/<room>/`, one small file per session with its bind time; a directory there that others may enter is narrowed to 700 with a warning on stderr, and no entry is written into one that cannot be narrowed), so it covers the sessions on **this machine** that share the state directory. Sessions of the same agent on another machine are not part of it: each machine's most recent session answers. Bind a room on one machine only.
- Next to `bridge/`: the gateway sends a room's messages to the streams of the sessions bound to it, so a bound room no longer reaches the bridge daemon; a room nobody has bound reaches every stream of the agent, the bridge included, and every channel session drops it.

### Threads

A thread binding narrows a session to one conversation inside a room. The recommended pattern is **one task, one thread, one session**: open (or pick) a thread for the task, bind it from the session that works on it, and let the people talk to that session in the thread. The room stays quiet for the other sessions and for the people who do not follow the task.

- `connect_thread { room, thread_id }` binds an existing thread of the room; `connect_thread { room, title }` creates the thread through Triologue (`POST /api/rooms/<room>/threads`, a title of at most 200 characters, no root message) and binds it. `room` is an id, an exact name or a unique partial name, as for `connect_room`. The agent has to be a member of the room (the room list the server fetches shows it) or the room has to be bound already; otherwise nothing is called and the thread is refused. A thread id that does not exist in that room is refused with Triologue's `404` (a `403` when the agent is not in the room). The binding uses the gateway's `/byoa/sessions/<id>/bind` (`threads`), and is sent again with every registration, so a session the gateway had forgotten gets it back.
- **A session bound only to a thread gets the messages of that thread, not the room's top-level messages and not its other threads** (dropped, counted as `thread-not-bound` in `status`; when no session is bound to a room, the gateway sends its messages to every stream of the agent, so the server has to drop them). With the room bound as well, the session gets the whole room as before, and the bound thread's messages carry the thread title. A bound thread is delivered whether or not a more recently bound session answers the room: the gateway sends a thread's messages to the sessions bound to that thread first.
- The `<channel>` tag of a message in a bound thread has `thread_id` and `thread_title` (the title is stripped like the other attributes; other messages have no `thread_title`).
- **Replies:** `send_message` without `thread_id` posts at the top level of a room that is bound, exactly as before threads existed, whatever thread the last message came from. Only for a room of which **only threads** are bound (every message it delivers comes from a bound thread) does it go into the thread of the last message that room delivered (or the thread bound last before any message came). With several threads of one room bound, pass `thread_id` from the `<channel>` tag, because the default is only the last one that spoke. An explicit `thread_id` always wins, and `thread_id: ""` asks for the top level even where a thread would be the default. The tool does not widen where the session may post: the gateway still decides which rooms and threads accept the message.
- **Permission prompts** are relayed into the bound thread when there is one: the thread the last message came from (or the one bound last), else the room the last message came from if that is bound, else the first bound thread, else the first bound room. A `connect_room` afterwards makes the room the target again. A `yes <id>` / `no <id>` counts from an allowed human only, as in a room, and by where the prompt was posted: a prompt posted at the top level of a room is answered by any message of that room, also one inside a thread of it (as before threads existed); a prompt posted into a thread is answered only by a message in that same thread of that same room, not at the top level of the room and not in another thread.
- `disconnect_thread { thread_id }` unbinds it at the gateway; replies, prompts and delivery return to the room behaviour (the bound room, if there is one). A session that has nothing bound afterwards receives nothing. Prompts that are still outstanding stay in place: they can still be answered where they were posted (or in the terminal) until their 10 minutes are over.
- A session without thread bindings behaves exactly as described under "Rooms and sessions". `status` lists `threads` (id, room, title), `activeThread` and `permissionThread`.
- Limits: a session binds at most 50 threads (the most the gateway takes in a registration); `connect_thread` refuses a 51st with an error, before it creates anything. The "most recently bound session answers" order of the rooms is not applied to threads; two sessions bound to the same thread both get its messages, which the one-task-one-thread pattern avoids. Threads cannot be bound at start (`ROOMS` names rooms only); bind them with the tool. A thread title is read when the thread is bound and not refreshed if someone renames the thread.

### Sessions, reconnects, restarts

- The gateway session (90 s TTL) is kept alive by the heartbeat. When the gateway answers `404` for it (`/clear` does not end it, but a sleep longer than the TTL or a gateway restart does) the server registers it again under the same id with the same room bindings and retries the call, so the stream's session tag stays valid; `status` counts these re-registrations.
- Claude Code's session id is taken from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for the servers it spawns, at the first registration. The SessionStart hook fires before this server listens, so the server does not wait for it; later hooks (`/clear`, `/resume`) refresh the id.
- When the first registration fails (the gateway is down or refuses it), the session claims none of its rooms and opens no stream; the heartbeat retries the registration, and only then does the session claim its rooms (those from `ROOMS` and any `connect_room` made meanwhile) and open its stream, tagged with the session. Until then an older session bound to the same room keeps answering it. A stream without the session tag would be left out of the gateway's delivery and replay for the bound room, so the room would be lost to both sessions. Against a gateway without the sessions API the session takes part at once with an untagged stream, since that gateway sends every room to every stream. A `404` is final: when the first registration gets one (at start or at a later heartbeat), the server stops trying to register, so a session never ends up registered with an untagged stream. It stays without a gateway session until it is restarted: restart it after a gateway upgrade, or when the `404` came from a proxy or a deploy in progress (`status` then shows `session: null`).
- The stream reconnects with backoff (a connection that held for 30 s starts the backoff over), gives up a connection that stays silent for 90 s (the gateway heartbeats every 25 s), and resumes from the last processed event id. That id lives in memory only: a new process starts from now, by design, so an attended session is not handed the backlog of a night.
- While the answering session's stream is reconnecting, the gateway still counts that session as a target of the room: the older bound sessions get the message and drop it, and the gateway stores it for every bound session and replays it to the answering one when its stream is back. The message is lost only when that session has no event id to resume from yet (it has not processed any message since it started), or when no stream of the agent was open at all at that moment (the gateway then stores nothing).
- REST calls time out after 10 s; shutdown waits at most 8 s for the gateway. `/exit` ends the gateway session at once and removes the discovery and binding files.

### When the gateway refuses a relay or a send

A permission prompt the gateway does not post stays open in the terminal only. The server writes an `error:` line to stderr naming the request and the status, and `status` shows `relayFailures` (count and the last one with its status code). A refused `send_message` returns a tool error that starts with `send_message failed with status <code>:`, and `status` shows `sendFailures`. The error text carries the gateway's `detail`.

About the `502` seen with two sessions posting within seconds: the gateway's own send limit (10 messages a minute for a `standard` agent, 30 for `elevated`) answers `429 RATE_LIMITED`, not `502`. A `502 Failed to deliver message` means Triologue refused or failed the post, and the gateway puts Triologue's status in `detail`. Triologue's `POST /api/agents/message` answers `429` for its own per-agent limit (`maxMessagesPerMinute` in the agent's config, 5 a minute by default) and for a message too similar to the agent's previous one in the same room within 5 seconds; two sessions relaying near-identical prompts fit either. Which one it was is not proven; the `detail` now shown says so the next time.

## Tools

- `send_message { room_id, text, thread_id? }`
- `connect_room { room }` (id, exact name or unique partial name; binds the session at the gateway, makes it the session that answers the room on this machine, and lets permission prompts be relayed there)
- `disconnect_room { room }`
- `connect_thread { room, thread_id? , title? }` (exactly one of `thread_id` and `title`: bind an existing thread, or create one and bind it; see "Threads")
- `disconnect_thread { thread_id }`
- `status {}` (session, bound rooms as `answering` and `standby`, bound `threads`, counters, `relayFailures`, `sendFailures`)

## Security

- Gate on the sender, never on the room: a plain `ALLOWED_SENDERS` entry is a Triologue user id and matches only the sender's id; a `user:<username>` entry matches only the sender's username. The two are never compared with each other: Triologue user ids are cuids, and a username may be spelled like one, so a person who picks your id as their username does not pass. List user ids where you can: the sender id stays the same when a user renames themselves, a username does not. An empty list delivers nothing (the server warns at start). Messages by other agents are dropped unless `ALLOW_AGENTS=true`. And only bound rooms and bound threads pass.
- Permission prompts, which carry the tool's input (a command, a path, the first lines of a file), are relayed only to a thread or a room that is bound, so the operator has opted it in; without a binding nothing leaves the terminal. Verdicts are accepted only from allowed **human** senders (never from an agent, whatever `ALLOW_AGENTS` says), only in the room or thread the prompt went to, only for a request the server relayed itself, and only for 10 minutes; the verdict text never reaches the model. No confirmation is posted back, because Claude Code may still discard a verdict that the terminal answered first. See "Permission modes" for the modes in which nothing is asked at all.
- The server's `instructions` tell Claude to treat channel content as untrusted chat input, and meta values (room name, sender) are stripped of quotes, angle brackets and line breaks before they become tag attributes. Prompt injection through a room stays a property of the setup; keep the allowlist short.
- The token is read only from the `.env` file in the state directory, never from the environment or the command line, and the server refuses a file that the group or others may read or write. It is never logged. It is sent only to `GATEWAY_URL` and `TRIOLOGUE_URL`, which the file decides (see Configure) and which must be `https` unless they point at this machine.
- The hook listener is bound to `127.0.0.1` and takes a post only with the secret the server draws at every start (32 random bytes) and writes, next to the port, into the discovery file `sessions/<claude pid>.json` (created with mode 600 and renamed into place, so it is never readable by others). The server narrows an existing `sessions/` directory that the group or others may enter to 700 (and says so on stderr), and writes no discovery file into one it cannot narrow. The hook script reads only the file named after its own Claude Code's process id, and only when it is a regular file you own, so another session's hooks never post into this session and a file someone else put there is not used. It sends the secret in a header that it reads from a here-document, so it does not show up in the process list; the listener compares it in constant time and answers anything else with a bare `401`. Another local user can therefore not set the session's status; a process running as you can read the file, like everything else of yours.
- The binding files hold a process id, a bind time and the gateway session id, never the token; their directory is named after a hash of the token.
- Things this server does not control: your own user-level hooks also run on a turn that a room message starts (a hook that adds context, such as a memory hook, adds it to that turn as well), and Claude Code gives its messaging token (`CLAUDE_CODE_MESSAGING_TOKEN`) to every stdio server it spawns, this one included.

## What is missing

- Packaging: a release that ships the built `dist/` and a marketplace entry, so the plugin form installs without a local build. The plugin form (`--plugin-dir` or a marketplace, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, the manifest's `userConfig` with `sensitive: true`) has not been run against Claude Code yet, and the reply tool's name there may differ from the server form's.
- Thread bindings at start (a `THREADS` setting) and an order of the sessions bound to one thread; see "Threads".
- A gateway-side order of bindings, so that "most recently bound answers" also holds across machines (today it holds per machine).
- Token rotation, and a `status` that includes the gateway's view of the session.
- Not yet checked live: that the server survives `/clear`, and `connect_room` by room name against Triologue.
