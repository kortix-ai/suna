# Config releases

Source of truth for how a session gets its OpenCode configuration. Implemented
on branch `config-converge`, PR #7403. Update this file when a decision changes.

## Problem

A sandbox runs the OpenCode config of the commit it was created from. A resume
or a restart returns the same VM with the same config. 16,685 sessions imported
from legacy Suna on 2026-09-15/16 stay on that day's agents, skills, tools, and
governance.

The reload did not fix this. Measured on dev, session `6d8dfdae`, 2026-09-18:
`kortix sessions reload` exited 0 and printed a moved etag. The agent file in the
sandbox did not change, and the agent answered `NO_MARKER` / `NO_SKILL`. The
web's **Reload config** sends `refresh_repo: false`, which skipped the file half.

The root cause is one directory with three jobs. OpenCode reads its config from
`/workspace/.kortix/opencode`. That directory is also the project's tracked
source and the session's scratch space. The first fix on this branch checked the
base branch's config out into that directory. Real sandboxes then showed:

1. Platform-written files (plugin pin, lockfile, managed-skill overlay) read as
   session edits. The sync refused on an untouched session.
2. A successful sync left unstaged output. The next sync read it as an edit.
3. An agent's `git add -A` swept synced files into a session commit. The change
   request listed the agent prompt as modified, and its merge conflicted on a
   file nobody in the session touched.

The second design (`boot-config.ts`, `inspectSessionConfigWork`) moved the bytes
out of `/workspace`. It left the decisions in the sandbox daemon: `git fetch`
into the user's `.git`, history inspection on a shallow clone, and two
identifiers (commit and compiled etag) applied in two steps.

## Goals

1. Every session runs the base branch's current config by default.
2. The platform never writes a session's `/workspace`.
3. A session that edits its own config runs those edits after a reload.
4. A bad config on the base branch never makes a session unbootable.
5. Every session reports which config it runs, which it wants, and why they
   differ.
6. The API decides. The sandbox daemon executes and reports.

## Non-goals

- A per-session switch to preview the session's own config. Detection stays
  automatic in this delivery.
- A change-request gate that requires a proven config.
- A pinned or manual release policy.
- An AWS S3 storage backend. The store interface allows it later.
- Enforcing governance independently of agent files. In `session-files` mode an
  agent file can override compiled governance, as it can today.
- SHA-256 object-format repositories. The workspace report accepts 64-hex blob
  IDs, but the release builder and the archive route require 40-hex IDs.

## Decisions

| Date | Decision |
|---|---|
| 2026-09-18 | The platform never writes a session's `/workspace`. |
| 2026-09-19 | A session's own config edits take effect after a reload. Detection is automatic. |
| 2026-09-20 | Default policy is "always latest" from the base branch. |
| 2026-09-20 | A restarted box boots on its last proven release, then converges after ready. |
| 2026-09-20 | One PR (#7403) ships the final shape. |
| 2026-09-21 | The API decides the desired release. The daemon only executes and reports. |
| 2026-09-21 | Storage default is the Supabase Storage native API. |
| 2026-09-21 | A session without repository access never receives a config archive. |
| 2026-09-22 | A session from a previous repository generation keeps its running config. It never receives a release built from the current repository. |

## Terms

Use these terms exactly. Do not use synonyms.

| Term | Meaning |
|---|---|
| config dir | The repo-relative OpenCode config directory. `.kortix/opencode` unless the manifest sets `opencode.config_dir`. |
| config tree ID | The Git tree ID of the config dir at a commit. Identical files give an identical tree ID. |
| config archive | A `tar.gz` of the config dir, stored under its config tree ID. |
| compiled governance | The OpenCode agent config compiled by the API from `kortix.yaml` and agent files. |
| config release | One config archive plus one compiled governance. The unit a session runs. |
| release ID | `sha256((config_tree_id ?? "") + ":" + (compiled_governance_etag ?? ""))`, hex. Null only when both are null. |
| release descriptor | The JSON document the API returns for a session's desired release. |
| desired release | The release the API assigns to a session. |
| running release | The release the daemon serves from. |
| config mode | `follow-base` or `session-files`. Chosen by the API. |
| config source | `release`, `workspace`, or `image-default`. Reported by the daemon. |
| proven | A release passed the proven check on this box. |
| convergence | The daemon applying the desired release. |
| fallback | The daemon runs a config other than the desired release because it failed. |
| quarantine | A release recorded as failed. It is not assigned again until the base branch moves. |
| store | The storage interface for config archives. |

## Layers and owners

| Layer | Owner | Version | Update path |
|---|---|---|---|
| Platform runtime: daemon, CLI, OpenCode binary, managed skills | Platform | API deploy | Runtime-assets digest manifest. Unchanged. |
| Project config: config dir and compiled governance | Project | Base branch commit | Config releases. This spec. |
| Session work: repo, session branch, files | User | Session branch | Never touched by the platform. |

## Config release

### Contents

- The config archive: every file in the config dir at the commit. Symlinks keep
  their target. Submodules and Git LFS content are not supported. A tree entry
  of type `commit` is skipped.
- The compiled governance for the session's variant:
  - `project`: `resolveCompiledAgentConfigForSession`, all agents.
  - `agent:<name>`: `resolveSelectedAgentConfigForSession`, one agent. Used when
    the session has a selected agent and no repository-access metadata.
- The archive is shared across variants and across commits with the same config
  tree ID. The compiled governance is small and travels in the descriptor.

### Limits

- The config archive is at most 4 MiB, the existing
  `MAX_OPENCODE_CONFIG_ARCHIVE_BYTES`. Measured on a starter project: 178 files,
  289,727 bytes.
- A config dir over the limit produces no release. The API reports the reason.
  The session keeps its running config.

### Identity

- The config archive key is the config tree ID. Git computes it from content, so
  a commit that does not touch the config dir reuses the same archive.
- The release ID covers the config tree ID and the compiled governance etag. A
  governance-only change produces a new release ID with the same archive.
- A commit that changes neither produces the same release ID. No swap, no stale
  signal.
- A session without a config archive (no config dir on the base branch, or no
  repository access) still has a release ID when it has governance:
  `sha256(":" + etag)`. The daemon compares it like any other, so a
  governance-only change still converges.
- The archive route serves any tree object in the project mirror, not only
  config trees. The caller already needs repository access, and the 4 MiB cap
  applies (`413` above it). This is deliberate; a narrower check would need a
  commit-to-tree index and protects nothing a clone does not already expose.

### Security

- A config archive holds only files that are already in the project's private
  repository.
- Compiled governance holds names, never secret values. A test must fail if a
  project secret value appears in any release.
- The daemon verifies every extracted file against the Git blob ID in the
  descriptor. The descriptor arrives over TLS from the API. The store is
  untrusted transport.
- The daemon never accepts descriptor content from a request body. A trigger
  only makes the daemon fetch the descriptor from the API. The in-box agent can
  call the trigger; it cannot choose the content.
- A session without repository access never receives a config archive. Today
  such a session gets no repository URL and no clone (`session-runtime-env.ts`,
  `allowsFullRepository`). An archive would disclose files that mode withholds.
  Its descriptor has `archive: null`, `files: null`, and `reason:
  "repository access withheld"`. Compiled governance is still delivered. The
  daemon runs the image default config dir with that governance, as today.
- The archive route requires repository access. A session token needs a session
  with repository access. A human caller needs `PROJECT_FILE_READ`.

## Store

### Interface

```ts
interface ConfigArchiveStore {
  putIfAbsent(key: string, body: Buffer): Promise<'created' | 'exists'>
  downloadUrl(key: string, ttlSeconds: number): Promise<string | null>
  exists(key: string): Promise<boolean>
}
```

### Default implementation: Supabase Storage native API

Measured against local Supabase on 2026-09-21:

| Operation | Native Storage API | Supabase S3 endpoint |
|---|---|---|
| Upload new key | 200 | 200 |
| Second upload, same key | refused, `409 Duplicate`, original kept | accepted, overwrote |
| Signed download, no credentials | 200, original bytes | 200 |
| Private object, no credentials | refused | refused |
| New credentials needed | none | access key pair per environment |

Rules:

- Use the native API with `SUPABASE_URL` and the service-role key. Every
  environment already has both. Do not use the S3 endpoint.
- Bucket `kortix-config-releases`, private. The API creates it on first use.
  `409` means it exists.
- Object key: `projects/<project_id>/trees/<config_tree_id>.tar.gz`. Keys never
  share a prefix across projects.
- `putIfAbsent` uploads without upsert. `409 Duplicate` returns `exists`.
- Signed URL lifetime: 900 s.
- The store is a cache. The API can rebuild any config archive from its Git
  mirror. A store failure makes the API stream the archive it built.
- Do not use the project-snapshot settings (`KORTIX_PROJECT_SNAPSHOT_S3_*`).
  `config.ts` states that setting that bucket starts the snapshot producer on
  the API leader. Config releases must not start anything else.

### Download path

- The daemon always downloads through the API:
  `GET /v1/projects/{projectId}/config-archives/{configTreeId}`.
- The API answers `302` to a signed store URL when the storage host is public.
- The API streams the bytes when the storage host is loopback or private.
  Classify with `classifyIpHost` (`snapshots/providers/upload-url-guard.ts`).
  Local Supabase at `127.0.0.1` is not reachable from a cloud sandbox.
- Optional override `KORTIX_CONFIG_ARCHIVE_PUBLIC_URL` names a public storage
  base URL.

## API

### Release builder

`buildConfigRelease(project, commit, variant)`:

1. Resolve the config dir at the commit with `resolveOpencodeConfigDirAtSha`.
2. Resolve the config tree ID: `git rev-parse <commit>:<config dir>`.
3. List files: `git ls-tree -r -z <tree>`. Record path, mode, and blob ID.
4. If the store lacks the key, build the archive, then `putIfAbsent`:
   - Wrap the tree in a commit with fixed dates: `git commit-tree <tree> -m
     config` with `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` set to
     `@0 +0000`. `git archive` of a bare tree stamps the current time, so two
     builds of one tree give different bytes (measured). Git 2.39 has no
     `git archive --mtime`.
   - Run `git commit-tree` and `git archive --format=tar` in a scratch bare
     repository whose `info/attributes` is `* -export-ignore -export-subst`,
     with `GIT_ALTERNATE_OBJECT_DIRECTORIES=<mirror>/objects`. Without this a
     `.gitattributes` in the config dir drops files (`export-ignore`) or
     rewrites content (`export-subst`), and blob verification on the box fails.
     The mirror receives no writes.
   - Pipe the tar through `gzip -n`. Two builds of one tree give identical
     bytes.
5. Compile governance for the variant.
6. Return the release descriptor.

Cache descriptors in memory by `(project_id, commit, variant)`. Call
`invalidateProjectMirror` before resolving the base tip, as the reload does
today.

### Release descriptor

```json
{
  "format": "config-release-v1",
  "release_id": "<64 hex>",
  "mode": "follow-base",
  "source_commit": "<40 hex>",
  "config_dir": ".kortix/opencode",
  "config_tree_id": "<40 hex>",
  "archive": { "url": "/v1/projects/<id>/config-archives/<tree>", "bytes": 289727 },
  "files": [["agents/kortix.md", "100644", "<blob id>"]],
  "compiled_governance": "<json string or null>",
  "compiled_governance_etag": "<16 hex or null>",
  "reason": null
}
```

In `session-files` mode `archive` and `files` are null. `compiled_governance`
still comes from the base branch.

### Workspace report

```json
{
  "head": "<40 hex>",
  "config_dir": ".kortix/opencode",
  "changed": [
    { "path": ".kortix/opencode/agents/kortix.md", "status": "modified", "blob": "<40 hex>" },
    { "path": ".kortix/opencode/skills/x/SKILL.md", "status": "deleted", "blob": null }
  ]
}
```

- `status` is `modified`, `added`, `deleted`, or `untracked`.
- `changed` covers uncommitted changes and every file the session's commits
  changed since the merge base with the base branch.
- `blob` is the Git blob ID of the working-tree file, or null when deleted.
- The daemon builds it with read-only Git commands. It never fetches.

### Routes

| Route | Caller | Purpose |
|---|---|---|
| `POST /v1/projects/{projectId}/sessions/{sessionId}/config-release` | Daemon (session token) | Body: `{ "workspace": WorkspaceReport \| null }`. Returns the desired release descriptor. |
| `GET /v1/projects/{projectId}/config-archives/{configTreeId}` | Daemon, project readers | `302` to the store or streamed bytes |
| `GET /v1/projects/{projectId}/sessions/{sessionId}/config` | Web, CLI, SDK | Freshness and state. Extended below. |

Regenerate `tests/spec/routes.generated.json` and add REST flows for each route.

### Config mode

The API chooses the mode on every convergence:

1. Read the workspace report from the descriptor request body. The daemon
   builds it from the session branch HEAD and every changed or untracked file
   under the config dir. The API never calls back into the box: a booting box
   cannot answer. A missing report means `follow-base`. The report only selects
   this session's file source, so a false report gains nothing: the session can
   already edit its own files.
2. Ignore platform-written paths: the plugin pin in `package.json` when it is
   the only difference, installer lockfiles while `package.json` holds no other
   edit, and skill directories the managed overlay ships.
3. Ignore a path whose blob ID equals that path at any commit of the base
   branch. The API reads full history from its mirror. Such a file is base
   content, left by an old sync or swept into a commit.
4. Any other path is session work. Mode is `session-files`. Otherwise
   `follow-base`.

### Capability gate

- A daemon that supports this spec lists `config.release.v1` in
  `/kortix/health` `capabilities`.
- For such a daemon the API sends `POST /kortix/config/converge`. The daemon
  then fetches the descriptor itself.
- For any other daemon the API sends only `POST /kortix/refresh?restart=0`. That
  refresh stages the new daemon through runtime assets. The API never sends
  `config_dir=1` to an old daemon: the old handler writes into `/workspace`.
- The convergence scheduler retries 6 min and 7 min after the first attempt. A
  staged daemon swaps on the first runtime-assets pass after 5 min of idle
  uptime. The 7-min attempt reaches the new daemon.

### `GET /config`, extended

Add a `release` object. Keep every existing field.

```json
{
  "release": {
    "mode": "follow-base",
    "source": "release",
    "running_release_id": "<hex or null>",
    "desired_release_id": "<hex or null>",
    "proven": true,
    "fallback_reason": null,
    "failed_release_id": null
  }
}
```

For a capable daemon, `stale` is `running_release_id !== desired_release_id`.
For an old daemon, `stale` keeps the current etag and config-dir logic. `stale`
stays tri-state: `null` when unknown, never `false`.

Update the `@kortix/sdk` types for this response. The change is additive. Load
the `sdk` skill first: test first, and no hand-bumped version.

### Quarantine across the project

- A daemon reports a failed release in health. The API records it in a new
  table `kortix.config_release_failures(project_id, release_id, session_id,
  reason, created_at)`. Load the `migration` skill.
- After failures from 2 distinct sessions, the API stops assigning that release
  in the project. It assigns the project's last release that any session proved.
- A new commit on the base branch clears the quarantine for new release IDs.

## Daemon

### Routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /kortix/config/converge` | Sandbox bearer | Fetch the descriptor from the API and apply it. No trusted body. |
| `GET /kortix/config/workspace` | Sandbox bearer | Read-only report of session work under the config dir |
| `POST /kortix/refresh?config_dir=1` | Sandbox bearer | Alias for converge, for an API that predates this spec |

Single flight: a second request while a convergence runs answers `409`.

Converge response:

```json
{
  "ok": true,
  "outcome": "applied",
  "config": {
    "release_id": "<hex or null>",
    "desired_release_id": "<hex or null>",
    "source": "release",
    "mode": "follow-base",
    "proven": true,
    "fallback_reason": null,
    "failed_release_id": null
  },
  "reload": { "how": "restarted", "turn_ended": false }
}
```

`outcome` is one of `applied`, `unchanged`, `declined`, `quarantined`,
`session-files`, or `failed`. `reload` is null when no process was replaced.
The `config` object is identical to the health `config` block.

### Apply sequence

1. Build the workspace report. Post it to the descriptor route with the
   session token as the bearer. Use the response as the descriptor.
2. If `mode` is `session-files`: point OpenCode at the workspace config dir.
   Prepare dependencies and the managed-skill overlay there first. Go to step 7.
3. If `release_id` equals the running release and the copy verifies: no-op.
4. If `release_id` is quarantined on this box: keep the running config. Report.
5. Download the archive through the API. Follow one redirect.
6. Extract into `/opt/kortix/config/<release_id>.<uuid>.tmp`. Verify every file
   against its blob ID, and reject files not in `files`. Run dependency
   preparation and the managed-skill overlay on the staged directory. Seal
   project files read-only. Rename into `/opt/kortix/config/<release_id>`.
7. Write the compiled governance for the next spawn.
8. Start a replacement OpenCode on the standby port with the new directory.
9. Run the proven check. On success, promote the replacement, retire the old
   process, and write the pointer with `proven: true`.
10. On failure, keep the old process, quarantine the release on this box, and
    report the reason.

Dependency preparation of a release (step 6) leaves OpenCode's own installer
nothing to do. OpenCode runs on the boot link, a symlink, and npm's Arborist
re-extracts the whole `node_modules` tree through a symlinked root: +5–7 s to
`opencode-ready` on the old-starter shape (measured 2026-09-22). So the staged
`package.json` gets the plugin pin of the OpenCode binary (the baked
dependency dir records it), the dependencies install offline from the Bun
cache, and a `package-lock.json` sentinel names every installed dependency.
A dependency that did not install leaves OpenCode's installer in charge. A
working-tree config dir is never changed this way.

The runtime-assets overlay pass (write `/opt/kortix/managed-skills`, inject it
into the running release), release verification, and a release's
preparation and seal run one at a time. Interleaved, verification read the
overlay names before the injection and reported an injected skill as an added
file (DEF-5). Injection into a release restores owner write on a managed
skill directory that an earlier seal made read-only.

### Proven check

A replacement OpenCode is proven when all hold:

1. It serves the session API.
2. `GET /agent` includes the default agent.
3. `GET /experimental/tool/ids` includes the base name of every `tools/*.ts` in
   `files`. If the route answers `404`, skip this condition.

Budget: the existing `VERIFY_READY_TIMEOUT_MS`, 90 s. A missing dependency does
not stop OpenCode; it drops a tool. Condition 3 catches that.

### Pointer

- `/opt/kortix/config/current.json`:
  `{ release_id, source_commit, config_dir, dir, proven }`.
- The daemon writes the pointer only after a proven promotion.
- The daemon honours a pointer only when `dir` is inside `/opt/kortix/config`
  and equals the path derived from `release_id`.

### Boot

1. Read the pointer. If it names a proven release that still verifies, spawn
   OpenCode on it before the repo clone finishes.
2. Otherwise fetch the desired descriptor in parallel with repo
   materialization. Extract before the clone finishes when possible.
3. After ready, run one convergence.
4. The seed-adoption path (`armSeedAdoption`) runs one convergence after
   adoption.

### Fallback chain

On boot, and after a failed convergence:

1. The desired release.
2. The last proven release named by the pointer.
3. The workspace config dir, when it contains `opencode.json` or
   `opencode.jsonc`.
4. The image default config dir (`cfg.defaultOpencodeConfigDir`).

Each step down records `fallback_reason`. The step that chose the running
config writes the most complete reason, because it saw every step down. A
later convergence that keeps the same running config for the same failed
release keeps that reason. A different failed release replaces it. A proven
release clears it.

### Health

Add to `/kortix/health`:

```json
{
  "capabilities": ["file.import", "file.append", "config.release.v1"],
  "config": {
    "release_id": "<hex or null>",
    "desired_release_id": "<hex or null>",
    "source": "release",
    "mode": "follow-base",
    "proven": true,
    "fallback_reason": null,
    "failed_release_id": null
  },
  "config_dir_sha": "<source commit, for readers that predate this spec>"
}
```

Remove `config_dir_sha` one release after every API reads `config`.

### Removed from the daemon

- `git fetch` of the base branch into the session repo.
- `inspectSessionConfigWork` and its history reads.
- `git archive` from the session repo.
- The separate compiled-governance env push, for capable daemons.

`boot-config.ts` stays. Its source changes from `git archive` to a downloaded
archive. Verification reads blob IDs from the descriptor.

## Repository replacement

A project can replace its repository (`repository-replacement.ts`). The
replacement writes a new `repoUrl`, a new default branch, and a new
`metadata.repository_generation`, then calls `invalidateProjectMirror`. Every
existing session keeps the previous generation in its own metadata
(`sessions.ts`). Such a session is a previous-repository session:

- `/start` rejects it unless the caller passes `repositoryMode: 'previous'` and
  a preserved runtime exists (`sessionRepositoryStartDecision`).
- The Git proxy rejects its token with `409 Session belongs to a previous
  repository` (`checkGitProxySessionGeneration`).

The sandbox side needs no change: the platform never wrote `/workspace`, and a
box boots from its release store with its local manifest, without the API.

The API side must gate. Releases are built from the project's current
repository, so an ungated descriptor would give a previous-repository session
the new repository's config and files. That is wrong behaviour, and it is a
disclosure the Git proxy already forbids. Rules:

1. `POST .../config-release` answers `409` with body
   `{ "error": "Session belongs to a previous repository", "code": "session_repository_changed" }`
   when the session's generation differs from the project's. Use
   `sessionUsesCurrentRepository`.
2. `GET .../config-archives/{tree}` answers the same `409` to a session token
   from a previous generation.
3. No trigger converges a previous-repository session. This includes the
   fan-out after the replacement's own `invalidateProjectMirror`, and a resume
   with `repositoryMode: 'previous'`.
4. `GET /config` for such a session returns `stale: false` and a `release`
   block that reports the running state. No update applies to a frozen session.
5. The daemon treats a `409` with code `session_repository_changed` as outcome
   `unchanged` with that reason. It sets no `fallback_reason` and quarantines
   nothing. The running config stays.

A session created after the replacement has the new generation and converges
normally against the new repository.

## Convergence triggers

| Trigger | Owner | Notes |
|---|---|---|
| Box boot | Daemon | After ready |
| Resume, restart | API | Exists: `scheduleSessionConfigConvergence` |
| Reload button, `kortix sessions reload` | API | Exists: `reloadSessionConfig` |
| Turn end | API | New. Debounced per session. |
| Base branch moved by an API write | API | New. `branches.ts`, `r9.ts`, `triggers.ts`, change-request merge. Fan out to idle running sessions, rate-limited. |
| Push to the base branch through the git proxy | API | New hook |
| Monitor box started | — | Not a trigger. A monitor box runs no OpenCode (`monitor-mode.ts`) and has no session row. It restarts on manifest-revision drift (`monitor-box-core.ts`). |

Never end a turn. A running turn defers convergence to the turn-end trigger.

## Web

Header states:

| State | Condition | Display |
|---|---|---|
| Current | not stale, no fallback | nothing |
| Update available | `stale: true` | existing badge |
| Session config | `mode: session-files` | neutral chip: "Running this session's config" |
| Fallback | `fallback_reason` set | error: the reason and the release now serving |

Load `kortix-brand-guidelines` and `kortix-design-system` before any
`className`. Verify both themes, 720 × 480, and the Electron shell.

## Edge cases

| Case | Behaviour |
|---|---|
| Base branch has no config dir | No release. Source `image-default`. |
| Session without repository access | No archive. Governance only. Source `image-default`. |
| Project repository replaced | Previous-generation sessions keep their running config. Descriptor and archive routes answer `409`. No trigger reaches them. New sessions converge on the new repository. |
| `.gitattributes` with `export-ignore` or `export-subst` in the config dir | Neutralised at build. Archive holds every committed file, unmodified. |
| Manifest changes `opencode.config_dir` | The new path resolves a new tree. New release ID. |
| Config dir over 4 MiB | No release. `reason` set. Running config kept. |
| Session mid-turn | Deferred to turn end. |
| Store unavailable | API streams the archive it built from the mirror. |
| API unreachable from the box | Running config kept. Next trigger retries. |
| Old daemon | Runtime refresh only. Converges after self-update. |
| Same release requested twice | No-op. No respawn. |
| Tampered or extended copy | Verification fails. Rebuilt before spawn. |
| Pointer outside the store | Ignored. |
| Disk full on the box | Extraction fails. Running config kept. Reason reported. |
| Session edits then merges its config | Files match base history. Mode returns to `follow-base`. |
| Agent writes a stray file into the config dir | Mode `session-files`. Visible chip. Known false positive. |

## Implementation sequence

Each step ends with its tests green and the end-to-end script passing where it
applies.

1. **Branch.** Merge `main` into `config-converge`. Resolve the learnings file as
   a union. Rebuild the daemon and the sandbox CLI. Run both suites.
2. **Store.** `ConfigArchiveStore` with the Supabase native implementation, lazy
   bucket, streaming fallback. Tests against local Supabase and a fake.
3. **Release builder and routes.** Descriptor and archive routes, route
   manifest, REST flows. A test that fails if a secret value appears in a
   release.
4. **Config mode in the API.** Daemon workspace report, base-history check,
   capability gate, `GET /config` extension, SDK types.
5. **Daemon.** Converge and workspace routes, apply sequence, proven check,
   pointer with `proven`, fallback chain, box quarantine, health block. Remove
   the git-based code paths.
6. **Quarantine across the project.** Migration and assignment rule.
7. **Triggers.** Turn end, API-observed base moves, git-proxy push, monitor box.
8. **Fresh boot from a release.** Descriptor at boot, parallel extraction,
   early spawn on the release. Measure.
9. **Web states.** Header chip and fallback error. Playwright journey.
10. **Docs.** `apps/web/content/docs/work/runtime.mdx` rewritten against this
    spec. `.claude/skills/learnings/SKILL.md` updated.
11. **Verification.** Local, preview, then merge on approval. Deploy Dev and
    dev re-run.

## Verification contract

- Unit: store, builder, mode detection, capability gate, apply sequence, proven
  check, fallback chain, quarantine. Real Git repositories and real archives, no
  mocked Git.
- The end-to-end script (`converge-e2e.sh`) keeps its 32 checks and adds:
  1. The descriptor's release ID equals `health.config.release_id` after
     convergence.
  2. A commit that touches no config file produces no respawn.
  3. A governance-only change produces a new release ID and the same archive.
  4. A broken config on the base branch: the replacement is declined, the box
     keeps the last proven release, and `GET /config` reports the reason.
  5. A second session hits the same broken release; a third session is assigned
     the last good release.
  6. An old daemon converges only after its self-update.
  7. A fresh session's `git status` shows no change under the config dir.
- Boot time: 10 fresh boots before and after step 8 on the preview. Record
  `opencode-spawned` and `opencode-ready` medians. Proposed budget: no more than
  300 ms added to the median time to `opencode-ready`.
- A real model turn on a session running a release.
- Local, preview, and dev each verified. A dev check alone does not replace
  the others.

## Evidence

| Fact | Source |
|---|---|
| Reload changed nothing the agent read | dev, session `6d8dfdae`, 2026-09-18 |
| Git-based copy design: 32 of 32 checks | preview, head `3e064e4d52` |
| Git-based copy design: 31 of 31 checks plus a real model turn | local worktree stack |
| Starter config archive: 178 files, 289,727 bytes | `git archive` of a starter project |
| A failed OpenCode start takes up to 90 s to detect | `VERIFY_READY_TIMEOUT_MS`, `lifecycle.ts` |
| Staged daemon swapped 10 s after a refresh past 5 min idle | preview, 2026-09-18 |
| Supabase native API refuses a second write; S3 endpoint overwrites | local Supabase probe, 2026-09-21 |
| Supabase keeps object metadata in Postgres (`storage.objects`) | local Supabase |
| Setting the snapshot bucket starts the snapshot producer | `apps/api/src/config.ts` comment |
| Warm-seed and hot-swap boot paths are unreachable | nothing in the repo sets `KORTIX_WARM_SEED` or `KORTIX_LLM_HOTSWAP` |

## Open decisions

1. Fallback display: a loud error (recommended) or a quiet notice.
2. Project quarantine threshold: 2 distinct sessions (proposed).
3. Boot-time budget: 300 ms added to the median (proposed).
4. Sign-off from the owner of the project-snapshot store that config releases
   use a separate bucket and settings.
