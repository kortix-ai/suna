---
recorded: 2026-10-30T16:19:23Z
incident_date: 2026-10-30
supersedes: 2026-10-19T213249Z-when-you-retire-a-tool-name-keep-every-manifest-version-that.md
---
# When you retire a name a manifest grants, keep it a warning in every list that may name it

**Rule:** When you remove a name from `KORTIX_TOOL_NAMES` (or any registry an agent grants by name), add it to `RETIRED_KORTIX_TOOLS` and make `agents.<name>.tools` lists and `exclude` lists answer a warning. An error there switches the agent off at run time (`usableManifest`), so every session that names it fails. The superseded entry named v2 `tools:` too; v2 no longer exists.

**Trigger surface:** Removing or renaming a Kortix tool, skill, command or extension name; changing `validateToolGrantV3` in `packages/manifest-schema`.

**Incident:** 2026-10-30, branch `one-schema` (rule change, no outage): one kortix.yaml format, and a manifest error now turns off only the broken agent instead of failing every session of the project.

**Enforcement:** `packages/manifest-schema/src/__tests__/kortix-tool-names.test.ts`: a retired name in an agent list or exclude is a warning, an unknown name is still an error.
