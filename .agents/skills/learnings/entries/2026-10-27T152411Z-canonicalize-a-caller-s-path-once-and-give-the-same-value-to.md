---
recorded: 2026-10-27T15:24:11Z
incident_date: 2026-10-27
---
# Canonicalize a caller's path once and give the same value to the access check and the read it guards

**Rule:** Normalize a caller's repo path once with `canonicalTreePath` / `normalizeTreePath` (`apps/api/src/projects/git/mirror.ts`), then pass that one value to the permission check and to the git read. Never check the raw string and read a normalized one. A check that matches paths must use the same normalizer as the read.

**Trigger surface:** A route that reads, lists, archives or writes a repo path a caller sends, and any deny-list or allow-list matched against repo paths (`buildResourceDenier` in `apps/api/src/projects/lib/project-resources.ts`).

**Incident:** 2026-10-27, KRTX-3403. The resource denier stripped one leading `./`. The git read stripped `./` plus any following `/` and a trailing `/`. A project member scoped out of an agent read its file as `.//agents/<name>.md` or `agents/<name>.md/` from `files/content`, `files/raw` and `files/history`, and `files/archive?path=.` zipped the whole repository. The denier also skipped every `kortix.yaml` agent, so in a declarative project the plain path read the hidden file. `././x` and the root (`.`, `./`) answered 500. Found by an API review on dev; no report of use.

**Enforcement:** Flow `FILE-15` (`tests/src/flows/files.flow.ts`) reads a hidden agent's file under 7 spellings through content, raw and history, and archives the root and `agents/` under 9 spellings, as a scoped-out member. `apps/api/src/__tests__/unit-resource-denier.test.ts` asserts the same spellings against the denier.
