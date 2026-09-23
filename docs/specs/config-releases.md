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

1. Every session runs the base branch's CURRENT config, at every boot and
   start of its box.
2. The platform never writes a session's `/workspace`.
3. `/workspace` stays the full editable clone: config is read and edited there,
   and an edit reaches a running box only once it is pushed to the base branch.
4. A bad config on the base branch never makes a session unbootable.
5. Every session reports which config it runs, which it wants, and why they
   differ.
6. The API decides. The sandbox daemon executes and reports.
7. The whole feature is behind one per-project flag with an operator kill
   switch, so it can be rolled out and switched off without a revert.

## Non-goals

- A per-session config policy. There is no "run my own files" mode; see
  "Feature flag" and "Boot commit policy".
- A change-request gate that requires a proven config.
- A pinned or manual release policy.
- An AWS S3 storage backend. The store interface allows it later.
- Enforcing governance independently of agent files.
- SHA-256 object-format repositories. The release builder and the archive
  route require 40-hex IDs.

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
| 2026-09-23 | The whole feature is behind the per-project `config_releases` flag, ON by default, with the operator kill switch `CONFIG_RELEASES_ENABLED`. |
| 2026-09-23 | `session-files` mode is removed. A session that edits its config dir under `/workspace` still runs the base branch's release; the edit reaches the box by being pushed. |
| 2026-09-23 | `/workspace` is not a step in the boot fallback chain while the flag is on. The chain is: desired release, last proven release, image default. |
| 2026-09-23 | The flag's authority is the boot/start of the box. It is evaluated wherever the daemon asks the API what to run. |

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
| config source | `release` or `image-default`, reported by the daemon. `workspace` exists only while the flag is OFF. |
| proven | A release passed the proven check on this box. |
| convergence | The daemon applying the desired release. |
| fallback | The daemon runs a config other than the desired release because it failed. |
| quarantine | A release recorded as failed. It is not assigned again until the base branch moves. |
| session notice | The line the daemon puts in the agent's system context naming the commit its config comes from. |
| store | The storage interface for config archives. |

## Layers and owners

| Layer | Owner | Version | Update path |
|---|---|---|---|
| Platform runtime: daemon, CLI, OpenCode binary, managed skills | Platform | API deploy | Runtime-assets digest manifest. Unchanged. |
| Project config: config dir and compiled governance | Project | Base branch commit | Config releases. This spec. |
| Session work: repo, session branch, files | User | Session branch | Never touched by the platform. `/workspace` is the editable clone; a config edit there reaches a box only after it is pushed to the base branch. |

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

`mode` is always `follow-base`. It is one member on purpose: there is no
per-session config policy, so a session that edited its config dir under
`/workspace` receives exactly this descriptor. The field stays in the wire
shape because it names the policy a release follows, and a future policy would
use it.

### Boot commit policy

The commit a release is built from is decided in ONE place:
`resolveDesiredRelease` (`apps/api/src/config-releases/desired.ts`), which
resolves `input.baseRef` — the session's base ref, else the project's default
branch — to its tip on every call.

**The policy is: the base branch tip at this boot/start.** A box asks on every
boot, so it always receives the tip of that moment, never a stale release. The
one exception is the project quarantine, which assigns the last release a
session proved when the tip's release has failed in enough sessions; a bad base
config must not make sessions unbootable.

A future policy — for example a session's own branch tip, or a pinned commit —
is a change to that one function. Nothing else moves: the release identity
already carries `source_commit`, the descriptor already reports it, the daemon
already stores it in the pointer, and the archive is keyed by content. There is
no branch-selection parameter in the code today, and none is half-built.

### The descriptor request has no inputs

The daemon posts an empty body. The desired release is the base branch's
current release for this session's variant, and nothing the box sends can
change which config it is assigned. The route reads no body at all, so a
daemon built against an older shape still converges.

There is no workspace report. The daemon does not inspect the session's
checkout, the API does not read it, and `GET /kortix/config/workspace` does not
exist.

### Routes

| Route | Caller | Purpose |
|---|---|---|
| `POST /v1/projects/{projectId}/sessions/{sessionId}/config-release` | Daemon (session token), project readers | No body. Returns the desired release descriptor. |
| `GET /v1/projects/{projectId}/config-archives/{configTreeId}` | Daemon, project readers | `302` to the store or streamed bytes |
| `GET /v1/projects/{projectId}/sessions/{sessionId}/config` | Web, CLI, SDK | Freshness and state. Extended below. |

Both config-release routes are gated on the `config_releases` flag; see
"Feature flag".

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
  "reload": { "how": "restarted", "turn_ended": false },
  "reason": null
}
```

`outcome` is one of `applied`, `unchanged`, `declined`, `quarantined`, or
`failed`. `reload` is null when no process was replaced. The `config` object is
identical to the health `config` block.

### Apply sequence

1. Fetch the descriptor from the API with the session token as the bearer. The
   request carries no inputs.
2. If `release_id` equals the running release and the copy verifies: no-op.
3. If `release_id` is quarantined on this box: keep the running config. Report.
4. Download the archive through the API. Follow one redirect.
5. Extract into `/opt/kortix/config/<release_id>.<uuid>.tmp`. Verify every file
   against its blob ID, and reject files not in `files`. Run dependency
   preparation and the managed-skill overlay on the staged directory. Seal
   project files read-only. Rename into `/opt/kortix/config/<release_id>`.
6. Write the session notice and the compiled governance for the next spawn.
7. Start a replacement OpenCode on the standby port with the new directory.
8. Run the proven check. On success, promote the replacement, retire the old
   process, and write the pointer with `proven: true`.
9. On failure, keep the old process, quarantine the release on this box, and
   report the reason.

Dependency preparation of a release (step 5) leaves OpenCode's own installer
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

### Runtime writes: what writes where

The release directory is read-only. Measured on a real Daytona box on
2026-09-24 (project `6393a5f8`, session `1a685caf`, release `7a60e568`,
source commit `378bac540aee`), by calling each writer and finding the file:

| Writer | Path it writes | Succeeds | What the user sees |
|---|---|---|---|
| The starter `memory` tool | `/workspace/.kortix/memory/**` — it resolves from OpenCode's project directory, not its config dir | yes | `File created successfully at: .kortix/memory/…`. Unaffected by releases. |
| An agent editing the project's config | `/workspace/<config dir>/**` | yes | Success, and no change to the running config. The session notice is what explains that; without it the edit looks applied. |
| An agent writing into the release | `/opt/kortix/config/<release>/**` | **no — `EACCES`** | `PermissionDenied: FileSystem.writeFile (…)`. The notice names the directory, so the agent can say why and point at `/workspace`. |
| OpenCode's spawn bookkeeping | `<release>/.gitignore`, rewritten at every spawn | best effort | Nothing. With the root sealed it is skipped silently and OpenCode still serves — no `EACCES` in either log. |
| The dependency pass (`ensureOpencodeConfigDeps`) | `<release>/node_modules/`, `package.json`, `package-lock.json`, `bun.lock` | yes | Nothing. It runs on the STAGED directory, before the seal, and verification excludes these paths. |
| The managed-skill overlay | `<release>/skills/kortix-*` | yes | Nothing. It unseals what it needs and reseals; it survives boot, `refresh?restart=0` and every rebuild. |
| OpenCode's own runtime state | `/home/kortix/.local/share/opencode/**` | yes | Nothing. Zero runtime writes into the release: `find <release> -newermt <spawn>` was empty across 954 paths after a turn that used tools, a plugin and a PTY. |
| Convergence | Rebuilds `<release>` in place | yes | Nothing, beyond an OpenCode restart. |

The platform never writes `/workspace`. Straight after boot `git status
--porcelain -uall` was empty and `.git/info/exclude` was the stock template.

**Why the root and `skills/` are sealed.** They used to stay writable for the
installer and the overlay. That made a write succeed and then disappear: an
agent's `write` tool answered "Wrote file successfully." for
`<release>/skills/<name>/SKILL.md`, the next convergence failed
`verifyRelease`, and the daemon rebuilt the release and respawned OpenCode with
nothing said to anyone. Reproduced 4 times on the box above. Both are sealed
now, so the write fails where it happens; the overlay is the one legitimate
writer and opens what it needs through `unsealManaged`. The root is sealed
after the staging directory is renamed into place, because renaming a directory
needs write permission on the directory itself.

### Telling the session

A release is served from a read-only directory. `/workspace` holds a separate
checkout, and it may be behind the commit the release was built from. An agent
that is not told reads `/workspace/.kortix/opencode`, sees different bytes from
the ones it is running, and edits files that change nothing.

So the daemon writes a short, factual note and the session reads it.

- **Channel: the agent's system context**, through OpenCode's `instructions`
  array (`/tmp/kortix/config-release.md`, declared by `writeComposedConfig`).
  This is the same mechanism `secret-capabilities.ts` uses, not a second
  channel.
- **Why not a message in the session.** Applying a release RESTARTS OpenCode.
  `instructions` is composed at every spawn, so the note survives the restart
  the convergence itself performs; a message posted to the old process does
  not. The only other in-box channel is `POST /session/:id/prompt_async`, which
  would begin a real model turn after every convergence.
- **Content**: the session runs the base branch's config at commit `<short>`;
  `/workspace` is a separate checkout and may be behind it; `git pull` there
  reads the same files; an edit under `/workspace/<config dir>` takes effect
  only after it is pushed to the base branch; `kortix sessions reload <id>`
  does both halves in one command.
- **Exactly once per convergence, never per turn.** It is a statement of state,
  so it stays true on every later turn. The writer compares the rendered text
  and does not touch the file when nothing changed, so a convergence that
  applied nothing writes nothing. The flag-off revert deletes it.

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

The box asks the API on EVERY boot. That request is the flag evaluation for
this boot (see "Feature flag"), and its answer is the release the box runs, so
a box always boots the base branch's CURRENT release rather than whatever it
ran last time.

1. Spawn OpenCode early. A proven release named by the pointer is the head
   start: OpenCode spawns on it, through the boot link, before the clone
   finishes. The pointer is NOT the decision.
2. Fetch the desired descriptor in parallel with repo materialization. Extract
   before the clone finishes when possible. When it arrives in time it is what
   the box runs; the boot link is repointed before the workspace gate opens.
3. After ready, run one convergence. It proves a release the box spawned on and
   moves the box onto the desired release if step 2 was too slow.
4. The seed-adoption path (`armSeedAdoption`) runs one convergence after
   adoption.

### Fallback chain

With config releases ON, on boot and after a failed convergence:

1. The desired release.
2. The last proven release named by the pointer.
3. The image default config dir (`cfg.defaultOpencodeConfigDir`).

**`/workspace` is not a step.** A box must never silently run a stale session
checkout as the project's config; the image default is the floor, so the box
still becomes ready and the header reports why.

With config releases OFF — the pre-release behaviour:

1. The workspace config dir, when it contains `opencode.json` or
   `opencode.jsonc`.
2. The image default config dir.

`resolveBootConfig` is told which chain to walk by the API's answer on this
boot: `false` after a `403 feature_disabled`, `true` after a descriptor. When
the API could not be asked at all, the boot pointer is the record of the last
answer — a box that holds one ran a release and takes the ON chain, a box that
holds none has no evidence the feature is on and takes the OFF chain, which is
what it always did.

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
- The workspace report (`config-release/workspace-report.ts`) and
  `GET /kortix/config/workspace`. Nothing reads a session's checkout to decide
  its config any more.

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

## Feature flag

The whole feature is behind ONE per-project flag, so it can be rolled out per
project and switched off without a revert.

| | |
|---|---|
| Key | `config_releases` |
| Name | Config Releases |
| Stability | `experimental` |
| Default | **ON.** This is the intended behaviour; the flag exists to turn it OFF. |
| Operator kill switch | `CONFIG_RELEASES_ENABLED` (`apps/api/src/config.ts`), default `true`. Set it to `false` and the flag is unavailable platform-wide: the Settings row disappears and the surface is dark for every project, whatever a project chose. |
| Per-project state | `projects.metadata.experimental.config_releases`, written by `PATCH /v1/projects/:projectId/features`. |
| Registry entry | `apps/api/src/feature-flags/registry.ts` |
| One read | `apps/api/src/config-releases/enabled.ts` — `configReleasesEnabled(metadata)` / `projectConfigReleasesEnabled(projectId)`. Nothing else reads the key. |

### The flag's authority is the boot/start of the box

The flag decides two things TOGETHER, as one unit, for that box:

1. whether the box enforces the base branch's current config, and
2. whether OpenCode boots from the read-only release store
   `/opt/kortix/config/<release>` instead of the workspace config dir.

It is evaluated wherever the daemon asks the API what to run, on every boot and
start — fresh boot, restart, resume — never once at session creation. Flipping
it takes effect on the NEXT boot or start of that session's box, with no
redeploy and no session deletion. A running box keeps working until then.

The mid-session convergence triggers (turn end, base-branch moves, git-proxy
push, the reload) follow the same project flag, because they are the same
behaviour. But the boot/start decision is the authority, and the one chokepoint
the boot path reads is the **descriptor request** (`fetchBootRelease`,
`apps/kortix-sandbox-agent-server/src/harness/open-code/config-release.ts`): a
descriptor means ON, a `403 feature_disabled` means OFF.

### Chokepoints

One per server path. There is no check sprinkled anywhere else.

| # | Path | File | Off ⇒ |
|---|---|---|---|
| 1 | Descriptor route | `apps/api/src/config-releases/routes.ts` `configReleasesGate` | `403 feature_disabled` |
| 2 | Archive route | the same `configReleasesGate` | `403 feature_disabled` |
| 3 | Reload | `apps/api/src/projects/lib/session-reload.ts` `reloadSessionConfig` (`deps.configReleasesEnabled`) | The daemon's capability is ignored; the pre-release path runs: `POST /kortix/refresh?restart=0` plus the compiled-governance push, an etag result, no `release` block, no ledger write |
| 4 | Every convergence trigger | `apps/api/src/projects/lib/session-config-convergence.ts` `convergeSessionConfig` | Outcome `disabled`; nothing reaches the box. A RESTART still pushes the compiled governance, as it did before config releases (`legacyGovernancePush`) |
| 5 | `GET /config` | `apps/api/src/projects/routes/session-config.ts` | No `release` block; no desired release is built; `stale` is the pre-release etag compare alone |
| 6 | Boot and convergence in the box | `harness/open-code/config-release.ts` `revertToPreReleaseConfig`, `fetchBootRelease`, `resolveBootConfig` | OpenCode reads the workspace config dir; the boot pointer is ignored and cleared |

Resume, restart, turn end, base-branch writes (`branches.ts`, `r9.ts`,
`triggers.ts`, change-request merge) and git-proxy pushes all reach
`convergeSessionConfig`, so chokepoint 4 covers every one of them.

### Behaviour when the flag is OFF

The pre-release behaviour, not a half state.

1. Both config-release routes answer `403` with
   `{ "code": "feature_disabled", "feature": "config_releases" }`, after
   membership authz.
2. No release is built, no archive is uploaded to storage, no row is written to
   `kortix.config_releases` or `kortix.config_release_failures`, and no
   quarantine is evaluated.
3. No convergence trigger fires.
4. A session boots and reloads as it did before this feature: OpenCode reads
   the workspace config dir, `kortix sessions reload` refreshes the checkout and
   pushes the compiled governance, and `GET /config` carries no `release`
   block — so the CLI formatter and the web header render their old,
   etag-based text.
5. The daemon logs one clear line and continues. It never retries and never
   quarantines anything.

**Known deviation from `origin/main`, stated plainly.** The daemon's own
`git`-based config-dir sync into `/workspace` was removed by this branch for
both flag states (see "Removed from the daemon"), because it was the broken
mechanism this spec replaces — on `main` the web's reload sent
`refresh_repo: false` and skipped that half anyway (see "Problem"). With the
flag OFF the config FILES therefore do not converge, exactly as they
effectively did not on `main`; the compiled governance still does.

### Transitions

- **ON → OFF, box already running a release.** The box is not stranded. On its
  next convergence or boot the API answers `403`; `revertToPreReleaseConfig`
  prepares the workspace config dir, swaps OpenCode onto it, clears
  `/opt/kortix/config/current.json`, and deletes the session notice. Nothing is
  quarantined and no `fallback_reason` is set. A running turn defers the swap
  to the next trigger. Until then the session keeps working on the release it
  has.
- **ON → OFF, box restarted before any convergence saw the flag.** The boot
  descriptor request answers `403`, `resolveBootConfig` ignores the pointer
  outright, and OpenCode boots on the workspace config dir. The pointer is
  cleared by the convergence after ready. The restart's governance push is
  ignored by a box that still has a release active
  (`releaseGovernanceActive`, `harness/open-code/control.ts`) — it logs one
  line and skips, and the next boot has no release to own it.
- **OFF → ON.** The next boot or trigger receives a descriptor and the box
  converges onto the base branch's current release. The session is never
  deleted and never recreated.
- **Operator kill switch.** `CONFIG_RELEASES_ENABLED=false` makes every project
  take the OFF path at once, whatever each project chose.

### Registration

The key lives in six places (`apps/api/src/feature-flags/registry.ts` header):
the contract schema and its two test copies, the SDK union and
`FEATURE_FLAG_KEYS` and its test, the registry entry, and the
`useProjectFeatureFlags` hook + map. Four drift tests guard them.

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
| Fallback | `fallback_reason` set | error: the reason and the release now serving |

There is no "runs its own config" state. A session that edited its config dir
under `/workspace` still runs the base branch's release, so the header shows
nothing new.

**"Reload config" does both halves and says so.** It converges the running
config AND fast-forwards the `/workspace` checkout (`refresh_repo: true`), and
the toast carries the server's `detail`, which names what happened to each. The
pull is `--ff-only` on the session's OWN branch and can discard nothing; a
checkout left behind is the confusion the control exists to remove.
`kortix sessions reload <id>` is the same operation with the same sentence.

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
| Agent edits the config dir in `/workspace` | The box keeps running the base release. The edit applies after it is pushed to the base branch. |
| `config_releases` off for the project | No release is built, stored, or assigned. The box reads its workspace config dir. See "Feature flag". |

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
4. **Capability gate**, `GET /config` extension, SDK types.
5. **Daemon.** Converge route, apply sequence, proven check, pointer with
   `proven`, fallback chain, box quarantine, health block. Remove the
   git-based code paths.
6. **Quarantine across the project.** Migration and assignment rule.
7. **Triggers.** Turn end, API-observed base moves, git-proxy push, monitor box.
8. **Fresh boot from a release.** Descriptor at boot, parallel extraction,
   early spawn on the release. Measure.
9. **Web states.** Fallback error. Playwright journey.
10. **Feature flag.** `config_releases`, ON by default, with the
    `CONFIG_RELEASES_ENABLED` kill switch and the six chokepoints above. Remove
    `session-files` mode and the workspace report end to end. Drop `/workspace`
    from the boot fallback chain. Tell the session which commit it runs.
11. **Docs.** `apps/web/content/docs/work/runtime.mdx` rewritten against this
    spec. `.claude/skills/learnings/SKILL.md` updated.
12. **Verification.** Local, preview, then merge on approval. Deploy Dev and
    dev re-run.

## Verification contract

- Unit: store, builder, capability gate, apply sequence, proven check, fallback
  chain, quarantine, the feature flag and its transitions, the session notice.
  Real Git repositories and real archives, no mocked Git.
- REST flows `CFG-1` … `CFG-8` (`tests/spec/end-to-end.md`), on the local
  profile AND a deployed target. `CFG-8` is the flag: off, back on, and the
  ledger untouched while off.
- The end-to-end script (`converge-e2e.sh`) keeps its checks and adds:
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
  8. The flag flipped OFF and the box RESTARTED: it boots the workspace config
     dir and no longer reads `/opt/kortix/config`. Flipped ON and restarted
     again: it boots the release.
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
| The `memory` tool writes `/workspace/.kortix/memory`, not the config dir | Daytona box, 2026-09-24, session `1a685caf` |
| A write into an unsealed release root or `skills/` succeeded, then vanished with an unannounced OpenCode respawn | same box, reproduced 4× |
| OpenCode serves normally with the release root at `0555`; its `.gitignore` write is skipped silently | same box |
| Zero OpenCode runtime writes into the release after a turn using tools, a plugin and a PTY | same box, `find <release> -newermt <spawn>` empty over 954 paths |
| The agent reads the session notice and repeats the commit and the reload command | same box, real model turn |

## Open decisions

1. Fallback display: a loud error (recommended) or a quiet notice.
2. Project quarantine threshold: 2 distinct sessions (proposed).
3. Boot-time budget: 300 ms added to the median (proposed).
4. Sign-off from the owner of the project-snapshot store that config releases
   use a separate bucket and settings.
