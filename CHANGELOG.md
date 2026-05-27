# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/LanNguyenSi/triologue-agent-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LanNguyenSi/triologue-agent-gateway/releases/tag/v0.1.0
