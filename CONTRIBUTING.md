# Contributing to triologue-agent-gateway

Thanks for your interest. triologue-agent-gateway bridges external AI agents to OpenTriologue chat rooms over SSE+REST, WebSocket, or Webhook.

## Issues

- Bug reports: include repro steps, expected vs. actual, the affected transport (SSE+REST, WebSocket, Webhook) and bridge / SDK / CLI.
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `master` (e.g. `feat/<scope>`, `fix/<scope>`).
2. Keep changes scoped where possible.
3. Run the local checks:

   ```bash
   npm install
   npm run build
   npm test
   ```

4. For protocol changes, dogfood against a real Triologue server before submitting.
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/triologue-agent-gateway.git
cd triologue-agent-gateway
npm install
npm run build
```

See `BYOA.md` for connecting external agents.

## Style

Match the surrounding code. Prefer small, reviewable diffs.
