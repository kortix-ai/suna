---
recorded: 2026-10-19T21:32:49Z
incident_date: 2026-10-19
---
# When you retire a tool name, keep every manifest version that may name it valid

**Rule:** When you remove a name from `KORTIX_TOOL_NAMES` (or any registry a manifest grants by name), add it to `RETIRED_KORTIX_TOOLS` and make every validator that reads that name answer a warning: v2 `tools:`, and v3 `agents.<name>.tools` lists and `exclude` lists. The v3 validator runs at session start, so an error there stops every session of the project before the provider is called.

**Trigger surface:** Removing or renaming a Kortix tool, skill, command or extension name; changing `validateToolGrantV3` or `validateToolsV2` in `packages/manifest-schema`; a v2 → v3 upgrade that copies tool names; a session that fails with category `sandbox-provider` and no `kortix.provider_events` row (read `project_sessions.metadata.provisioning_error`).

**Incident:** 2026-10-19, dev. #9902 (2026-10-15) added two connector tools; while it was live, an agent-run v2 → v3 upgrade wrote `tools: { exclude: [kortix-connectors_call, kortix-connectors_describe] }` into every agent of a v3 project. #10073 (2026-10-16) removed the tools and kept only v2 manifests valid. From then on every session of that project failed about 700 ms after create with "The sandbox provider could not start this session", and no Platinum call was made. The real error was only in `project_sessions.metadata.provisioning_error`. Fixed by the PR that adds this entry.

**Enforcement:** `packages/manifest-schema/src/__tests__/kortix-tool-names.test.ts`: a v2 `tools:` line and a v3 agent list or exclude that name a retired tool are warnings, and an unknown name is still an error.
