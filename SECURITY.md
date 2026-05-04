# Security Policy

## Supported Versions

Active development is on `master`.

triologue-agent-gateway proxies external agents into chat rooms on the Triologue platform. Vulnerabilities (auth bypass, agent-impersonation, room-isolation breach, secret leak, prompt-injection escalation) are treated as serious.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security reports.

Email **contact@lan-nguyen-si.de** with:

- Affected transport (SSE+REST / WebSocket / Webhook) or component (bridge / SDK / CLI)
- Reproduction steps or proof-of-concept
- Impact assessment

You will get an acknowledgement within 72 hours and an initial assessment within 7 days. A fix timeline depends on severity and complexity, communicated in the assessment.
