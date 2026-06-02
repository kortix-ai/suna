# Kortix Change Requests — full reference

A **change request** (CR) is Kortix's PR-equivalent. It proposes
merging one branch (`head_ref`) into another (`base_ref`) inside a
single Kortix project. The CR layer is **Kortix-native** — it works
on top of any git host (GitHub, GitLab, plain git) without
per-host integration. The CR row is metadata; the underlying git
operations (fetch, diff, three-way merge, fast-forward) run inside the
Kortix API against whatever backend the project's `repo_url` points
to.

## The agent mandate

**An agent running in a session sandbox MUST open a CR to land any
change on `main`.** Sessions run on ephemeral branches
(`session-<id>`); the sandbox dies at end-of-session and nothing on
the branch reaches `main` unless a CR merges it. Future sessions boot
from `main` — without the CR merging, your work is invisible to every
other agent, every trigger fire, every collaborator.

The contract is:

1. **Commit on the session branch** (`$KORTIX_BRANCH_NAME`). Small,
   working commits. Don't rewrite or force-push.
2. **Push the branch** (`git push origin HEAD`).
3. **Open the CR** (`kortix cr open --title "…" --description "…"`).
   From inside the sandbox `--head` and `--session` are auto-detected
   from `$KORTIX_BRANCH_NAME` and `$KORTIX_SESSION_ID`; `--base`
   defaults to the project's default branch.
4. **Surface the CR number to the user** (`kortix cr ls`) so they can
   review.
5. **Stop. The agent does not merge its own CR.** Merging is the
   user's call, from the dashboard or `kortix cr merge <n>`.

This mandate applies to **everything**:

- code edits
- new files (skills, agents, slash commands, tools, plugins)
- `kortix.toml` edits (triggers, env, sandbox, apps)
- `AGENTS.md` rule changes
- new MCP server configs
- anything else committed to the working tree

There is no "small enough to skip the CR" exception. The CR is the
user's review hook; bypassing it removes the user from the loop.

### Anti-patterns

- **Force-pushing to `main`.** Even where the backend allows it, the
  user's review contract is broken. Don't.
- **"I committed it on my branch, the user can pull it."** The
  session branch dies. They can't pull it after the sandbox
  shuts down unless it's merged.
- **Bundling the change as a tarball / paste / gist.** That's a
  workaround for a problem the CR system already solves.

## Data model

CRs live in the `change_requests` table (Drizzle schema in
`packages/db/src/schema/kortix.ts`):

| Column                | Type                  | Notes                                                                                      |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| `cr_id`               | uuid (PK)             | Stable identifier. What the REST API uses.                                                 |
| `account_id`          | uuid                  | Tenant.                                                                                    |
| `project_id`          | uuid                  | Project the CR belongs to. Cascade-deleted with the project.                               |
| `number`              | integer               | Short, per-project, monotonically-increasing display number. `#1`, `#2`, … Unique per project. |
| `title`               | text                  | Required.                                                                                  |
| `description`         | text                  | Defaults to empty string.                                                                  |
| `base_ref`            | text                  | The branch being merged *into*. Usually `main`.                                            |
| `head_ref`            | text                  | The branch being merged *from*. Usually `session-<id>`.                                    |
| `status`              | enum                  | `open` \| `merged` \| `closed`.                                                            |
| `head_commit_sha`     | text (nullable)       | Refreshed against the live `head_ref` tip on every read for open CRs. Captured at merge time for merged CRs. |
| `base_commit_sha`     | text (nullable)       | Same idea. For merged CRs this is the base SHA *before* the merge commit was created.      |
| `origin_session_id`   | text (nullable)       | The session that opened the CR (when it was opened from inside a sandbox). FK to `project_sessions.session_id` with `ON DELETE SET NULL`, so closing the originating session doesn't delete the CR — it just orphans the link. |
| `created_by`          | uuid                  | User who created the CR (or sandbox token's resolved user).                                |
| `merged_at`           | timestamptz (nullable)| When the merge ran.                                                                        |
| `merged_by`           | uuid (nullable)       | Who triggered the merge.                                                                   |
| `merge_commit_sha`    | text (nullable)       | The merge commit. For fast-forwards equals `head_commit_sha` at merge time.                |
| `closed_at`           | timestamptz (nullable)| When the CR was closed without merging.                                                    |
| `closed_by`           | uuid (nullable)       | Who closed it.                                                                             |
| `metadata`            | jsonb                 | Free-form key/value. Defaults to `{}`.                                                     |
| `created_at`          | timestamptz           | Defaults to now.                                                                           |
| `updated_at`          | timestamptz           | Updated on every status change or SHA refresh.                                             |

Indexes:

- `idx_change_requests_account` on `account_id`
- `idx_change_requests_project` on `project_id`
- `idx_change_requests_project_status` on `(project_id, status)`
- `idx_change_requests_project_number` (**unique**) on `(project_id, number)`

The unique index on `(project_id, number)` is what allows the CLI
to accept `kortix cr show 3` — `3` resolves to the row with
`number = 3` for the resolved project. Numbers don't recycle when a
CR is closed; the counter just keeps going.

## Lifecycle

```
                       open
                        │
                        ├── kortix cr close ──▶  closed ──┐
                        │                          │      │
                        │                  kortix cr reopen
                        │                          │      │
                        │   ◀──────────────────────┘      │
                        │                                 │
                        ├── kortix cr merge  ──▶  merged ─┘ (terminal)
```

- `open` is the starting state.
- `closed` is reversible: `kortix cr reopen <n>` puts it back to
  `open`. The branch tips are re-resolved on the next read.
- `merged` is **terminal**. You cannot reopen a merged CR — open a new
  one against the post-merge state if you need to.
- You **cannot** close a merged CR — already final.

When a CR is merged, the row captures the SHAs that were active at
merge time:

- `merge_commit_sha` ← the new merge commit (or fast-forward target).
- `base_commit_sha` ← the base SHA *before* the merge.
- `head_commit_sha` ← the head branch's tip at merge time. (For
  fast-forwards this equals `merge_commit_sha`; for three-way merges
  it stays at the original head tip, so the diff can re-render via
  `base...head`.)

## SHA refresh

For open CRs, the API refreshes `head_commit_sha` and
`base_commit_sha` against the live branches on every read. If the
repo is unreachable or a branch is missing, the refresh is skipped
silently — the CR row still serves the metadata it has, so the UI
can render the title / description / status even when the underlying
repo is temporarily down.

## Diff semantics

`GET /v1/projects/:projectId/change-requests/:crId/diff` returns a
unified patch with `files`, `additions`, `deletions`, and per-file
status (`added`, `modified`, `deleted`).

- For `open` and `closed` CRs: diff is **three-dot** between live
  `base_ref` and live `head_ref` — i.e. `base...head`, which excludes
  changes already on `base_ref` that aren't on `head_ref`.
- For `merged` CRs: diff is computed from the **captured SHAs**
  (`base_commit_sha`, `head_commit_sha`), so the patch still renders
  even though `head_ref` is now reachable from `base_ref` post-merge.

The CLI's `kortix cr diff` falls back to no color when stdout isn't a
TTY (or with `--no-color`).

## Merge mechanics

`POST /v1/projects/:projectId/change-requests/:crId/merge` runs
through `apps/api/src/projects/git.ts`'s `mergeBranches`. The
implementation:

1. Fast-forward if `head_ref` is strictly ahead of `base_ref`.
2. Otherwise create a merge commit (three-way merge). Default message
   `Merge CR #<n>: <title>`; override with `--message`. Author is
   `Kortix <noreply@kortix.ai>`.
3. On success: update `change_requests` row to `merged`, capture SHAs,
   invalidate the project's mirror cache.
4. On conflict: 409 with `error: "Merge failed"` and the conflict
   list available via `GET /merge-preview`.

### Merge preview

`GET /v1/projects/:projectId/change-requests/:crId/merge-preview`
returns:

```ts
{
  is_up_to_date: boolean,    // head_ref is fully merged into base
  can_merge: boolean,        // no conflicts
  can_fast_forward: boolean, // head is strictly ahead of base
  conflicts: string[],       // file paths that would conflict
}
```

`kortix cr show <cr>` calls this automatically for open CRs and
renders the result inline. Always run `show` before `merge` if you
want to know what you're about to do.

### Conflicts

If the merge preview lists conflicts, **the agent does not try to
auto-resolve them by merging anyway**. The standard recovery is:

1. On the session branch, `git pull origin <base_ref>` (or merge
   `main` into the branch).
2. Resolve conflicts locally with `edit`.
3. Commit + push.
4. `kortix cr show <cr>` to confirm the preview is now clean.
5. Hand back to the user to merge.

## CLI surface

The full surface is in `kortix-cli.md` alongside this doc. Summary:

| Command                                      | What it does                                            |
| -------------------------------------------- | ------------------------------------------------------- |
| `kortix cr ls [--status open\|merged\|closed\|all]` | List CRs on the project. Default: `open`.        |
| `kortix cr show <cr>`                        | Metadata + merge preview.                              |
| `kortix cr diff <cr> [--no-color]`           | Unified patch.                                          |
| `kortix cr open --title "..." [--description "..."] [--head <ref>] [--base <ref>]` | Open a CR. |
| `kortix cr merge <cr> [--message "..."]`     | Merge it (fast-forward or three-way).                   |
| `kortix cr close <cr>`                       | Close without merging.                                  |
| `kortix cr reopen <cr>`                      | Reopen a closed CR.                                     |

`<cr>` is either the per-project number (`3` or `#3`) or the UUID
`cr_id`.

### Sandbox auto-detection

When `kortix cr open` runs inside a session sandbox:

- `--head` defaults to `$KORTIX_BRANCH_NAME` (or `$KORTIX_HEAD_REF`).
- `--session` defaults to `$KORTIX_SESSION_ID`, which back-fills
  `origin_session_id` on the row so the dashboard can show which
  session opened the CR.
- `--base` defaults to the project's default branch (from
  `projects.default_branch`, usually `main`).
- `--project` defaults to the session's project (from
  `$KORTIX_PROJECT_ID`).
- `--title` is the only required flag.

So inside a sandbox the minimal viable invocation is:

```sh
kortix cr open --title "Add release-notes skill" \
  --description "Drafts release notes from merged commits. Tested against the last 5 tags."
```

## REST API

All endpoints are under `/v1/projects/:projectId/change-requests`.
The CLI is just a thin wrapper.

| Method | Path                                      | Notes                                                                         |
| ------ | ----------------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/`                                       | `?status=open\|merged\|closed\|all` (default `all`).                          |
| POST   | `/`                                       | Body: `{ title, description?, head_ref, base_ref?, session_id? }`. Returns 201 + serialized CR. |
| GET    | `/:crId`                                  | Returns `{ change_request: ... }`. Refreshes SHAs as a side effect.           |
| PATCH  | `/:crId`                                  | Edit `title` / `description`.                                                 |
| GET    | `/:crId/diff`                             | Unified patch + file list.                                                    |
| GET    | `/:crId/merge-preview`                    | Conflict + fast-forward analysis.                                             |
| POST   | `/:crId/merge`                            | Body: `{ message?: string }`. 409 on conflict or non-`open` status.           |
| POST   | `/:crId/close`                            | No body. 409 if already `merged`.                                             |
| POST   | `/:crId/reopen`                           | No body. 409 if not `closed`.                                                 |

All endpoints require the caller's token to have **write** access to
the project (the project-scoped sandbox token always does; user
tokens require account membership). Mismatched token → 403.

Validation rules on `POST /`:

- `title` required (non-empty).
- `head_ref` required.
- `base_ref` defaults to the project's `default_branch`.
- `head_ref === base_ref` → 400 (must differ).
- `session_id` is validated against `project_sessions`; unknown
  session IDs are silently dropped (`origin_session_id` becomes
  null).
- Branch tips are resolved at create time, so the CR row has anchor
  SHAs from the moment it's opened.

## Composition with the rest of the system

| Surface       | How the CR composes                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------ |
| **Sessions**  | A CR's `origin_session_id` is back-filled from `$KORTIX_SESSION_ID` so the dashboard shows the session that opened it. Cascade is `ON DELETE SET NULL` — closing the session orphans the link, doesn't delete the CR. |
| **Skills**    | New `.kortix/opencode/skills/<name>/SKILL.md` files reach future sessions **only** after a CR that contains them merges to `main`. Until then, only the originating session sees them. |
| **Agents**    | Same: new `.kortix/opencode/agents/<agent>.md` files need to land via CR.                       |
| **Triggers**  | Edits to `[[triggers]]` in `kortix.toml` only reach the scheduler after the CR merges. The scheduler reads `kortix.toml` on `main`. |
| **Apps**      | `[[apps]]` redeploys are driven by manifest-hash changes on `main`. A CR that changes app config triggers a redeploy *after* merge, not before. |
| **Secrets**   | Decoupled. Secrets live in the Kortix Secrets Manager, not the manifest; CRs don't move secrets. |
| **Dashboard** | Renders CR list / detail / diff / merge button. Same data as the CLI sees.                       |
| **Triggers firing inside a session** | A trigger-spawned session can itself open a CR — same flow.                       |

## Gotchas

- **Merge is `Kortix <noreply@kortix.ai>`-authored.** If you want the
  user's name on the merge commit, that's a dashboard-side option,
  not a CLI flag today.
- **You cannot close a `merged` CR.** It's the terminal state.
- **You cannot reopen a `merged` CR.** Open a new one against the
  post-merge tip.
- **Branch deletion is not automatic.** After a CR merges, the head
  branch still exists in the git backend. If the project policy is
  to clean up session branches, that's a separate sweep — not part of
  the CR merge.
- **The session-branch tip changes after the agent commits more.**
  CRs that read live tips will reflect new commits on the head branch
  even after the CR is opened — the diff updates. There's no
  freeze-on-open semantic.
- **The `KORTIX_*` env vars expected at `cr open` time:**
  `KORTIX_CLI_TOKEN` (the project-scoped PAT the CLI authenticates with —
  **not** `KORTIX_TOKEN`, which is the sandbox service key and is rejected
  by the CR routes), `KORTIX_API_URL`, `KORTIX_PROJECT_ID`,
  `KORTIX_BRANCH_NAME` (or `KORTIX_HEAD_REF`), `KORTIX_SESSION_ID`.
  All of these are pre-injected by the session bootstrap. If you're
  running `kortix cr open` *outside* a session (e.g. on your laptop)
  you'll need to pass `--head` and `--project` explicitly, or be on a
  cwd linked via `kortix projects link`.

## See also

- `kortix-cli.md` (next to this file) — full CLI surface for `kortix
  cr`.
- `../opencode/overview.md` — where OpenCode primitives live, all of
  which are CR-shipped.
- `../../SKILL.md` — `<change-requests>` section, agent mandate.
- `packages/db/src/schema/kortix.ts` — schema source (`changeRequests`
  table + `changeRequestStatusEnum`).
- `apps/api/src/projects/index.ts` — REST handlers
  (`/change-requests/...`).
- `apps/cli/src/commands/cr.ts` — CLI implementation.
