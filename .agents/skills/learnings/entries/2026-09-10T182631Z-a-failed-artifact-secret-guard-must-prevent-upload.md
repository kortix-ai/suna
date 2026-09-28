---
recorded: 2026-09-10T18:26:31Z
incident_date: 2026-09-10
commit: 2f349d3773
---
# A failed artifact secret guard must prevent upload

**Incident.** Release run `34510232187`, attempt 3, was canceled during browser
shard 2. Cancellation left raw Playwright traces before reporter scrubbing.
The secret guard rejected the traces, but `upload-artifact` used `always()`
and uploaded them anyway. Artifact `10166938271` was deleted in this session.
The earlier attempt 1 artifact guard passed. No secret value was printed
during this investigation.

**Rule.** Diagnostic uploads run after failed or canceled tests only when
the artifact secret guard completed successfully. A failed or skipped guard
blocks upload. Preserve the guard failure as the job result.

**Enforcement.** `.github/workflows/tests-release.yml` gives both API and browser
guards the `artifact-secrets` step ID. Both upload steps require
`steps.artifact-secrets.outcome == 'success'` in addition to `always()`.
