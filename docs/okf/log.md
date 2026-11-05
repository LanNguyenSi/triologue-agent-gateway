# Log

<!-- Add new entries at the top, newest first. -->

- 2026-11-05T06:25:14Z, optional thread on every send path: `src/thread-id.ts` (new, shared parser), `src/triologue-bridge.ts` (`sendAsAgent` takes `threadId`, +6 lines), `src/byoa-sse.ts` (+6 lines in `POST /messages`), `src/index.ts` (+1 import, +2 in `/send`, +9 in the WebSocket `message` handler), `src/byoa-mcp.ts` (`thread_id`). No routing or token claim changed; citations into the three files re-pointed, every anchor re-read at source, changed docs re-stamped.
- 2026-11-05T06:13:37Z, `threadId` and `senderId` added to the SSE and WebSocket message payloads: `src/triologue-bridge.ts` (+5 lines: the callback type and the `message:new` normalisation), `src/byoa-sse.ts` (+2 lines in `AgentMessage`), `src/index.ts` (+2 lines in the loop-1 frame, +2 in the loop-2 fanout). message-delivery-routing.md: the normalisation claim now names `threadId`, loops 1 and 2 state the two fields, 27 citations re-pointed. agent-token-lifecycle-and-trust-boundary.md (28) and process-bootstrap-and-local-state.md (21): citations re-pointed, every anchor re-read at source, no claim changed. All three re-stamped. Follow-up in the same change: `senderId` is normalised to null (never an empty string) in `src/triologue-bridge.ts` (+4 lines before the callback), citations after that point re-pointed again.
- 2026-10-15T11:28:46Z, re-verified against the changed sources. Message order: the context
  of `fetchMessagesSince` is passed through oldest first. Loop 3 now calls the
  loop guard after the mention and WebSocket checks, and mention matching
  lower-cases the key and the username too (`isMentioned` in
  `src/loop-guard.ts`). The read tracker, metrics log and JWT cache resolve
  through `STATE_DIR` (`src/state-dir.ts`), which the image sets to
  `/app/state`. The task-assignment section states that Triologue sends
  `task:assigned` only to the assignee. All line citations in the three docs
  were re-pointed; message-delivery-routing.md,
  agent-token-lifecycle-and-trust-boundary.md and
  process-bootstrap-and-local-state.md re-stamped.
  `okf-kit check --json --require-anchors docs/okf` (okf-kit 0.19.0) on the
  committed tree: 0 errors, 3 warnings (the same three reserved-files-structure
  findings on `index.md` and `log.md` as before this change), no sources-fresh
  or citation findings, exit 0.

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
