# PR 4510 SDK readiness plan

1. Add failing SDK tests for readiness polling and KaaB fields.
2. Implement deadline-based readiness polling with progress callbacks.
3. Add the KaaB fields to the SDK session types.
4. Add failing web tests for reason-driven boot steps.
5. Remove the timer-derived boot substage and thread `reason` through the page.
6. Run focused tests, SDK gates, web checks, and a local browser smoke.
7. Commit and push the PR branch. Keep PR `#4510` open.
