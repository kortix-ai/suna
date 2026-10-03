---
recorded: 2026-10-03T19:24:50Z
incident_date: 2026-10-03
---
# Give the manifest validator and the runtime grant parser one resolver, never two

**Rule:** A grant-set value that `validateManifest` accepts must resolve to the same grant in `parseAgentEntryV2`. Resolve `kortix_permissions`, `connectors`, `secrets` and `apps` through one shared function, and test every accepted input form (`"all"`, `"none"`, `[]`, `["*"]`, `["*", leaf]`, an unknown leaf) against both.

**Trigger surface:** Editing `packages/manifest-schema` grant validation or JSON schema enums, `resolveGrantSet`, `parseGrantSet`, `validateKortixAction`, or `grantFromLoadedAgents`.

**Incident:** 2026-10-03, prod. An agent session in an internal project wrote `kortix_permissions: ["*", "project.gitops.merge"]` to its own `kortix.yaml` entry. `validateManifest` returned no issue (`index.ts` exempts `*`; the JSON schema enum lists it). The v2 runtime parser kept `*` literal, `validateKortixAction("*")` rejected it, the whole agent entry went to `loaded.errors`, and `grantFromLoadedAgents` returned `permissions/connectors/env = []`. Every session of that agent, new and running (per-prompt re-mint), was deny-all for about 50 minutes until a human reverted the manifest. Agents then posted invented explanations ("token minted without platform grants") to Slack. Same failure class as the `project.cr.*` alias wipe (`bbb32a9530`): one bad string in one dimension removes every dimension.

**Enforcement:** none yet: a parity test that runs each accepted grant form through `validateManifest` and `extractAgents` and asserts the same resolved grant; plus per-prompt re-mint keeping the last-known-good grant when the running agent's entry fails to parse.
