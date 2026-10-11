# Knowledge bundle index

Curated OKF knowledge bundle for the triologue-agent-gateway repo. These docs
capture cross-file semantics and invariants that no single source file
states on its own: how one inbound message is routed across the delivery
channels, how agent tokens enter, rotate and leave the gateway, and what the
process does at import, at startup and on disk. For the feature references
see the root `README.md`, `BYOA.md` and `docs/`; these docs do not
duplicate them. The Triologue server side of the same integration (agent
registration, `gateway-config`, token rotation) is covered by the triologue
repository's own bundle, starting at
[agent-integration-surfaces.md](https://github.com/LanNguyenSi/triologue/blob/master/docs/okf/agent-integration-surfaces.md).

Every claim about code carries an anchored line citation
(`path:N-M#"text on the cited end line"`). When a change touches a file
listed in a doc's `sources:`, re-verify that doc, re-point the citations
whose content moved, set its `timestamp` to the verification instant and
add an entry to [log.md](log.md). `.github/workflows/okf-staleness.yml`
runs `okf-kit check --require-anchors` on every pull request, warn-only.

## Modules

- [Process bootstrap and local state](process-bootstrap-and-local-state.md),
  what importing `src/index.ts` already does (router mount order for the
  raw-body HMAC route, Redis clients, metrics timer), the module-is-main
  guard and its extensionless-invocation trap, the startup order, and the
  local state files, including their location under the Docker runtime user.

## Invariants

- [Message delivery routing](message-delivery-routing.md), the three
  delivery loops in `src/index.ts` (WebSocket, SSE, webhook and
  openclaw-inject), loop-guard semantics (trust level ignored, @mention
  bypass on WebSocket and SSE only), WebSocket precedence, SSE plus webhook
  double delivery, and what the SSE replay buffer holds.
- [Agent token lifecycle and trust boundary](agent-token-lifecycle-and-trust-boundary.md),
  the gateway service account, the `gateway-config` sync and its
  `AGENTS_CONFIG` fallback, current and grace tokens, rotation brokering,
  revocation latency per path, and what the gateway token reaches.
