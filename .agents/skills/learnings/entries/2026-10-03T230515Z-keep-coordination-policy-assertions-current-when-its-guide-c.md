---
recorded: 2026-10-03T23:05:15Z
incident_date: 2026-10-03
---
# Keep coordination policy assertions current when its guide changes

**Rule:** When the Meta guide changes, update its test to assert the current coordination policy. Preserve the prohibition on project work and the delegation contract. Do not gate the sandbox on an obsolete heading or sentence.

**Trigger surface:** Editing the platform-owned Meta guide or verifying its generated Dockerfile.

**Incident:** On 2026-10-03, the awake repository run on `4bfcec6a0f` passed every core lane but failed package quality. The Meta Dockerfile test expected a heading and sentence removed by the earlier Meta change. Its renderer and test matched `origin/main` byte for byte. A focused run reproduced the text failure. The diagnostics timing guard passed that focused run without changing its threshold. Updating two assertions to the current orchestrator policy produced eight passing focused tests.

**Enforcement:** `packages/shared/src/sandbox/__tests__/meta-dockerfile.test.ts` checks the emitted orchestrator policy and prohibition on project work. Its existing toolchain, session coordination, token scope, and excluded-toolchain assertions remain required. The default root gate runs the package test.
