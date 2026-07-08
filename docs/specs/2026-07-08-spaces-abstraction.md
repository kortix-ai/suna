# Spaces — folders as the seed of an organizing + authorization layer

**Status:** DRAFT / VISION. Not scheduled, not scoped, not for immediate implementation.
**Author:** Marko, 2026-07-08.
**Seed:** the `session_folders` experimental feature (this branch) — folders ship first, as-is.
This document is the longer-horizon shape that grows out of them, written down so it isn't lost.

---

## 1. The pitch

Rename **folders → Spaces**, and let a Space be more than a grouping of sessions.

Today a folder is a flat container: a name, a visibility, a list of sessions. A **Space** is a
configurable little home for a context — the same shape as a Slack channel or a Microsoft Teams
channel: you create one for a team, a sub-project, or an initiative ("Marketing", "Engineering",
"Q3 Launch"), and it becomes the place that context lives — its sessions, its files, its agents,
its links, its dashboards — plus **who's allowed in**.

Concretely, a Space adds three things folders don't have today:

1. **Tabs** — configurable surfaces beyond a session list: a feed, a canvas, files, links, apps,
   dashboards.
2. **Agents** — agents can be attached to a Space, not just sessions.
3. **Authorization** — a Space is a grant boundary. Give a group access to the Space and they
   inherit access to everything scoped to it (its agents, connectors, sessions, resources) —
   without needing project-wide access.

Folders are not being replaced or re-architected to get this. They're the MVP seed: ship folders
as they are now, gated behind `session_folders`, and grow the concept incrementally on top of the
same tables. See §4.

## 2. Motivation

Two problems compound inside a Kortix project as it grows past a handful of people:

**Organization.** A project accumulates sessions from many contributors and many purposes —
scheduled jobs, Slack threads, one-off explorations, a long-running initiative. A flat sidebar
list or a single-level folder doesn't map to how teams actually think about their work: "the
Marketing team's stuff," "everything about the Q3 launch." Slack and Teams solved this with
channels — a named, ownable, configurable home for a context, with more than one kind of content
inside it. Folders today only capture the "named container for sessions" half of that.

**Authorization.** Today, access inside a project is essentially two-tier: project membership
(broad) plus a growing pile of narrow, per-object grants — `session_folder_grants` for folder
visibility, `project_session_grants` for session visibility, `iam_resource_grants` for scoping a
specific agent or skill to specific people. Each of these grants one *kind* of thing. There is no
mid-tier boundary that says "this group gets everything relevant to this sub-context, in one
place" — the thing a real team actually wants ("give the Marketing group access to the Marketing
stuff") requires assembling several grants by hand and keeping them in sync.

A Space collapses both problems into one abstraction: it's simultaneously the *organizing unit*
(what a folder already is) and the *authorization unit* (a scope you can grant a group access to
in one shot). That pairing is the actual idea — not the tabs by themselves.

## 3. What a Space is (concept model)

```
Space
 ├─ sessions          — what session_folders already does (folder_id → session)
 ├─ tabs (surfaces)   — feed | canvas | files | links | apps | dashboards | …
 ├─ agents            — agents attached to the Space, scoped to it
 └─ membership/grants — who can see it, and what they inherit by being in it
```

A Space still belongs to exactly one Kortix project — it is not a peer of a project, it's a
sub-context inside one. A project can have many Spaces; a Space does not span projects. This
keeps the mental model simple: **project = tenant/workspace boundary, Space = organizing +
access boundary within it.**

- **Sessions** — unchanged from folders: a session optionally belongs to one Space
  (`project_sessions.folder_id`, soon `space_id`).
- **Tabs** — a Space has a set of pluggable, ordered "tabs," each backed by a surface type
  (§5). A tab is a *reference/config* row, not a copy of data — e.g. a "files" tab points at a
  scoped file view, a "links" tab is a curated list, an "apps" tab embeds a connector's UI.
- **Agents** — an agent can be attached to a Space. This is presentation (which agents show up
  when you're "in" the Space) *and* authorization (§6) — the two are meant to reinforce each
  other, not be configured twice.
- **Membership** — a Space has the same three-tier visibility folders already have (`private` /
  `project` / `restricted`), plus the new piece: a `restricted` Space's grant list can name
  **groups**, and being granted the Space is what fans out into access to its contents.

## 4. Relationship to the current session-folders implementation

Nothing here requires re-architecting what's on this branch. The existing schema maps cleanly
onto the Space model with additive changes only:

| Folder concept today | Space concept tomorrow |
|---|---|
| `kortix.session_folders` (`folder_id`, `project_id`, `account_id`, `name`, `visibility`, `position`, `created_by`) | Same table, renamed/extended — `name`, `visibility`, `position` carry over unchanged |
| `project_sessions.folder_id` | Same FK, renamed `space_id` (or kept as-is with a Space = folder alias) |
| `kortix.session_folder_grants` (`folder_id`, `principal_type`, `principal_id`) | Same shape — becomes the Space membership/grant table; principal stays member\|group |
| `visibility: private \| project \| restricted` (`apps/api/src/projects/lib/session-folders.ts`) | Same three tiers; `restricted` grants are what a group-authorization Space uses |
| `isFolderVisibleTo` / `inheritedFolderIdsFor` / `canManageFolder` (same file) | Same functions, same semantics — "session inside a shared folder inherits the folder's audience" *is* already the authorization-by-membership idea, today scoped to visibility only |
| No tabs, no agent attachment | New, additive: a `space_tabs` (or similar) table keyed by `space_id`; an `space_agents` join table or reuse of `iam_resource_grants` scoping |

The one real property worth calling out: **the inheritance model already exists.** A session
filed in a shared folder today is visible to anyone who can see the folder, even if the session
itself is private (`inheritedFolderIdsFor` in `session-folders.ts`). That is *already* a scoped,
group-grantable authorization boundary — it's just currently limited to "can see this session,"
not "can use this agent / this connector / this resource that's scoped to the Space." Extending
§6 is mostly extending what a grant on a Space *unlocks*, not building a new grant mechanism from
scratch.

Migration path stays additive: rename in the UI/API surface first (folders → Spaces, feature flag
key can stay `session_folders` internally or gain a new key — TBD, not urgent), then layer tabs
and agent-attachment as separate, independently-shippable slices behind the same flag.

## 5. Tabs / surfaces

Candidate tab types — not a committed list, meant to be pluggable and added incrementally:

- **Feed** — an activity stream of what happened in the Space (sessions started/finished,
  outputs submitted, files changed). Natural fit with the Review Center's `review_items` model
  (`docs/specs/2026-07-08-session-work-submission.md`) — a Space's feed could just be a filtered
  view of review items scoped to its sessions/agents.
- **Canvas** — a free-form whiteboard/notes surface for the Space's context.
- **Files** — a scoped view into the Space's relevant files (project files filtered by
  session/tag, or a dedicated file area).
- **Links** — a curated list of URLs/resources relevant to the context.
- **Apps** — embedded connector UIs / mini-apps scoped to the Space (e.g. a Slack channel
  browser, a CRM view) — natural extension of the existing connector model.
- **Dashboards** — charts/metrics relevant to the initiative (cost, usage, review throughput).

Each tab is config + a pointer into existing data, not a new data silo per tab. The goal is
"programmatically surface all the relevant info inside the Space," not build six new products.

## 6. Authorization angle

The interesting claim: **a Space is a scoped grant boundary, one level below the project.**

Today, project-wide roles (`iam_roles` / `iam_policies`) grant broad capabilities, and
`iam_resource_grants` can scope a *specific* agent or skill to specific members/groups
(`resource_type: 'agent' | 'skill'`, keyed by `(project_id, resource_type, resource_id,
principal)`). That mechanism already proves the shape needed: unscoped resources stay
project-wide (opt-in scoping, no surprise lockouts); scoped resources become visible only to
grantees.

A Space's authorization role is to be the thing you attach *many* resources to at once, and grant
*as a set*:

- A group granted a `restricted` Space (via the Space's grant list — same table shape as
  `session_folder_grants` today) inherits:
  - visibility into the Space's sessions (already true today, via `inheritedFolderIdsFor`)
  - usage of the agents attached to the Space (extends `iam_resource_grants` — attaching an agent
    to a Space could just mean: write an `iam_resource_grants` row scoping that agent to every
    principal on the Space's grant list, kept in sync)
  - access to connectors/resources referenced by the Space's tabs, using the same
    `iam_resource_grants` scoping mechanism, `resource_type` extended as needed (`connector`,
    etc.)

The design intent is **not** a new, parallel permission system. It's a convenience/aggregation
layer over the grant primitives that already exist (`iam_resource_grants`, `*_grants` visibility
tables), so that granting "the Marketing group" access to "the Marketing Space" is one action
that fans out to the right set of underlying grants, instead of an admin manually replicating a
grant across every agent/session/connector that belongs to that context. This gives clean
separation *within* a project (Marketing doesn't automatically see Engineering's agents) while
everything still nests under one project's overall membership and billing.

Nothing here changes the "account owners/admins bypass scoping" escape hatch — that stays exactly
as `iam_resource_grants` already defines it.

## 7. Open questions

- Does "attach an agent to a Space" *write* `iam_resource_grants` rows (materialized, kept in
  sync), or is it evaluated dynamically at authz-check time (Space membership → implied resource
  access, no denormalized rows)? Denormalized is simpler to reason about today; dynamic avoids
  drift. Needs a real design pass, not decided here.
- Can a session/agent/resource belong to more than one Space, or is membership exclusive like
  folder membership is today (`folder_id` singular FK)? Slack channels allow overlap (a person/
  message can be cross-posted); folders today don't.
- Do Spaces nest (a Space inside a Space), or stay flat, one level under the project? Flat is
  simpler and matches folders; nesting is a bigger modeling commitment.
- What happens to a Space's grants/agent-attachments when the Space is deleted — same "unfile,
  never delete the sessions" posture folders already have, but grants presumably just get
  dropped (cascade, like `session_folder_grants` does today via `ON DELETE CASCADE`).
- Where do tabs live architecturally — a generic `space_tabs(space_id, type, config jsonb,
  position)` table, or per-type tables? Generic is likely right for a v1 given how different the
  tab types are, but not decided.
- Naming: does the experimental flag key change from `session_folders` to something like
  `spaces`, and is that a breaking rename for anyone who already opted in on this branch's
  feature, or an additive rename done later? Low-stakes, but worth deciding once, not per-PR.

## 8. Non-goals / not now

- This is **not** scheduled work. No ticket, no owner, no target release.
- Folders ship first, exactly as implemented on this branch, gated behind the `session_folders`
  experimental flag with `platformDefault: false` (`apps/api/src/experimental/features.ts`).
  Nothing in this document blocks or changes that rollout.
- No new permission system. Authorization stays layered on the existing grant primitives
  (`iam_resource_grants`, the `*_grants` visibility tables) — §6 is explicitly an aggregation
  convenience, not a redesign.
- No commitment to any specific tab type shipping, or to a particular data model for tabs. §5 is
  a candidate list, not a backlog.
- No renaming of the `session_folders` flag, table, or API surface happens as part of landing
  folders. Any rename is a separate, later, deliberate step once the Spaces direction is actually
  being built.
- Build incrementally, add pieces "as we go" — this doc exists so the destination is written
  down, not so the path there is committed to.
