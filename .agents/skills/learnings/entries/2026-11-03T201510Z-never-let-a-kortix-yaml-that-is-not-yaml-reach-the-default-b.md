---
recorded: 2026-11-03T20:15:10Z
incident_date: 2026-11-03
---
# Never let a kortix.yaml that is not YAML reach the default branch, and never answer one with a 500

**Rule:** A `kortix.yaml` that is not YAML never lands on the default branch
through Kortix, and never answers `500`. The git proxy refuses such a push with
`file:line:col`. `PUT /files/content` refuses such a save. If one lands anyway
(an edit made directly on GitHub), `readManifest` returns the newest commit whose
file parses, marked `fallback`, and every Kortix write answers `409 manifest_invalid`.
With no such commit, `loadProjectAgents` returns repair mode: only My Kortix runs,
and every other agent answers `409 manifest_invalid`. A new manifest reader or
writer goes through `readManifest` and `manifestWrites`, never its own
`parseManifestText` of the default branch.

**Trigger surface:** `apps/api/src/projects/manifest-io.ts` (`readManifest`,
`manifestWrites`), `projects/agents/parse.ts` (`loadProjectAgents`),
`git-proxy/index.ts` (`gateReceivePack`), `projects/git/push-manifest-check.ts`,
any route that commits `kortix.yaml`, and an agent that hand-edits `apps:` or
`agents:` in `kortix.yaml`.

**Incident:** 2026-11-03, prod v0.14.17. An agent declared an App at the top of
`apps:` that a platform write ("chore: update App …") had already stubbed at the
bottom, and pushed the duplicate key straight to the default branch. The whole
manifest stopped parsing. Every project agent and trigger turned off.
`POST /sessions` answered `500` (the parse error reached `app.onError`), so the
sidebar's "Fix with My Kortix" button failed too. `GET /agents/mykortix/config`
answered `400` in an SDK refetch loop. The file was fixed by hand. #11641 added
the push gate, the editor gate, the last-good fallback and repair mode.

**Enforcement:** `apps/api/src/projects/git/push-manifest-check.test.ts` (the
gate over real git and thin packs), `apps/api/src/__tests__/integration-builtin-agents-http.test.ts`
("a file that is not YAML (repair mode)" and "… with a valid commit before it
(last good version)": no `500`, writes `409`, roster from the last good commit),
`apps/api/src/projects/lib/secret-grant.fail-closed.test.ts` (repair mode grants
no secret). Not enforced: a push over 32 MB and an edit made directly on GitHub
are not gated; the last-good fallback covers both.
