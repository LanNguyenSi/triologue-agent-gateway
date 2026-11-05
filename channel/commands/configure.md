---
description: Show how to configure the Triologue channel (gateway URL, token, allowed senders)
argument-hint: [gateway url]
---

The Triologue channel reads its settings from `$CLAUDE_PLUGIN_DATA/.env`. The BYOA token is a secret: never ask the user to paste it into the conversation and never write it yourself. Instead, print the following for the user to run in their own shell, with `$CLAUDE_PLUGIN_DATA` replaced by its value from your environment and the gateway URL replaced by `$ARGUMENTS` when one was given (default `https://opentriologue.ai/gateway`):

```bash
mkdir -p "<CLAUDE_PLUGIN_DATA>"
umask 077
cat > "<CLAUDE_PLUGIN_DATA>/.env" <<'ENV'
GATEWAY_URL=<gateway url>
BYOA_TOKEN=<paste the byoa_… token from Triologue → Settings → My Agents>
ALLOWED_SENDERS=<your Triologue username or user id>
# ROOMS=<room id to bind at start, optional>
ENV
```

If the file already exists, tell the user which of the three keys it is missing (read it with `grep -c '^KEY=' …`, never print its contents). Then remind them to restart Claude Code with `--dangerously-load-development-channels plugin:triologue@<marketplace>` (or `--channels` once the plugin is on the allowed list), and that without `ALLOWED_SENDERS` every room message is dropped.
