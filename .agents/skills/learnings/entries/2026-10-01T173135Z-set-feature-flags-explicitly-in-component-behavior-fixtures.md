---
recorded: 2026-10-01T17:31:35Z
incident_date: 2026-10-01
---
# Set feature flags explicitly in component behavior fixtures

**Rule:** When a component gains a query-backed feature flag, update its behavior fixtures with an explicit flag state. Keep the real component and its assertions; do not change production defaults to satisfy tests.

**Trigger surface:** Static React component tests that mock SDK collaborators and render without a query provider, or expect behavior behind a default-off flag.

**Incident:** KRTX-921's post-merge packages report named a boot-shell ownership failure. The earlier human-messaging flag change left shell fixtures calling the real query hook without context and left the chat ask fixture disabled. Fresh main reproduced twelve failures across three files. Explicit enabled fixtures restored all 28 existing assertions without changing SDK dispatch or production behavior.

**Enforcement:** `instant-session-shell-delivery.test.tsx`, `use-instant-session-send.test.tsx`, and `session-chat.test.tsx` run through the web unit suite and the packages lane. Run that lane before handing off a repair.
