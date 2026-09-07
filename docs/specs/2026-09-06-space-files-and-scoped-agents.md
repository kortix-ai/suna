# Space files and space-scoped agents — spec addendum (2026-09-06)

> **Superseded in part (2026-09-07).** A space file no longer carries
> `instructions` or `context`. See `2026-09-07-spaces-simplified.md`.

Extends `2026-09-03-spaces.md`. Two decisions from the user on
2026-09-06: (1) every space lives in its own file, `kortix-<slug>.yaml`;
(2) an agent is either global (declared in the root `kortix.yaml`) or owned by
one space (declared in that space's file) and usable only there, or
in any space that references it. Per-space memory is out of scope.

## 1. Problem

The inline `spaces:` map puts every team's workspace in one root file:
one owner set, one merge target, and a single edit surface for the agent. A
space also had no agents of its own — every agent was project-wide, so
"give the agent less inside a space" had no place to live, and the
compile step had nothing to narrow.

## 2. Definition

| What                          | Where                                                                  |
| ----------------------------- | ---------------------------------------------------------------------- |
| A space                  | `kortix-<slug>.yaml`, sibling of the root manifest                     |
| Its identity                  | the filename: `kortix-marketing.yaml` ⇒ slug `marketing`               |
| Its own agents                | `kortix-<slug>.yaml` → `agents.<name>` (same block shape as the root)   |
| An agent borrowed from another| `kortix-<slug>.yaml` → `agents.<name>: { from: <owner-slug> }`         |
| Global agents                 | root `kortix.yaml` → `agents.<name>` (unchanged)                       |
| Scheduled work                | root `kortix.yaml` → `triggers[].space` (unchanged)               |
| Everything else               | unchanged: sessions join, grants, `object_policies`, runtime envelope  |

```yaml
# kortix-marketing.yaml
name: Marketing                      # optional, defaults to the slug
description: Campaign work.
instructions: |
  Always write in British English.
context: [docs/brand.md, .kortix/spaces/marketing/]
agent: writer                        # default, not a binding; must be usable here
sessions: shared                     # private (default) | shared
agents:
  writer:                            # owned by marketing — the root has no "writer"
    connectors: [slack]
    secrets: [BRAND_API_KEY]
  researcher:
    from: research                   # borrowed: declared in kortix-research.yaml
```

Locked decisions:

- **File discovery.** The directory holding the resolved root manifest is
  listed; every `kortix-<slug>.yaml` there is a space. `<slug>` must match
  `SLUG_RE`; any other `kortix-*.yaml` name is a validation error, never
  silently ignored. Only `.yaml`; a v1 (`kortix.toml`) project has no
  spaces. No `kortix_version` key in a space file — the root's
  version applies and must be 2.
- **The inline map is gone.** A root `spaces:` key is an error whose
  message names the file convention. Nothing shipped with the inline map, so
  there is no migration.
- **Agent names are plain and project-unique** across the root and every
  space file. A duplicate is a validation error that names both files.
  No namespacing: `project_sessions.agent_name`, the IAM object id
  (`object_type='agent'`), OpenCode's agent list and the conventional
  `.kortix/opencode/agents/<name>.md` path all stay exactly as they are.
- **Ownership.** `AgentSpec.space: string | null` names the owning
  space; `null` is global. The API `Agent` and SDK `Agent` carry the same
  field.
- **A reference imports use, not governance.** `agents.<name>: { from: <slug> }`
  must name an agent OWNED by `<slug>` (not itself a reference). The block
  may carry no other key in this addendum; narrowing (grant-set intersection)
  is a later addendum.
- **Usability rule (the only new permission).** An agent is usable in a
  session iff it is global, or owned by the session's space, or
  referenced by it. A project-level session (no space) may use global
  agents only. The IAM agent grant is unchanged and still required on top.
- **Defaults follow the rule.** `kortix-<slug>.yaml` `agent:` must be usable
  in `<slug>`; root `default_agent` must be global; `triggers[].agent` must be
  usable in `triggers[].space` (global when no space).
- **`path`.** `Space.path` becomes the file path (`kortix-marketing.yaml`),
  no longer `kortix.yaml#spaces.marketing`. `Agent.path` for an owned
  agent is `kortix-marketing.yaml#agents.writer`.
- **`Space.agents`.** The API/SDK space carries
  `agents: string[]` — the names it owns or references, in the order the
  file's `agents:` map lists them — so a host can build the roster (globals +
  these) without a second request.

## 3. Manifest (`packages/manifest-schema`)

New exports (three synchronized edits per the package's rules):

- `SpaceFileV2` — the block keys plus `agents?: Record<string, AgentBlockV2 | AgentReferenceV2>`;
  `AgentReferenceV2 = { from: string }`.
- `validateSpaceFileV2(raw, slug, issues)` — shape only: keys, types,
  `sessions`, `context`, `agents` map (an entry is a block OR `{from}`,
  never both), and that `<slug>` matches `SLUG_RE`. Returns the owned and
  referenced agent names.
- `validateManifestSetV2({ root, spaces: [{ slug, path, raw }] }, issues)`
  — cross-file rules: duplicate agent names; `from` targets exist and are
  owned; `agent:` usable in its space; `default_agent` global;
  `triggers[].agent`/`triggers[].space` usable/declared. The
  trigger→space rule moves here from the root validator (the root alone
  cannot know the slugs).
- `SPACE_FILE_RE` and `spaceFilePath(dir, slug)` /
  `spaceSlugFromPath(path)` — one place for the naming rule.
- The root v2 validator rejects `spaces:`; `ManifestV2.spaces`
  and `validateSpacesV2` are removed (never published).
- JSON schema: `apps/web/public/schema/kortix-space.v2.schema.json`
  published beside the root schemas; the root v2 schema drops `spaces`.

## 4. API (`apps/api`)

Read side:

- `projects/spaces.ts` `loadProjectSpaces(project)` lists the
  manifest directory (`listRepoFiles`) and parses each `kortix-<slug>.yaml`
  (`readRepoFile`). A bad file is an `errors[]` entry with its path; never a
  throw. `SpaceSpec` gains `agents: string[]` (owned + referenced) and
  `ownedAgents: AgentSpec[]`.
- `projects/agents.ts` `loadProjectAgents(project)` returns global agents from
  the root plus every space-owned agent, each with `space`. The set
  validator runs here; a duplicate name lands in `errors[]`.
- `git/config.ts` `ProjectConfigSummary.spaces` is built from the files.

Write side (`routes/spaces.ts`), every write one commit on the file:

- `POST` creates `kortix-<slug>.yaml`; `409 SPACE_SLUG_TAKEN` when the
  file exists. Body unchanged.
- `PATCH` rewrites the file with compare-and-swap on its blob revision
  (`commitRepoFile(..., expectedFileRevision)`); `409` on a lost race.
- `DELETE` is two always-valid commits: strip `space: <slug>` from every
  trigger in the root (skipped when none names it), then delete the file.
- `POST/DELETE .../context` edit the file's `context[]` (upload commit
  unchanged).

Gates:

- Session create (`lib/sessions.ts`): after the space default fills
  `agent_name`, the resolved agent must be usable in the session's space
  (or global for none) ⇒ `400 AGENT_NOT_IN_SPACE { error, code,
  usable_agents }`. Runs before the IAM agent gate.
- Trigger create/update (`lib/triggers.ts`): same rule on
  `{agent, space}` ⇒ `400 AGENT_NOT_IN_SPACE`.
- Compile (`lib/compile-agent-config.ts`): a session inside `<slug>` compiles
  the global agents plus the ones usable in `<slug>`; a scoped agent's block
  is read from its owning file. A project-level session compiles globals only.

## 5. SDK (`packages/sdk`, TDD, `sdk` skill rules)

- `Agent.space: string | null`, `Space.agents: string[]`,
  `Space.path` doc updated. No new endpoints.
- `apps/web/content/docs/sdk/reference.mdx` names both fields.

## 6. CLI (`apps/cli`)

- `kortix validate` validates the SET: the root plus every sibling
  `kortix-*.yaml`, reporting each issue with its file.
- `kortix spaces show/ls` print the file `path`. `kortix agents ls`
  (where it tabulates) gains a `space` column.

## 7. Web (`apps/web`)

- Composer roster: `composerSelectableAgents(agents, space)` keeps
  globals plus `space.agents`. `ProjectHome` already owns the active
  space; the roster becomes a function of it.
- Agents capability page: an owned agent shows its space as a badge.
- Create-space modal: the default-agent list is globals only (the
  space has no agents of its own yet at create time).
- Spec 27: after the sidebar create, the repo holds
  `kortix-marketing.yaml` (read back through the API's files/commits
  surface).

## 8. Docs

- `apps/web/content/docs/project/manifest.mdx` `spaces` section rewritten
  around the file and the ownership rule; `2026-09-03` spec §2–§3 marked
  superseded by this addendum where they differ.
- `tests/spec/end-to-end.md` §12b updated; new `SPACE-6` (scoped agents).

## 9. Tests

- manifest-schema: file validator, set validator (duplicates, `from`,
  defaults, triggers), root rejects `spaces:`, schema sync.
- API: loader unit (directory listing → specs/errors), route flows SPACE-1..5
  re-pointed at the file, `SPACE-6`: an agent owned by `marketing` — session
  create at project level `400 AGENT_NOT_IN_SPACE`; inside `marketing`
  passes the scope gate; `GET /agents` shows `space: 'marketing'`;
  a `from:` reference makes it usable in `sales`; trigger with a scoped agent
  and the wrong space `400`.
- SDK: type/surface snapshots.
- Web: spec 27 file read-back; unit for the roster filter.

## 10. Work packages

| WP | Scope | Commit |
| --- | --- | --- |
| A | manifest-schema validators, exports, JSON schema, tests | `feat(manifest): kortix-<slug>.yaml space files and owned agents` |
| B | API read side: loaders, `Agent.space`, `Space.agents`, config summary | `feat(api): read spaces from kortix-<slug>.yaml, agents carry their owner` |
| C | API write side: routes on the file, delete in two commits, flows SPACE-1..5 | `feat(api): space writes land in kortix-<slug>.yaml` |
| D | API gates + compile: usability rule, `SPACE-6` | `feat(api): an agent runs only where it is declared or referenced` |
| E | SDK fields + docs | `feat(sdk): Agent.space and Space.agents` |
| F | Web roster + badge + modal + spec 27 | `feat(web): the composer offers the agents usable in the picked space` |
| G | CLI validate set + output | `feat(cli): validate the manifest set` |
| H | Docs, e2e spec, routes manifest, final verification | `docs: space files and scoped agents` |
