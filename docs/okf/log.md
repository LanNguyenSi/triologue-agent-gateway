# Log

<!-- Add new entries at the top, newest first. -->

- 2026-11-07T16:32:01Z, re-stamp after `/health` gained `version` (`src/index.ts`, `src/version.ts`) and the websocket upgrade tests. Anchors and claims re-verified against the change; `agent-token-lifecycle-and-trust-boundary.md` names the version field; citations re-pointed with `okf-kit repoint`.
- 2026-11-05T07:17:39Z, session-aware delivery and presence push: `src/index.ts` loop 2 asks the registry for the sessions bound to the thread, else the room, and passes them to `fanoutToSSEClient`, which targets the streams tied to those sessions (`?session=` on `/byoa/sse/stream`, limit 2 per session) and falls back to every stream; replay keeps targeted events to their sessions. New `src/presence-push.ts` turns registry events into `POST /api/agents/me/presence` calls with the agent token from `getCurrentTokenForAgent` (`src/auth.ts`). message-delivery-routing.md: loop 2 gains the binding step, the diagram the target node, the replay section the per-session rule and the per-session stream limit, one more breaking change. agent-sessions.md: the presence consumer is described, `src/presence-push.ts` added to its sources. Citations into the changed files re-pointed in all four docs, every anchor re-read at source, changed docs re-stamped. Review follow-up in the same change: loop 2 runs its lookups without blocking loop 3 and the handler awaits them at the end, the registry client fails fast (no offline queue), a hard cap of 10 streams per agent, fanout stores the full target list for replay, the pusher re-pushes after an in-flight post when state changed; loop 3 citations re-pointed to loop 3, agent-token-lifecycle-and-trust-boundary.md names the presence post as a place the agent token leaves the gateway.
- 2026-11-05T06:49:28Z, agent sessions added: new doc agent-sessions.md (sources `src/sessions.ts`, `src/rate-window.ts`, `src/byoa-sse.ts`, `src/index.ts`) written and verified at the source. `consumeWindow` moved from `src/byoa-sse.ts` to `src/rate-window.ts` (27 lines gone from byoa-sse.ts after the rotate route) and `src/index.ts` gained the registry wiring, the mount and the sweep timer; citations into both files re-pointed in the three existing docs, every anchor re-read at source, no claim changed, changed docs re-stamped. Review follow-up in the same change: every route runs inside `guarded`, connect and touch write hash and TTL in one MULTI, touch reads the hash back, bind re-checks the hash after the write and caps a session at 200 bindings, expire re-checks before it removes, the agents set is never shrunk; agent-sessions.md rewritten for that and process-bootstrap-and-local-state.md now says three Redis clients and lists the sessions mount.
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
