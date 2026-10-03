---
recorded: 2026-10-02T15:21:03Z
incident_date: 2026-10-02
---
# Ship mobile patches through the eas-build-post-install hook: the root .npmrc ignore-scripts skips postinstall on EAS

**Rule:** A patch in `apps/mobile/patches/` reaches a store binary only through the `eas-build-post-install` script in `apps/mobile/package.json`. The root `.npmrc` sets `ignore-scripts=true`, so pnpm skips `postinstall` on EAS. Pin every patched package to the exact version its patch targets. Keep `postinstall` as plain `patch-package`, never `|| true`.

**Trigger surface:** Adding or bumping a patched mobile dependency. Adding a patch. Editing `apps/mobile/package.json` scripts, the root `.npmrc`, or `eas.json`.

**Incident:** 2026-10-02, found in a pre-release performance audit, before any user report. The two production EAS build logs of that day ran `pnpm install --frozen-lockfile`, skipped the post-install phase (no hook script existed), and printed no patch-package output. So those store binaries lacked the drawer close spring, the live-markdown worklet patches and the new markdown-key patch. Dev builds and OTA bundles built locally did carry them, so binaries and OTA disagreed.

**Enforcement:** `apps/mobile/lib/build-patches.test.ts` asserts three things: the `eas-build-post-install` hook exists, `postinstall` is strict, and every patched direct dependency is pinned to its patch version. Still open: assert the patch-package ✔ lines in an EAS build log; no CI lane reads EAS logs today.
