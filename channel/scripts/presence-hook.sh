#!/bin/sh
# Forwards a Claude Code hook payload (stdin JSON) to the Triologue channel
# server's presence listener. The server writes its port and a per-start
# secret to <state dir>/sessions/<claude pid>.json (mode 0600); this script's
# parent chain leads to the same Claude Code process, and only that file is
# used, only when it is a regular file of this user. The secret travels in a
# header read from a here-document on fd 3, so it never appears in curl's
# argv (which other local users can see). Never fails the hook: any problem
# exits 0.
set -u
state_dir="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/channels/triologue}"
dir="$state_dir/sessions"
[ -d "$dir" ] || exit 0

# A regular file (not a link) owned by this user: someone else who can write
# into the directory must not point the post, payload included, at a port of
# theirs. (find and id rather than test -O, so a test can check it.)
owned() { [ -n "$(find "$1" -type f -user "$(id -u)" 2>/dev/null)" ]; }

payload="$(cat)"
file=""
# The hook shell's parent is Claude Code when the command was exec'd, else
# the parent of the shell is. No other file counts: another Claude Code
# session's hooks must not post into this one's channel session.
for pid in "$PPID" "$(ps -o ppid= -p "$PPID" 2>/dev/null | tr -d ' ')"; do
  if [ -n "$pid" ] && owned "$dir/$pid.json"; then file="$dir/$pid.json"; break; fi
done
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
