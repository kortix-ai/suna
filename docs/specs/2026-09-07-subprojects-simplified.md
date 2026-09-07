# Subprojects, simplified — spec addendum (2026-09-07)

Extends `2026-09-03-subprojects.md` and `2026-09-06-subproject-files-and-scoped-agents.md`.
Three decisions from the user on 2026-09-07:

1. `instructions` and `context` are removed from a subproject — everywhere, not
   just from the page.
2. The subproject page loses its right-hand panel. It is one column: heading,
   composer, Recents.
3. A session can be moved between subprojects, and in and out of the project
   level.

## 1. Problem

A subproject was two things at once: a container that groups sessions, and a
settings form for steering the agent. The second half never earned its place.
It duplicated what an agent's own `.md` already does, it demanded a panel of
editors beside the composer, and it carried a whole delivery path — a JSON env
envelope, a byte-budget truncation ladder, a daemon renderer, an OpenCode
`instructions` overlay — to get two author-written fields into the sandbox.

What is coming instead is configuration written into the subproject's file by a
person or an agent, and per-subproject dashboards grouped in tabs across the top
of the page — the strip Slack puts above a conversation. Neither needs a
settings form beside the composer, and both need the page to be a plain single
column that a tab strip can sit on top of.

## 2. What a subproject is now

`kortix-<slug>.yaml`: `name`, `description`, `agent`, `sessions`, `agents`.
Nothing else. The grouping, the default agent, the session-visibility mode, the
agents it owns or borrows, its triggers and its grants are unchanged.

**Removed:** the `instructions:` and `context:` keys, `POST`/`DELETE
/subprojects/:slug/context`, `addProjectSubprojectContext` /
`removeProjectSubprojectContext` in `@kortix/sdk`, `kortix subprojects context
add|rm` and the `--instructions-file` / `--context` flags, the
`KORTIX_SUBPROJECT_CONTEXT` env envelope
(`apps/api/src/projects/lib/subproject-envelope.ts`), the daemon's
`/tmp/kortix/subproject.md` renderer
(`apps/kortix-sandbox-agent-server/src/subproject.ts`), and
`withSubprojectInstructions` in the agent-config compiler.

**Kept:** `KORTIX_SUBPROJECT=<slug>` in the sandbox env. The in-sandbox CLI
reads it so `kortix sessions new` inherits the subproject; nothing else in the
box needs it. A session inside a subproject still compiles the agents that
subproject owns or references.

**Back-compat.** A `kortix-<slug>.yaml` written when the two keys were valid
must keep parsing — rejecting it would take its sessions and its owned agents
down with it. `validateSubprojectFileV2` reports each as a **warning** and the
loader ignores it; the JSON Schema keeps both properties marked `deprecated`,
so an editor still validates the file; and the next write through the API or the
app rewrites the file without them. The API refuses either field in a
create/update **body** with `400`, so a client learns its write does nothing
rather than losing it.

## 3. The page

One column: breadcrumb top-left, the share/`⋯` toolbar top-right, the greeting
with the subproject's name, the composer, and Recents under it. The `aside` slot
on `ProjectHome` / `ProjectHomeWelcomeBody` is gone with the panel it existed
for; a page with content under its composer still pins to the top, so the
composer does not drift as the list grows.

Access is still on the page — the `Share` button in the toolbar. Triggers are
filed from the project's own trigger surface. What was `Instructions` and
`Context` is the file.

**Deliberately not built yet:** the tab strip (Chat / dashboards) the page is
shaped for. One tab is not a tab strip.

## 4. Moving a session

`PATCH /v1/projects/:projectId/sessions/:sessionId {"subproject": "<slug>" | null}`.
`null` (or `""`) moves the session back to the project level. In the app it is
`Move to` in the session's `⋯` menu — in the sidebar row and on the session
page.

Rules, in the order the route applies them:

| Check | Failure |
| ----- | ------- |
| The caller may change who reads this session (`can_manage_sharing`) | `403` |
| The target subproject is declared | `400 SUBPROJECT_NOT_DECLARED` |
| The caller is granted the target | `403 subproject_not_accessible` (with `accessible_subprojects`) |
| The session's agent is usable in the target | `400 AGENT_NOT_IN_SUBPROJECT` (with `usable_agents`) |

The sharing gate, not the manager tier, is the right one: a `sessions: shared`
subproject makes every session in it readable by everyone granted it, so a move
is a visibility decision. A manager who cannot read another person's private
session cannot re-file it either.

Only `project_sessions.subproject` changes. Every server-side gate reads that
column, so the move is complete when it commits. A sandbox that is already
running keeps the `KORTIX_SUBPROJECT` it booted with until its next start.

## 5. Coverage

`SUBP-1` asserts the two fields are `400` on create/update. `SUBP-7` covers the
move: in, between, out, undeclared, ungranted, and granted-then-allowed.
