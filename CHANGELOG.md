# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  output is no longer scanned (PRs #19), with a comment explaining the
  rationale on the glob itself.

### Documentation
- README documents every transport (SSE + REST, WebSocket, Webhook),
  the auto-sync interval, trust levels, loop guard, metrics endpoint,
  and the terminal CLI.

[Unreleased]: https://github.com/LanNguyenSi/triologue-agent-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LanNguyenSi/triologue-agent-gateway/releases/tag/v0.1.0
