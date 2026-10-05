---
recorded: 2026-09-04T07:35:22Z
incident_date: 2026-09-04
commit: 77681271d3
---
# A runtime decision and its artifact must use one immutable Git SHA

**When:** selecting a runtime and compiling its boot artifact from a moving Git ref.
**Incident:** session creation read `runtime` and resolved the branch tip in parallel, so a push
between those reads could select Pi from one commit and boot an artifact from another commit.
**Rule:** resolve the ref once, then read the manifest and compile every artifact at that SHA.
**Enforcer:** `sessions.fast-boot-git-hint.test.ts` requires the manifest read after SHA resolution.
