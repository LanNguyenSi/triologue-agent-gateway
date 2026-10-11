## Summary

<!-- One or two sentences. What changed? -->

## Motivation

<!-- Why this change? Link the issue if applicable. -->

## Test plan

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npx tsc --noEmit` and `npm run test:coverage`
- [ ] `sdk/` or `bridge/` changed: that package's type check, `npm run test:coverage` and `npm run build` (see CONTRIBUTING.md)
- [ ] For protocol changes: dogfooded against a real Triologue server
- [ ] Manual smoke check: <!-- command or scenario -->

## Notes for reviewer

<!-- Anything non-obvious. -->
