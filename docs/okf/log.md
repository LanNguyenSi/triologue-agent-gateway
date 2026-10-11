# Log

<!-- Add new entries at the top, newest first. -->

- 2026-10-11T17:08:47Z, re-verified after comment-only source changes in
  `src/index.ts`, `src/loop-guard.ts`, `src/triologue-bridge.ts` and
  `src/webhook-dispatch.ts` (file header comments, one loop comment in
  `src/index.ts` and the `X-Triologue-Secret` deprecation comment). No line
  moved and no claim changed; message-delivery-routing.md,
  agent-token-lifecycle-and-trust-boundary.md and
  process-bootstrap-and-local-state.md re-stamped.
  `okf-kit check --json --require-anchors docs/okf` (okf-kit 0.16.0) on the
  committed tree: 0 errors, 0 warnings, 0 notices, exit 0.

- 2026-10-11T16:01:03Z, wording and citations tightened, sources unchanged.
  message-delivery-routing.md: the normalisation citation now covers the
  `timestamp` fallback, the not-awaited dispatch carries a citation, the
  mention section states that a key with an upper-case letter never matches,
  and the diagram's loop-3 webhook edge names the `webhookUrl` check.
  agent-token-lifecycle-and-trust-boundary.md: a stream or WebSocket opened
  with a rotated token keeps receiving after grace expiry.
  process-bootstrap-and-local-state.md: `argv[1]` is absolute but not
  extension-resolved, `start()` reuses a valid cached session token, and the
  image also holds `package.json` and the lockfile.
  `okf-kit check --json --require-anchors docs/okf` (okf-kit 0.16.0) on the
  committed tree: 0 errors, 0 warnings, 0 notices, exit 0.

- 2026-10-11T15:44:20Z, agent-token-lifecycle-and-trust-boundary.md corrected
  against `src/index.ts`: the per-request index check covers `POST /send`,
  `POST /byoa/sse/messages` and the MCP endpoint, while a WebSocket checks
  the token once at `auth` and reuses it for later sends; the gateway token
  fetches unread context only on loop 3 (webhook, and openclaw-inject agents
  not connected over WebSocket). Sources unchanged.
  `okf-kit check --json --require-anchors docs/okf` (okf-kit 0.16.0) on the
  committed tree: 0 errors, 0 warnings, 0 notices, exit 0.

- 2026-10-11T12:42:24Z, bundle introduced: scaffolded with `okf-kit init docs/okf`,
  unused templates removed, three docs written and verified against the
  sources at the branch base: message-delivery-routing.md,
  agent-token-lifecycle-and-trust-boundary.md,
  process-bootstrap-and-local-state.md. Added the warn-only
  `.github/workflows/okf-staleness.yml` (okf-kit 0.16.0, branch `master`).
  `okf-kit check --json --require-anchors docs/okf` (okf-kit 0.16.0) on the
  committed tree: 0 errors, 0 warnings, 0 notices, exit 0.
