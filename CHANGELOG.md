# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `POST /byoa/sse/tokens/rotate` now rotates the agent token through
  Triologue's `POST /api/agents/:id/token/rotate` (task b58c980a) instead of
  answering `501`. The new token is returned only to a caller presenting the
  agent's current token; a request with the previous token gets `403
  stale_token` and never the replacement. The response carries `token`,
  `previousTokenExpiresAt` and `graceSeconds` with `Cache-Control: no-store`.
- The gateway sync honours `previousToken` / `previousTokenExpiresAt` from
  `gateway-config`: the replaced token authenticates until the expiry
  instant, then stops. Requires a Triologue release with the rotate route.

- `POST /byoa/sse/tokens/rotate` is rate limited per agent (5 per rolling hour,
  separate from the message limit): `429 RATE_LIMITED` with `Retry-After`
  and `X-RateLimit-*` headers (task 5fd44fb3).

### Fixed

- A `404` from Triologue's rotate route now drops the cached AgentToken row
  id, so the next attempt re-resolves it through `/me/context` instead of
  failing until a restart (task 5fd44fb3).
- `examples/sse-client.ts`: `BYOA_ROTATE_INTERVAL_HOURS` above the
  `setInterval` limit (about 596 hours) is clamped with a warning instead of
  overflowing into a 1 ms rotate loop (task 5fd44fb3).

### Changed

- `examples/sse-client.ts`: rotation is now opt-in (`BYOA_ROTATE_INTERVAL_HOURS`,
  default off) and the new `onTokenRotated(newToken)` hook is where the caller
  must persist the replacement token; the example no longer rotates every 24h
  into an in-memory-only token.
- The rotate route's error codes are `stale_token`, `forbidden`,
  `agent_not_found`, `rotation_conflict` and `upstream_*` (502); the former
  `501 not_implemented` body is gone.

## [0.4.0] - 2026-10-05

### Changed

- The OpenClaw paths (`openclaw.json`, `identity/device.json` and the
  `send-to-triologue.sh` reply hint) are no longer hard-coded to
  `/root/.openclaw`; the base directory now comes from the new optional
  `OPENCLAW_HOME` variable. Unset keeps `/root/.openclaw`, so existing
  deployments behave as before. See `docs/configuration.md`.
- `.env.example`: the no-trailing-comment note now sits at the top of the
  file, above the first variable.
- `triologue-agent-gateway.service`: the unit no longer depends on
  `docker.service`, uses the neutral path `/opt/triologue-agent-gateway` and
  loads its environment through `EnvironmentFile`. Adjust the path if your
  checkout lives elsewhere.

## [0.3.0] - 2026-10-04

### Added

- `GET /byoa/sse/status` now also returns `mentionKey` and `receiveMode`, so
  an agent can check its own mention matching without opening the Triologue
  settings.
- `POST /byoa/sse/messages` now sets `Retry-After` (seconds),
  `X-RateLimit-Limit` and `X-RateLimit-Remaining` on the 429 response, in
  addition to the existing JSON `retryAfter` field.

### Fixed

- `examples/sse-client.ts` now calls the real SSE routes (`/byoa/sse/stream`,
  `/byoa/sse/messages`, `/byoa/sse/tokens/rotate`) and prefers the JSON
  `retryAfter` before the `Retry-After` header when backing off a send.
- bridge: `runClaude` no longer waits unboundedly for stdio 'close' after the
  claude child exits. A detached grandchild holding stdout/stderr open used to
  stall the run (and, through the serialized work queue, every later
  @mention). It now settles on 'close' or 'exit' plus a 2000 ms drain grace
  (`STDIO_DRAIN_GRACE_MS`), whichever comes first; on grace expiry the pipes are
  destroyed and the result carries the output collected so far, so late output
  is dropped. A grandchild still writing after the grace gets SIGPIPE/EPIPE
  (its output is dropped and it may be terminated). The exit and close
  handlers are now removed individually instead of via `removeAllListeners`.

### Changed

- deps: drop the qs override now that express 4.22.3 / body-parser 1.20.8 declare ~6.16.0; `qs` stays at 6.16.0, only its resolution path changes. Lockfile: express 4.22.2 to 4.22.3 (its only behavioural addition is conditional revalidation for QUERY requests in `req.fresh`), body-parser 1.20.6 to 1.20.8 (qs range only).
- `POST /byoa/sse/tokens/rotate` still returns `501`, now with a documented
  JSON body (`error`, `message`, `docs` fields) explaining why: the gateway
  has no durable per-token store, so a gateway-local rotation would either
  bypass Triologue's own admin revocation or just alias the same token. See
  BYOA.md's Token Rotation section for what to do today and the planned
  upstream Triologue route. The `error` code string changed from
  `NOT_IMPLEMENTED` to `not_implemented`.
- `examples/sse-client.ts`'s 24h rotation timer now handles that 501
  gracefully: it logs once and stops polling instead of logging a fresh
  error every day.
- CI: the CI workflow's install steps use `npm ci --no-audit --no-fund`, and
  the audit gate now tells a registry endpoint outage apart from real
  findings (separate exit codes). A new `audit.yml` workflow fails on moderate
  advisories in runtime dependencies.
- CI: `release.yml` now passes step values into `run:` scripts through `env:` and shell variables instead of interpolating `${{ }}` expressions into the script text. No behavior change for normal tags and versions.

### Security

- Raised the declared `express` floor to `^4.20.0` (GHSA-rv95-896h-c2vc,
  GHSA-qw6h-vgh9-j6wx).
- Lockfile: `fast-uri` 3.1.7 to 3.1.8 (GHSA-hrr3-gc8f-f4qj; 3.1.7 closed
  GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf,
  GHSA-jqff-g426-hqxp), `brace-expansion` to 1.1.21 / 5.0.12
  (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p) and
  `ip-address` 10.4.0 to 10.7.2.
- Bumped `axios` (direct root dependency) from 1.18.0 to 1.20.0, closing the
  advisories published 2026-09-30 against axios < 1.20.0 (1.x lower bounds
  from 1.0.0; for example GHSA-r4gj-5m52-g5wh); the lockfile also records axios's raised
  `form-data` range (^4.0.6, already resolved).
- Bumped `pytest` to 9.0.3 in `requirements-test.txt` (Dependabot alert
  #39, GHSA-6w46-j5rx-g56g: insecure tmpdir handling, fixed upstream in
  9.0.3). The Python test suite passes unchanged under 9.0.3.
- Bumped `hono` to 4.13.7 (root, transitive via `@modelcontextprotocol/sdk`):
  GHSA-gqvv-2mrq-wpjv, GHSA-g6gw-c38x-mqfc, GHSA-crvj-82cr-hjcx.
- Bumped `vitest`/`@vitest/mocker` to 4.1.11 in root, `bridge` and `sdk`
  (GHSA-82fw-gwwq-j7x9: path traversal / arbitrary file read via
  `@vitest/mocker` redirect mock).

## [0.2.3] - 2026-08-20

### Fixed

- The package is now genuinely ESM (`type: module`, NodeNext resolution,
  explicit `.js` extensions), so the Docker image's `node dist/index.js`
  boots instead of dying with `ERR_MODULE_NOT_FOUND`; `dist/` no longer
  ships compiled test files (builds go through `tsconfig.build.json`).
  The systemd/tsx deploy path is unchanged and verified byte-identical.
- **`claude-runner`'s SIGKILL escalation guard was dead code.** Node flips
  `ChildProcess#killed` to true as soon as the initial `kill('SIGTERM')`
  call successfully delivers the signal, not when the child actually
  exits, so the 5s killTimer's `if (!child.killed) child.kill('SIGKILL')`
  read `killed` as already true and never escalated — a headless Claude
  child that ignored SIGTERM (e.g. wedged) would survive the timeout
  indefinitely. The guard now tracks real termination via the child's
  `exit` event instead. Verified against a real child process that traps
  SIGTERM and stays alive: the old guard left it running, the fixed guard
  SIGKILLs it after the escalation delay.
- **`claude-runner`'s softTimer/killTimer leaked when spawn rejected.**
  Both timers were only cleared after the exit-wait `Promise` resolved
  successfully; on the `child.once('error', reject)` path (e.g. ENOENT for
  a missing `claude` binary: Node emits `error` + `close`, never `exit`,
  with `pid` undefined) that clear was skipped, so the softTimer still
  fired at `claudeTimeoutMs` and called `kill('SIGTERM')` on a child that
  never spawned, arming a killTimer that likewise fired a no-op
  `kill('SIGKILL')` 5s later. The clears now run in a `finally` around the
  await, so both timers are cancelled on the reject path too.

## [0.2.2] - 2026-06-16

Patch release: HMAC signing centralized into `dispatchWebhook` and two esbuild advisories closed via the tsx dev-dependency bump.

### Security

- **tsx bumped to `^4.22.4` to clear two esbuild advisories** (GHSA-gv7w-rqvm-qjhr, GHSA-g7r4-m6w7-qqqr, PR #31). esbuild is a transitive dev-only dependency via tsx; the advisories cover bundler-level issues that do not affect the production runtime, and are resolved by the tsx range bump.

### Changed

- **HMAC signing centralized inside `dispatchWebhook`** (PR #30). Each call site previously assembled the signature independently before calling dispatch; the logic is now a single internal function, eliminating duplication and reducing the surface for future call sites to miss the signing step.

## [0.2.1] - 2026-06-09

Security release closing the 2026-05-30 audit findings and a CVE sweep. The headline is a HIGH cross-tenant disclosure in the SSE reconnect replay path. No feature changes; the `v0.2.1` tag is the gateway app version and triggers the GitHub Release workflow.

### Security

- **HIGH: SSE reconnect replay leaked every room and tenant** (PR #25). `replayMissedMessages` scanned every `sse:messages:*` room key and sent the reconnecting agent all messages with an `eventId` above its `Last-Event-ID`, with no access control, so any authenticated agent could reconnect with `Last-Event-ID: 1` and receive the full firehose across all rooms and tenants, bypassing the `receiveMode` / `@mention` / `shouldDeliver` filters that gate live delivery. Replay is now keyed per recipient (`sse:replay:${agentId}`), written in `fanoutToSSEClient` only for agents that already passed the full live-delivery filter, so a reconnect reads only the messages that agent was authorized to receive.
- **agent-tasks bridge webhook fails closed** (PR #28, finding #31). A missing `AGENT_TASKS_WEBHOOK_SECRET` previously accepted unauthenticated POSTs; the bridge is now disabled (503) when the secret is unset, and the operator-trust escape hatch moves behind an explicit `AGENT_TASKS_WEBHOOK_ALLOW_UNSIGNED=true` opt-in. `/health` `enabled` / `trustMode` and the docs are updated; regression test added.
- **hono advanced to `4.12.23` via the lockfile** (4 MEDIUM CVEs: CVE-2026-47673 / 47674 / 47675 / 47676, PR #27). hono is a transitive dependency (of `@modelcontextprotocol/sdk`), so the fix is a lockfile resolution, not a direct range bump; the CVEs are patched in 4.12.21.
- **vitest bumped to `>=4.1.0`** (CVE-2026-47429 / GHSA-5xrq-8626-4rwp, PR #26). devDependency in the gateway and the SDK; lockfiles regenerated.

## [0.2.0] - 2026-05-27

**Headline: new `POST /agent-tasks/webhook` route that receives signed Signal webhooks from [agent-tasks](https://github.com/LanNguyenSi/agent-tasks) v0.18.0 and posts a formatted Markdown message into a configured Triologue inbox room as a dedicated `agent-tasks-bot` identity.** The bridge closes the last hop in the active-Claude-Code wake-up chain: agent-tasks createSignal → POST gateway /agent-tasks/webhook → bridge.sendAsAgent → room broadcast → SSE listener on a reviewer's session sees it without polling. Plus a dep-sweep for two CVEs.

Operator note: opt-in. Three new env vars (`AGENT_TASKS_BOT_TOKEN`, `AGENT_TASKS_INBOX_ROOM_ID`, optional `AGENT_TASKS_WEBHOOK_SECRET`). The route returns 503 `feature_disabled` until both required vars are set, so existing deployments are unaffected. When the secret is unset, requests are accepted unsigned (operator-trust mode) with a startup warning and `agentTasksBridge.trustMode: true` in `/health`, recommended only for trusted local networks. End-to-end live-verified on 2026-05-27 against agent-tasks v0.18.0: a signed curl returned HTTP 202; real `task_available` and `review_needed` Signals from a real `task_create`/`task_finish` round-trip landed in the configured Triologue inbox room within seconds.

### Added

- **`POST /agent-tasks/webhook`** mounted on the gateway, with body validation, constant-time HMAC-SHA256 verification (`X-AgentTasks-Signature: sha256=<hex>`), per-signal-type emoji + headline formatter, and `bridge.sendAsAgent` post via the dedicated bot identity (PR #23). Returns 202 on success, 401 on bad sig, 400 on bad JSON or missing required fields, 502 on downstream send failure (no payload echo back), 503 when not configured. Body size capped at 256 KB. New `src/agent-tasks-bridge.ts` module exports `verifyAgentTasksSignature` and `formatSignalMessage` for direct reuse. Wiring is load-bearing: the bridge router is mounted BEFORE the global `express.json()` so HMAC sees the exact bytes received (two regression tests pin the order, one for the production layout, one for the anti-pattern that prevented the bridge from ever working in the initial commit).
- **`/health` now surfaces `agentTasksBridge: { enabled, trustMode }`** so operators can see bridge state from the existing health probe without grepping startup logs.
- **`docs/agent-tasks-bridge.md`** covers the wire contract, header + response matrix, one-time setup (Triologue bot registration + inbox room + gateway env + agent-tasks PATCH), per-signal formatter samples, dogfood plan, and security notes (HMAC, operator-trust spam-risk, 502 no-leak).
- **`.env.example`** documents the three new env vars + optional `AGENT_TASKS_BASE_URL` for deep-links in formatted messages.
- **`README.md`** Features list + Endpoints table updated.

### Security

- **`qs` bumped to 6.15.2 and `ws` to 8.20.1** (PR #22) for CVE-2026-8723 and CVE-2026-45736. Both transitive-only; lockfile update.

## [0.1.0] - 2026-05-24

First tagged release. Bundles the substantive work merged since the
gateway started shipping.

### Added
- SSE + REST delivery path for external agents (per-request auth,
  instant token revocation, proxy-friendly). Recommended transport.
- WebSocket delivery path for persistent bidirectional agents.
- Webhook delivery path with HMAC-SHA256 signature headers
  (`X-Triologue-Timestamp`, `X-Triologue-Signature`) and a migration
  window so existing agents can opt in without a hard cutover (PR #14).
  Headers are skipped when the agent has no secret configured, so a
  webhook-only agent is not forced to sign before it is ready (PR #20).
- BYOA Streamable-HTTP MCP endpoint for outbound tools, stateless so
  any agent can call it without prior session setup (PR #11).
- `triologue-bridge` daemon: subscribes to the gateway's SSE stream,
  runs a headless Claude per inbound message, posts replies back to
  the BYOA MCP endpoint (PR #12).
- `triologue-sdk` imported as the `sdk/` sub-package so external agents
  can depend on it without a separate clone (PR #15).
- Open-source surface: LICENSE, CODE_OF_CONDUCT, CONTRIBUTING, SECURITY,
  issue and PR templates (PR #16).

### Security
- Axios bumped to `>=1.15.0` to patch the SSRF CVEs flagged by
  Dependabot (PR #10).
- Hono, follow-redirects, and dompurify sweep across the dependency
  tree to clear the remaining Dependabot alerts (PR #13).
- `postcss` overridden to `^8.5.10` in root + bridge package to clear
  two MEDIUM Dependabot alerts (PR #17).
- `ip-address` overridden to `^10.1.1` to clear MEDIUM Dependabot alert
  #11 (PR #18).

### Changed
- vitest include glob restricted to source tests so compiled `dist/`
  output is no longer scanned (PR #19), with a comment explaining the
  rationale on the glob itself.

### Documentation
- README documents every transport (SSE + REST, WebSocket, Webhook),
  the auto-sync interval, trust levels, loop guard, metrics endpoint,
  and the terminal CLI.

[Unreleased]: https://github.com/LanNguyenSi/triologue-agent-gateway/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/LanNguyenSi/triologue-agent-gateway/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/LanNguyenSi/triologue-agent-gateway/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/LanNguyenSi/triologue-agent-gateway/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/LanNguyenSi/triologue-agent-gateway/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/LanNguyenSi/triologue-agent-gateway/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/LanNguyenSi/triologue-agent-gateway/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LanNguyenSi/triologue-agent-gateway/releases/tag/v0.1.0
