---
recorded: 2026-10-06T12:17:31Z
incident_date: 2026-10-06
---
# Pin every identity-carrying CodeMirror package to one version with a root pnpm override

**Rule:** Before merging any PR that adds a workspace dependency or re-resolves
`pnpm-lock.yaml`, keep every identity-carrying CodeMirror package
(`@codemirror/state`, `@codemirror/view`) at exactly one resolved version: the
root `pnpm.overrides` pins them (`"@codemirror/state": "6.7.5"`,
`"@codemirror/view": "6.43.12"`). Never replace the pin with a per-path bump.
When one copy must move, move the override pin and the direct dependency in the
same commit, then re-run the lockfile invariant test.

**Trigger surface:** Editing any workspace `package.json`, resolving the
lockfile during a release, or touching `apps/web/src/components/file-editers/`
(editor assembly).

**Incident:** 2026-10-06, prod release `dc3a82d6b` (release PR #9153,
v0.13.50, merged 2026-10-04). Re-resolving deps while adding `happy-dom` /
`playwright` / `e2e` devDependencies forked the graph: the `codemirror@6.0.2`
meta subtree re-resolved to `@codemirror/state` 6.7.6 + `@codemirror/view`
6.43.13 while the app's direct chain kept 6.7.5 / 6.43.12. Two live
`@codemirror/state` copies broke `instanceof Extension` in `CodeEditor`
(`code-editor.tsx` passes app-built extensions into `getExtensions`-assembled
`basicSetup`), throwing "Unrecognized extension value in extension set" on
session pages: >220 client exceptions in ~29 h, Better Stack error-spike
incident 1027910841.

**Enforcement:** `apps/web/scripts/single-codemirror-version.test.mjs` fails
the web suite whenever `pnpm-lock.yaml` resolves more than one version of
`@codemirror/state` or `@codemirror/view` (same guard as
`single-next-version.test.mjs`).
