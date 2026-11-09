#!/bin/sh
# Forwards a Claude Code hook payload (stdin JSON) to the Triologue channel
# server's presence listener. The server writes its port and a per-start
# secret to <state dir>/sessions/<claude pid>.json (mode 0600); this script's
# parent chain leads to the same Claude Code process. The secret travels in a
# header read from a here-document on fd 3, so it never appears in curl's
# argv (which other local users can see). Never fails the hook: any problem
# exits 0.
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
# Fallback (for example when the server runs under tsx): the one and only
# discovery file. With several sessions on the machine the pid must match, or
# this session would post its status as another one's.
if [ -z "$file" ]; then
  set -- "$dir"/*.json
  if [ "$#" -eq 1 ] && [ -f "$1" ]; then file="$1"; fi
fi
[ -n "$file" ] || exit 0

port="$(sed -n 's/.*"port":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$file" | head -n 1)"
secret="$(sed -n 's/.*"secret":[[:space:]]*"\([0-9a-f][0-9a-f]*\)".*/\1/p' "$file" | head -n 1)"
[ -n "$port" ] && [ -n "$secret" ] || exit 0

if command -v curl >/dev/null 2>&1; then
  printf '%s' "$payload" | curl -s -m 2 -X POST -H 'Content-Type: application/json' -K /dev/fd/3 --data-binary @- "http://127.0.0.1:$port/hook" >/dev/null 2>&1 3<<HEADER
header = "X-Triologue-Hook-Secret: $secret"
HEADER
fi
exit 0
