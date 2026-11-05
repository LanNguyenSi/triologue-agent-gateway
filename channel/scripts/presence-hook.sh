#!/bin/sh
# Forwards a Claude Code hook payload (stdin JSON) to the Triologue channel
# server's presence listener. The server writes its port to
# <state dir>/sessions/<claude pid>.json; this script's parent chain leads to
# the same Claude Code process. Never fails the hook: any problem exits 0.
set -u
state_dir="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/channels/triologue}"
dir="$state_dir/sessions"
[ -d "$dir" ] || exit 0

payload="$(cat)"
file=""
# The hook shell's parent is Claude Code when the command was exec'd, else
# the parent of the shell is.
for pid in "$PPID" "$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ')"; do
  if [ -n "$pid" ] && [ -f "$dir/$pid.json" ]; then file="$dir/$pid.json"; break; fi
done
# Fallback (for example when the server runs under tsx): the newest file.
if [ -z "$file" ]; then
  file="$(ls -t "$dir"/*.json 2>/dev/null | head -n 1)"
fi
[ -n "$file" ] || exit 0

port="$(sed -n 's/.*"port":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$file" | head -n 1)"
[ -n "$port" ] || exit 0

if command -v curl >/dev/null 2>&1; then
  printf '%s' "$payload" | curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:$port/hook" >/dev/null 2>&1
fi
exit 0
