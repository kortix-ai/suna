---
recorded: 2026-10-06T11:17:28Z
incident_date: 2026-10-05
---
# Export only handlers from a celld worker's entry module: celld loads every named export as a handler

**Rule:** The entry module of a celld worker exports only Durable Object
classes and the `default` fetch handler. Put constants, helpers and parsers in
another module and import them.

**Trigger surface:** adding an `export` to `apps/pi-worker-js/src/worker.js`
or to the entry of any worker that celld loads.

**Incident:** 2026-10-05, branch `pi-worker-js`. `worker.js` exported the
string `CELL_VERSION` for tests. celld treats every named export of the entry
as a handler and refused the deployment: `Incorrect type for map entry
'CELL_VERSION'`. No session could boot until the export moved to
`src/kortix/prompt.js`. Unit suites import modules directly, so they stayed
green.

**Enforcement:** `apps/pi-worker-js/test/session-e2e.mjs` boots the built
bundle on a real `celld dev` and goes red when celld refuses to load it.
The CI `packages` lane runs it (`tests/bin/package-quality.ts` ->
`apps/pi-worker-js/test/all.sh`, celld pinned by `test/fetch-celld.mjs`).
