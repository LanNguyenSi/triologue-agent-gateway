#!/usr/bin/env bash
# Runs `npm audit --audit-level=high --json` in the current directory and hands
# the result to audit-gate.mjs, which classifies it (exit 0 CLEAN / 1 FINDINGS /
# 2 OUTAGE / 3 UNCLASSIFIED) against .github/audit-allowlist.json. One copy of
# this wrapper serves every audit step of ci.yml (root, bridge, sdk, channel),
# so the four gates cannot drift apart. The step's exit code is this script's.
#
# Environment (all optional):
#   AUDIT_ALLOWLIST      allowlist file; default: .github/audit-allowlist.json at the repo root
#   AUDIT_TIMEOUT_SECS   bound on the npm audit call; default 60
#   AUDIT_GATE_SCRIPT    classifier; default audit-gate.mjs next to this script (tests swap it)
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="${AUDIT_GATE_SCRIPT:-$HERE/audit-gate.mjs}"
ALLOWLIST="${AUDIT_ALLOWLIST:-$HERE/../../.github/audit-allowlist.json}"

# npm's implicit HTTP client applies no timeout of its own to the
# advisories/bulk request (observed: it hangs indefinitely against a
# black-holed endpoint, with zero output). This local bound lets the gate
# notice that case at all instead of running out the step budget.
AUDIT_TIMEOUT_SECS="${AUDIT_TIMEOUT_SECS:-60}"

OUT="$(mktemp)"
ERR="$(mktemp)"
GATE_LOG="$(mktemp)"
trap 'rm -f "$OUT" "$ERR" "$GATE_LOG"' EXIT

# GitHub Actions runs `run:` steps as `bash -e`; without this guard, `set -e`
# would kill the script right at the command on any non-zero exit (findings,
# outage or a timeout alike), before the classification below ever runs.
set +e
timeout "${AUDIT_TIMEOUT_SECS}s" npm audit --audit-level=high --no-fund --json >"$OUT" 2>"$ERR"
STATUS=$?

# The classifier's exit code is the step's exit code. Its output is kept so
# that exit 0 can be required to come with the CLEAN line: a path to a
# different existing file exits 0 without classifying and must not pass.
node "$GATE" --allowlist "$ALLOWLIST" --status "$STATUS" --stdout "$OUT" --stderr "$ERR" | tee "$GATE_LOG"
GATE_STATUS="${PIPESTATUS[0]}"
set -e

if [ "$GATE_STATUS" -ne 0 ]; then
  exit "$GATE_STATUS"
fi
if ! grep -q '^npm audit gate: CLEAN: ' "$GATE_LOG"; then
  echo "::error::npm audit gate: the classifier exited 0 without printing the 'npm audit gate: CLEAN' line; treating as UNCLASSIFIED"
  exit 3
fi
