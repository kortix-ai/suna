---
recorded: 2026-10-22T17:02:24Z
incident_date: 2026-10-22
---
# Re-run every side effect a render publishes when React commits a different instance

**Rule:** A module singleton that a component sets during render (`registerQueryClient`) can be set twice on one page load: React discards a render (a hydration retry, a suspension, Strict Mode) and commits a second instance. Anything that runs once against "the" instance (a cache restore, a persister) must follow every instance that registers, not only the first. And run a journey that measures first paint on a production build (`next build` + `next start`): `next dev` registers two `QueryClient`s and fails journey 34 test 1 with or without a change.

**Trigger surface:** Writing or changing a provider that publishes an instance from render, or code that reads it from outside React (`apps/web/src/lib/device-caches.ts`, `packages/ui/src/internal/lib/query-client-singleton.ts`). Running journey 34 locally.

**Incident:** 2026-10-22, release suite for v0.14.6 (run 39801928689). Journey 34 test 1 ("a reload with every read held…") failed 4 of 4 tries on staging after #10712 (the snapshot asks `transcript=0`): the reload stayed on "Opening your project". #10718 reverted #10712 and v0.14.6 shipped without it. Instrumented locally on `next dev`: the device-cache restore (9 queries) ran on the first registered client; a second client registered 14 ms later; the gate read the second, empty client and waited for the held `GET /projects/:id`. The staging run did not reproduce locally on a production build (the test passed 7 of 7 with and without #10712). #10720 re-landed #10712 with `onEachQueryClient`, and journey 34 passed 10 of 10 on a production build.

**Enforcement:** `apps/web/src/lib/device-caches.test.ts` ("a client registered after the restore … gets the kept queries too"); journey 34 in the release suite. Not proven: that the staging failure was this mechanism. The next release suite on staging is the check.
