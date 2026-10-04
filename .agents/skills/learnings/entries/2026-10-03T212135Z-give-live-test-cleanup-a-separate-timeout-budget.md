---
recorded: 2026-10-03T21:21:35Z
incident_date: 2026-10-03
---
# Give live-test cleanup a separate timeout budget

**Rule:** Put live-test resource cleanup in the runner's teardown hook with its own timeout budget. Give the test body enough time for its bounded setup and assertions. Attempt each resource deletion and report cleanup failures.

**Trigger surface:** A browser test that provisions a cloud sandbox, repository, account, or auth user.

**Incident:** Review of the unrun e2e session pilot found a 15-minute test budget with up to 10 minutes of sandbox startup and 8.5 minutes of explicit UI waits. Cleanup was inside the test body's `finally`. The runner could exhaust the body budget before cleanup completed. No resource leak occurred: the review preceded subscription-backed execution. The pilot now uses `afterEach`, a 25-minute body budget, and a separate two-minute cleanup budget.

**Enforcement:** e2e applies the configured `cleanupTimeout` to `afterEach`. The root pilot wrapper rejects cleanup errors and failed selected tests. No static guard currently prevents future tests from putting resource cleanup inside the body; review resource lifecycle when adding a live journey. Later live execution added confirmation of all cloud removals and bounded repository retries; the current cleanup budget is five minutes. The corrected journey and teardown passed in 86.3 seconds through the root command.
