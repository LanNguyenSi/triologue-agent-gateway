# Log

<!-- Add new entries at the top, newest first. -->

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
