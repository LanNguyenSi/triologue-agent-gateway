---
description: Show how to configure the Triologue channel (gateway URL, token, allowed senders)
argument-hint: [gateway url]
---

The Triologue channel reads its settings from `$CLAUDE_PLUGIN_DATA/.env`, and the token only from there (never from the environment). The BYOA token is a secret: never ask the user to paste it into the conversation and never write it yourself. Instead, print the following for the user to run in their own shell, with `$CLAUDE_PLUGIN_DATA` replaced by its value from your environment and the gateway URL replaced by `$ARGUMENTS` when one was given (default `https://opentriologue.ai/gateway`):

```bash
mkdir -p "<CLAUDE_PLUGIN_DATA>"
umask 077
cat > "<CLAUDE_PLUGIN_DATA>/.env" <<'ENV'
GATEWAY_URL=<gateway url>
BYOA_TOKEN=<paste the byoa_… token from Triologue → Settings → My Agents>
ALLOWED_SENDERS=<your Triologue user id, or user:<your username>>
# ROOMS=<room id to bind at start, optional>
ENV
chmod 600 "<CLAUDE_PLUGIN_DATA>/.env"
```

If the file already exists, tell the user which of the three keys it is missing (read it with `grep -c '^KEY=' …`, never print its contents), and that the channel refuses to start while the file is readable by others (`chmod 600` fixes it). Then remind them:

- that a plain `ALLOWED_SENDERS` entry is a Triologue user id and matches only the sender's id, and that a username needs the `user:` prefix (`user:lan`); an entry written as a bare username matches nobody;
- that the file wins over the environment for `GATEWAY_URL`, `TRIOLOGUE_URL`, `ALLOWED_SENDERS` and `ALLOW_AGENTS` (a plain `GATEWAY_URL` exported for the bridge is ignored), and that the gateway URL must be `https` unless it points at this machine;

- to restart Claude Code with `--dangerously-load-development-channels plugin:triologue@<marketplace>` (or `--channels` once the plugin is on the allowed list);
- that without `ALLOWED_SENDERS` every room message is dropped, and that a session receives only rooms it is bound to (`ROOMS` or `/triologue:connect`);
- that in auto mode and in acceptEdits mode a message from an allowed sender can make the session run tools without any approval; the default mode asks, and relays the prompt to the bound room;
- that answering from the room needs an approval for `send_message` each time unless their settings allow it: a `permissions.allow` entry with the tool's name as the approval prompt shows it (in the server form `mcp__triologue-channel__send_message`, see `settings.example.json`), which also lets Claude post into the agent's rooms without asking.
