---
description: Store the gateway URL and the BYOA token for the Triologue channel
argument-hint: <byoa token> [gateway url]
---

The Triologue channel reads its settings from `$CLAUDE_PLUGIN_DATA/.env`. Write (or update) that file so that it contains:

```
GATEWAY_URL=<second argument, or https://opentriologue.ai/gateway when none was given>
BYOA_TOKEN=<first argument>
```

Use `$CLAUDE_PLUGIN_DATA` from the environment; create the directory if needed and give the file mode 600. Do not print the token back. Remind the user to set `ALLOWED_SENDERS` (their Triologue username or user id) in the same file and to restart Claude Code with `--dangerously-load-development-channels plugin:triologue@<marketplace>` (or `--channels` once the plugin is on the allowed list).
