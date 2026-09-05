# Subprojects — spec (approved 2026-09-03)

Branch `subprojects`, worktree `../suna-subprojects` (web `13400`, api `13408`,
isolated Supabase `kortix-wt-subprojects`). Implementation is split into work
packages (§13) executed by subagents in this worktree; the orchestrator thread
commits and integrates.

## 1. Problem

A Kortix project is one repo, one agent roster, one flat session list. People
run many unrelated efforts inside one project (a client, a campaign, a
research thread) and today they cannot group sessions under a named effort,
give that effort standing instructions and reference files the agent always
sees, attach scheduled work to it, or share it with specific members/groups
while the rest of the project stays untouched. ChatGPT/Claude "Projects" solve
this inside one workspace. We call the equivalent a **subproject**.

## 2. Definition

A subproject is a **named container inside a project**: it groups sessions,
gives the agent standing context, owns scheduled work, and is an IAM object
granted to members/groups exactly like an agent. The manifest is the source of
truth; the database holds only the session join and the grants.

| What                          | Where                                                               |
| ----------------------------- | ------------------------------------------------------------------- |
| Identity, name, description   | `kortix.yaml` → `subprojects.<slug>`                                |
| Instructions (inline text)    | `kortix.yaml` → `subprojects.<slug>.instructions`                   |
| Context (repo paths)          | `kortix.yaml` → `subprojects.<slug>.context[]`                      |
| Default agent                 | `kortix.yaml` → `subprojects.<slug>.agent`                          |
| Session visibility mode       | `kortix.yaml` → `subprojects.<slug>.sessions` (`private`\|`shared`) |
| Scheduled work                | `kortix.yaml` → `triggers[].subproject: <slug>`                     |
| Sessions in it                | `kortix.project_sessions.subproject` (text, nullable)               |
| Who may use it                | `kortix.role_assignments` object grants, `object_type='subproject'` |
| Unscoped default for members  | `kortix.object_policies` row `subproject = closed`                  |

Decisions (approved):

- `instructions` is **inline** markdown, delivered to the sandbox by env and
  rendered by the daemon into an OpenCode `instructions` file (§7).
- `context` entries are repo-relative paths. Text files are handed to OpenCode
  `instructions` (inlined natively); directories are listed for the agent to
  read. UI uploads commit to `.kortix/subprojects/<slug>/`.
- `agent` is a **default, not a binding**; a subproject grant does **not**
  imply the agent grant (the person needs both; the grant dialog offers both).
- Scheduled work = `triggers[].subproject` back-reference; the scheduler is
  unchanged.
- No `enabled` flag (delete the block instead), no nesting, no moving a
  session between subprojects, no per-subproject memory, no feature flag.
- Create/edit/delete need `project.customize.write` (the manifest-editing
  leaf, manager tier).
- Session visibility: `sessions: private` (default) keeps the ordinary model
  (a session is its creator's unless shared); `sessions: shared` makes every
  session in the subproject readable by everyone granted the subproject. The
  subproject page's share control flips it.

**Naming note.** The unmerged `crafts-store-ui` branch renamed its marketplace
"crafts" to "subprojects". It is not on `main`; this spec owns the word on
`main`, and that branch must be renamed back if it is ever merged.

## 3. Manifest (`packages/manifest-schema`) — DONE (foundation commit)

```yaml
subprojects:
  marketing:
    name: Marketing              # optional, defaults to slug
    description: Campaign work.  # optional
    instructions: |              # optional inline markdown
      Always write in British English.
    context:                     # optional repo-relative paths (file, or dir/)
      - docs/brand.md
      - .kortix/subprojects/marketing/
    agent: writer                # optional; must name a declared agent
    sessions: private            # optional; private (default) | shared

triggers:
  - slug: weekly
    type: cron
    cron: "0 0 9 * * 1"
    prompt: Draft the weekly update.
    subproject: marketing        # optional; must name a declared subproject
```

Rules (`index.v2.ts`; tests `__tests__/subprojects.v2.test.ts`; JSON schemas
regenerated in `apps/web/public/schema/`): slug matches `SLUG_RE`; block is a
table; unknown keys are errors; `agent` must be a key of `agents:`; `sessions`
∈ {`private`,`shared`}; `name`/`description`/`instructions` strings;
`context[]` entries non-empty, not absolute, no `..`; `triggers[].subproject`
must name a declared subproject. v1 manifests ignore `subprojects`.

Exports: `SubprojectBlockV2`, `SubprojectSessionsModeV2`,
`SUBPROJECT_SESSIONS_MODES_V2`, `validateSubprojectsV2`,
`validateTriggerSubprojectRefsV2`; `ManifestV2.subprojects?`.

## 4. Database

Foundation commit: `project_sessions.subproject text` (schema + drizzle
snapshot + `migrations/20260903191413521_subprojects.sql`, which currently
also carries a plain `CREATE INDEX`).

**WP-A finishes it:** move the index to
`migrations/20260903191413522_subprojects_index.concurrent.ts`
(`CREATE INDEX CONCURRENTLY idx_project_sessions_project_subproject ON
kortix.project_sessions (project_id, subproject) WHERE subproject IS NOT NULL`,
per `packages/db/MIGRATIONS.md`), keep the `ALTER TABLE` in the `.sql`, and
append the policy seed to the `.sql`:

```sql
INSERT INTO kortix.object_policies (object_type, unscoped_default_for_member, description)
VALUES ('subproject', 'closed', 'A subproject with no grant rows is usable by the manager tier only.')
ON CONFLICT (object_type) DO NOTHING;
```

`object_type` is `varchar(16)`. `role_assignments.object_type` has an FK onto
`object_policies`, so the seed must exist before any grant row. Apply to the
worktree DB with `pnpm migrate` (Node 22 PATH) and prove with `psql`.

## 5. Authorization — identical to agents

The IAM engine is generic over `object_type`; `objectUsable` /
`filterAccessibleObjects` / `loadObjectGrants` need no change.

| File | Change |
| --- | --- |
| `apps/api/src/iam/catalog.ts` | `ObjectType` `+ 'subproject'`. |
| `apps/api/src/iam/resource-grants.ts` | `RESOURCE_GRANT_TYPES`, `CREATABLE_RESOURCE_GRANT_TYPES` `+ 'subproject'`; `hasAnyResourceGrants` also loads `subproject`. |
| `apps/api/src/projects/git/types.ts`, `git/config.ts` | `ProjectConfigSummary.subprojects: Array<{slug,name,description,agent,sessions,context,has_instructions}>` from the manifest. |
| `apps/api/src/projects/lib/project-resources.ts` | `ProjectResources.subprojects`; `projectHasResource(config,'subproject',slug)`; `filterConfigResourcesForUser` narrows `config.subprojects`. |
| `apps/api/src/projects/routes/resource-grants.ts` | GET returns `resources.subprojects: [{id,name,description}]`; POST accepts `resource_type:'subproject'` (error text `resource_type must be agent or subproject`); orphan check covers it. |

Semantics (unchanged engine): **manager tier** (owner/admin/project
manager/service account/super-admin) sees every subproject; **member tier**
sees only subprojects with a grant row naming them or one of their groups —
zero rows ⇒ zero subprojects. Grants come from the two existing generic
surfaces: `POST /projects/:id/resource-grants` and `POST /iam/assignments
{roleKey:'agent-user', scope:{type:'project',id}, object:{type:'subproject',id:<slug>}}`.
Deleting a subproject leaves grant rows orphaned (flagged `orphaned:true`).

Enforcement points (new code, all server-side):

1. **Session create** (`routes/project-sessions.ts` + `lib/sessions.ts
   createProjectSession`): `subproject` in body ⇒ must be declared (`400
   SUBPROJECT_NOT_DECLARED`) and accessible via
   `filterAccessibleObjects(actor, pid, 'subproject', [slug])` (`403
   subproject_not_accessible`, body `{error, code, accessible_subprojects}`).
   When the body names no `agent_name`, the subproject's `agent` is the
   requested agent; the ordinary agent gate then runs on it.
2. **Session inventory** (`lib/session-inventory.ts` `selectSessionRowsForViewer`
   + `lib/session-list.ts`): a row with `subproject` set and not in the
   viewer's accessible set is dropped in both scopes. With
   `sessions: shared`, a row in an accessible subproject is `canAccess: true`
   for the viewer regardless of its own visibility (lifecycle rights
   unchanged). The inventory reads the manifest's subproject map once
   (`loadProjectSubprojects`) only when some row carries a subproject. New
   query `?subproject=<slug>` filters to that subproject; `?subproject=`
   (empty string) filters to rows with none.
3. **Read-by-id and every lifecycle verb** (`lib/access.ts
   loadVisibleSession`): same two rules ⇒ `404` when inaccessible.
4. **Subproject routes** (§6): list filtered by the fold; get on an
   inaccessible one `404`; writes need `project.customize.write`.
5. **Trigger fire** (`fireGitTrigger`): the fired session inherits
   `spec.subproject` (no per-fire check; the trigger actor is manager tier).
6. **Warm sessions**: never adopted for a subproject start (web skips
   `takeWarmSessionEntry`; server refuses a warm claim/prime body carrying
   `subproject` ⇒ `400`).

## 6. API (`apps/api`)

New: `apps/api/src/projects/subprojects.ts` (`SubprojectSpec`,
`extractSubprojects(manifest)`, `loadProjectSubprojects(project)`,
`upsertSubprojectInManifest`, `removeSubprojectFromManifest`,
`stripSubprojectFromTriggers`), `apps/api/src/projects/lib/subproject-access.ts`
(`accessibleSubprojectSlugs(c, loaded, projectId, slugs)`,
`assertSubprojectAccessible(...)`), `apps/api/src/projects/routes/subprojects.ts`
(registered in `projects/index.ts`).

Wire shape (`SubprojectSchema` in `packages/api-contract/src/index.ts`):

```json
{
  "slug": "marketing",
  "name": "Marketing",
  "description": "Campaign work.",
  "instructions": "Always write in British English.\n",
  "context": ["docs/brand.md", ".kortix/subprojects/marketing/"],
  "agent": "writer",
  "sessions": "private",
  "path": "kortix.yaml#subprojects.marketing",
  "session_count": 4,
  "trigger_count": 1,
  "can_manage": true
}
```

`description`, `instructions`, `agent` are `string | null`; `context` always an
array; `sessions` always present (default `private`).

| Route | Gate | Behavior |
| --- | --- | --- |
| `GET /v1/projects/:id/subprojects` | `loadProjectForUser(read)` + `project.read` | `{subprojects: Subproject[], errors: [{slug,path,error}]}`, filtered to the caller's accessible set, sorted by slug. `session_count` counts non-deleted rows the caller can see. |
| `POST /v1/projects/:id/subprojects` | `manage` + `project.customize.write` | body `{slug?, name (required), description?, instructions?, context?, agent?, sessions?}`; slug via `slugify(name)` when omitted; invalid slug `400`; duplicate `409`; unknown `agent` `400`; bad `sessions`/`context` `400`; commits `kortix.yaml` (`feat(subprojects): add <slug>`); `201` Subproject. |
| `GET /v1/projects/:id/subprojects/:slug` | `read` + `project.read` | `404` when undeclared or inaccessible. |
| `PATCH /v1/projects/:id/subprojects/:slug` | `manage` + `project.customize.write` | partial merge of the same fields (slug immutable, `null` clears an optional field); `{}` → `200` without a commit. |
| `DELETE /v1/projects/:id/subprojects/:slug` | `manage` + `project.customize.write` | removes the block, strips `subproject:` from triggers naming it, one commit; session rows keep their column (managers still see them, members lose them). `404` unknown. |
| `POST /v1/projects/:id/subprojects/:slug/context` | `manage` + `project.customize.write` | body `{path, content}` (UTF-8 text ≤ 256 KB) — commits `.kortix/subprojects/<slug>/<basename(path)>` via `commitRepoFile`, then appends it to `context[]` (manifest commit). Returns the Subproject. |
| `DELETE /v1/projects/:id/subprojects/:slug/context?path=` | same | removes the entry from `context[]` only; never deletes repo files. `404` when the path is not listed. |

Existing routes extended:

- `POST /projects/:id/sessions` body `+ subproject?: string`
  (`SessionCreateInputSchema`); response `Session.subproject: string | null`
  (`SessionSchema`, `serializeSession`, also on the warm/claim serializations).
- `GET /projects/:id/sessions?subproject=` (§5.2).
- Triggers: `GitTriggerSpec.subproject: string | null`; `parseTriggerEntry`
  reads it; `triggerSpecToTomlEntry` emits it only when set (after `agent`);
  `TriggerDraft`/`parseTriggerDraft` accept `subproject` (`null`/`''` clears);
  the POST/PATCH trigger routes validate it against the manifest (`400`);
  `specToBody`, `draftToSpec`, `loadTriggersForResponse` carry it. Round-trip
  test: PATCH of an unrelated field keeps `subproject`.
- `GET /projects/:id/detail` → `config.subprojects` (access-filtered).

Every error is `{error, code?}`. Codes: `SUBPROJECT_NOT_DECLARED`,
`subproject_not_accessible`, `SUBPROJECT_SLUG_TAKEN`.

## 7. Runtime

`session-runtime-env.ts` `buildSessionRuntimeEnv` gains
`subproject?: SubprojectEnvelope | null` and emits
`KORTIX_SUBPROJECT=<slug>` and `KORTIX_SUBPROJECT_CONTEXT=<json>` —
`{version:1, slug, name, description, instructions, context:[...], sessions}`
(instructions truncated at 32 KB with `\n…[truncated]`; whole JSON ≤ 64 KB).
Both names join `SERVER_OWNED_ENV_NAMES` (`session-runtime-context.ts`).
`buildSessionSandboxEnvVars` takes `subproject`; its three callers
(`lib/sessions.ts` create, `sandbox-env-sync.ts`, `session-reload.ts`) resolve
it from the session row's `subproject` + `loadProjectSubprojects`.

`compile-agent-config.ts`: `resolveCompiledAgentConfigForSession` and
`resolveSelectedAgentConfigForSession` accept `{subproject?: string | null}`
and, when set and declared, emit top-level `instructions: string[]` = the
subproject's `context` entries (a `dir/` entry becomes `dir/**/*.md`). Agent
`prompt` is never touched (it replaces OpenCode's default system prompt).

Daemon `apps/kortix-sandbox-agent-server/src/subproject.ts` mirrors
`secret-capabilities.ts`: `renderSubprojectInstruction(env)` →
`writeSubprojectInstruction(env)` writes `/tmp/kortix/subproject.md`:

```
# Subproject: <name>

<description>

## Instructions

<instructions>

## Context

Read these before answering:
- `docs/brand.md`
- `.kortix/subprojects/marketing/`

Sessions you start with `kortix sessions new` inherit this subproject unless you pass `--subproject`.
```

`buildOpencodeConfigContent` appends that path to `instructions` exactly like
`secretCapabilitiesInstructionPath`; `writeKortixOpencodeConfig` and its caller
in `main.ts` thread the new option. The daemon ships from the API image via
runtime-assets (no separate release).

## 8. SDK (`packages/sdk`) — TDD, `sdk` skill rules

`src/core/rest/projects-client/subprojects.ts` (+ `.test.ts`): types
`Subproject`, `SubprojectSessionsMode`, `SubprojectsResponse`,
`CreateSubprojectInput`, `UpdateSubprojectInput`, `AddSubprojectContextInput`;
functions `listProjectSubprojects(pid)`, `getProjectSubproject(pid, slug)`,
`createProjectSubproject(pid, input)`, `updateProjectSubproject(pid, slug, input)`,
`deleteProjectSubproject(pid, slug)`, `addProjectSubprojectContext(pid, slug, input)`,
`removeProjectSubprojectContext(pid, slug, path)`. Export from the barrel;
facade `kortix.project(pid).subprojects.{list,get,create,update,remove,addContext,removeContext}`.
Also: `ProjectSession.subproject?: string | null`;
`CreateProjectSessionInput.subproject?`; `listProjectSessions(pid, {subproject?})`
sends the query param; `ResourceGrantType` `+ 'subproject'`;
`ProjectResourceGrantsResponse.resources.subprojects?`;
`qk.project.subprojects(id)`, `qk.project.subproject(id, slug)`;
`qk.project.sessions(id, scope, subproject?)`. Additive surface-snapshot
update only. Gates: `typecheck`, `test`, `smoke:install`.

## 9. CLI (`apps/cli`)

`commands/subprojects.ts`, registered in `index.ts` (dispatch, `KNOWN_COMMANDS`,
help group "Agents & connectors"):

```
kortix subprojects ls [--json]
kortix subprojects show <slug> [--json]
kortix subprojects create <name> [--slug s] [--description d] [--agent a]
                          [--instructions-file f|-] [--context p ...] [--sessions private|shared]
kortix subprojects update <slug> [--name] [--description] [--agent] [--instructions-file]
                          [--context p ...] [--sessions private|shared]
kortix subprojects rm <slug> [--yes]
kortix subprojects context add <slug> <file> [--as name]
kortix subprojects context rm <slug> <path>
kortix subprojects grant <slug> (--member <id|email> | --group <id>) [--expires YYYY-MM-DD]
kortix subprojects revoke <slug> (--member <id|email> | --group <id>)
```

`kortix sessions new --subproject <slug>` (default `$KORTIX_SUBPROJECT` inside
a sandbox); `kortix sessions ls --subproject <slug>`; `kortix triggers
create|update --subproject <slug>` (`--subproject ''` clears). All `--json`.
Exit codes 0/1/2. Unit tests for arg parsing beside the command; `cli.mdx`
section.

## 10. Web (`apps/web`) — design-system rules apply

1. **Sidebar** (`project-sidebar.tsx`): a `Subprojects` group between the
   nav group and the session list: header row with `+` (create modal, shown
   only with `project.customize.write`), one row per accessible subproject
   (folder icon, name, active on its route). No group at all for a member
   with none and no write leaf. Data `useQuery(qk.project.subprojects(pid))`.
2. **Route** `app/(app)/projects/[id]/subprojects/[slug]/page.tsx` →
   `features/subprojects/subproject-page.tsx`, per the screenshot: breadcrumb
   `Projects / <name>`, title, header actions (share control — the
   `AgentShareControl` shape with `resourceType='subproject'` plus a
   "Sessions: only their own / everyone granted" switch that PATCHes
   `sessions`; `⋯` menu: rename, delete), the `ProjectHome` composer (every
   send → `newSession({create:{subproject: slug, agent_name}})`), right rail
   cards **Instructions** (inline editor → PATCH), **Context** (path list;
   add = file upload → `addContext`; remove), **Scheduled** (triggers with
   `subproject === slug`; `+` opens the trigger create modal with the
   subproject preset). Below: the subproject's sessions
   (`listProjectSessions(pid, {subproject})`, sidebar row component).
3. **Create modal** `features/subprojects/create-subproject-modal.tsx`: name,
   description, agent select (accessible agents), instructions. Navigates to
   the page on success.
4. **Access dialog** (`shared/access/access-dialog.tsx`): keep every existing
   prop/name; add `initialSubprojectIds?` and a "Subprojects" checkbox list
   wired through `createAssignment(... object:{type:'subproject'})`, same
   diff/undo rules as agents. The page's "Who can use it" section reuses the
   `AgentPeopleSection` logic parameterized by resource type.
5. **Session create** (`use-new-project-session.ts`, `new-session-create.ts`):
   pass `subproject`; skip warm adoption when set.
6. **Session rows** (sidebar + sessions page): a subproject badge when
   `session.subproject` is set; `session-grouping.ts` gains a `subproject`
   grouping mode.
7. **Triggers** create/edit modal: optional `Subproject` select.
8. Browser spec (§12.7) proves it.

## 11. Docs, skills, contracts

- `apps/web/content/docs/project/manifest.mdx` (`subprojects:` + trigger row),
  `docs/cli.mdx`, `docs/sdk/reference.mdx`, `packages/sdk/README.md`.
- kortix-system skill (`packages/starter/templates/managed/.kortix/opencode/skills/kortix-system/`):
  `references/kortix/kortix-yaml.md`, `references/kortix/kortix-cli.md`, and a
  `$KORTIX_SUBPROJECT` paragraph in `SKILL.md`.
- `docs/IAM_ADMIN_GUIDE.md`: subproject as the second closed object type.
- `tests/spec/end-to-end.md` section "12b. Subprojects" (`SUBP-1..5`);
  `tests/spec/routes.generated.json` hand-insert of the 7 routes.

## 12. Tests

1. manifest-schema — done (375 pass).
2. `apps/api` unit: `projects/subprojects.test.ts` (extract/upsert/remove/strip
   round-trip), `lib/subproject-access.test.ts`, trigger `subproject`
   round-trip, `session-inventory` drop + shared mode,
   `compile-agent-config` instructions, `session-runtime-env` env emission.
3. Daemon `__tests__/subproject.test.ts`: render + `instructions` append.
4. REST flows `tests/src/flows/subprojects.flow.ts`:
   `SUBP-1` CRUD + commit + `409`/`400`/`404`;
   `SUBP-2` authz (member without grant: list empty, get `404`, session
   create `403 subproject_not_accessible`; after a grant: visible, create
   passes the gate — asserted at the validation boundary, `MKTP-11`
   precedent; manager sees all; member `DELETE` `403`);
   `SUBP-3` sessions filter/hiding + `sessions: shared` visibility;
   `SUBP-4` triggers with `subproject`; `SUBP-5` CLI as real processes.
5. SDK tests + surface snapshot. 6. CLI unit tests.
7. Browser `tests/e2e/specs/27-subprojects.spec.ts`: create from the sidebar
   `+`, three cards render, instructions edit persists (assert the PATCH),
   composer send carries `subproject` in the POST body, ungranted member sees
   no sidebar entry.

## 13. Work packages

All agents work in **this worktree** on branch `subprojects`. **Agents never
commit**; the orchestrator commits after each wave. Each WP owns the files
listed and touches nothing else; two WPs sharing `lib/sessions.ts` own disjoint
regions (B: `createProjectSession`; C: `buildSessionSandboxEnvVars`).

| WP | Scope | Owns | Model |
| --- | --- | --- | --- |
| A | §4 | `packages/db/migrations/*subprojects*`, DB applied | Sonnet |
| B | §5, §6, api-contract, §12.2 (non-runtime) | `apps/api/src/{iam,projects}` except C's files; `packages/api-contract` | Opus |
| C | §7, §12.2 runtime, §12.3 | `session-runtime-env.ts`, `session-runtime-context.ts`, `compile-agent-config.ts`, `sandbox-env-sync.ts`, `session-reload.ts`, `buildSessionSandboxEnvVars` region of `sessions.ts`, `apps/kortix-sandbox-agent-server` | Opus |
| D | §8 | `packages/sdk` | Opus |
| E | §9 | `apps/cli`, `apps/web/content/docs/cli.mdx` | Sonnet |
| F | §10, §12.7 | `apps/web/src`, `tests/e2e/specs/27-*` | Opus |
| G | §11 (rest), §12.4, spec/routes files | docs, skill, `tests/src/flows/subprojects.flow.ts`, `tests/spec/*` | Sonnet |

Waves: 1 = A, B, C, D, E in parallel; 2 = F, G after wave 1 is committed.
Then the orchestrator: `pnpm test` core lane + `--browser-only`, boot the
worktree stack, hand-verify §5 against `localhost:13408` with a manager and
an ungranted member, open the draft PR with the `preview` label, verify on the
preview origin, report.
