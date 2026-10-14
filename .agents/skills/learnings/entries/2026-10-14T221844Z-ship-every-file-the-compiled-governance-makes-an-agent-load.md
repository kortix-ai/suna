---
recorded: 2026-10-14T22:18:44Z
incident_date: 2026-10-14
---
# Ship every file the compiled governance makes an agent load, even when the session withholds the repository

**Rule:** When a session variant withholds files (no repository access, a selected agent), ship exactly the files its compiled governance makes the runtime load: today, the project tool modules the agent may call and their relative imports (`toolsRelease`). Never drop to governance-only while the governance still names a file. In kortixd, take the project tool root from the served release (`readBootReleaseRoot`), never from the served config dir.

**Trigger surface:** Changing `config-releases/builder.ts` variants or `toDescriptor`, adding a governance key that names a repository file (tools, plugins, prompts, extensions), or changing how OpenCode or pi picks its project root.

**Incident:** 2026-10-14. A customer locked agents down (`repository_access: false`, `bash: deny`, project tools per agent). Every project tool failed with "this session has no project checkout to load it from": the release for those sessions carried governance and no files. On OpenCode, a release with no OpenCode config dir also lost its tools. Fixed in PR #9909 (50a64759e4), verified on dev on OpenCode and pi.

**Enforcement:** `apps/api/src/config-releases/builder.test.ts` ("the agent variant ships exactly the modules of the project tools its agent may call"), flow `CFG-2` (restricted session: tools-only files, archive 200, other trees 403), flow `RUN-15`/`RUN-15-pi` step "an agent without the project repository still runs the project tool" (real boxes), `config-release-boot.test.ts` ("the served release is recorded as the project tool root").
