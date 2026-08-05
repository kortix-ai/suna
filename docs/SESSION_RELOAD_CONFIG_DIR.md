# Why a session reload updates the working tree, and why it must not reset the branch

Recorded here rather than in an issue tracker: GitHub issues are disabled on this
repo, and the two traps below are the kind a future change re-introduces by
accident because both look obviously correct.

Companion to `SESSION_CONFIG_RELOAD.md`, which describes the reload's design.
This one records what shipped, what was wrong with it, and how it was measured.

## The bug: reload reported success, the agent kept the old prompt

`POST /v1/projects/{id}/sessions/{sid}/reload` answered `applied: true`, advanced
`agent_config_etag`, and flipped `--status` to "Up to date" — while the agent
demonstrably ran the previous prompt.

Measured on dev (`65bb25155f`, real sandbox), by appending a unique marker to an
agent prompt via `PUT /projects/{id}/agents/kortix/config` (which commits to
`main`) and then reloading:

```
$ grep -c RELOAD-E2E-MARKER-A1B2C3 ~/.config/kortix-opencode.json
1                                    # the pushed compiled config HAS it

$ curl -s localhost:4096/config | grep -c RELOAD-E2E-MARKER-A1B2C3
0                                    # the RUNNING opencode does NOT
$ curl -s localhost:4096/agent  | grep -c RELOAD-E2E-MARKER-A1B2C3
0
```

The probe is valid — both endpoints contain other prompt text:

```
$ curl -s localhost:4096/config | grep -c "Kortix general knowledge worker"
1
```

Still 0 after a full re-provision, so it was not the dispose fast path.

### Root cause

```
OPENCODE_CONFIG=/home/kortix/.config/kortix-opencode.json
OPENCODE_CONFIG_DIR=/workspace/.kortix/opencode
```

`OPENCODE_CONFIG_DIR` points **into the session's working tree**, and the agent
`.md` files there beat the compiled config pushed as JSON. The prompt change
landed on `main`; the session branch never received it, so the file opencode
actually reads was unchanged.

**The etag measured the compiled config. Behaviour came from the working tree.**
Two different things, and only the first was checked — so the freshness signal
built to expose staleness was hiding it.

## Trap 1: `base=1` is not the fix. It destroys committed work.

The obvious repair is to sync the workspace to base. It is the wrong one.

`?base=1` routes the daemon to `syncWorkspaceToBase`, whose entire body is:

```
git checkout -B <cfg.branchName> <baseSha>
```

`cfg.branchName` is the **session id** (`session-runtime-env.ts`,
`KORTIX_BRANCH_NAME: input.sessionId`). On a session carrying commits of its own
— the normal state before a change request — that force-moves the working branch
onto the base tip, orphaning them. Reproduced on a live sandbox:

```
$ git checkout -B throwaway-reset-test origin/main
Reset branch 'throwaway-reset-test'
$ ls canary2.txt
ls: cannot access 'canary2.txt': No such file or directory
```

The helper states the precondition it needs in its own docstring — *"safe because
a fresh session has no local work yet"* — and its only other caller honours it, at
session **create**, on a restored warm snapshot. A reload runs against an
established session, where it does not hold.

**Do not add `base=1` to any path that runs against a live session.**

### And the reset cannot be gated from the API

The natural mitigation — only reset when the session has no local commits — is
not available server-side. The API can only inspect the **git mirror**, and a
session branch that was committed but never pushed does not exist there. The
check would answer "no local work" for exactly the session with the most to lose.

## What shipped instead

`?config_dir=1` on `POST /kortix/refresh` →
`syncOpencodeConfigDirToBase` (`apps/kortix-sandbox-agent-server/src/git.ts`):

```
git checkout <baseSha> -- <opencode config dir>
git reset -q -- <opencode config dir>
```

One pathspec. No ref moved. Commits, other files, and the branch are untouched.
Left unstaged, and its diff against base is empty by construction — so a change
request opened from the session carries no spurious config diff.

It **refuses** rather than overwrites when the session has its own work there:

| Skip reason | Meaning |
|---|---|
| `local changes` | uncommitted edits (or untracked files) under the config dir |
| `local commits` | the session committed its own agent changes on top of base |
| `already matches base` | nothing to do — reported as success, not a warning |
| `no tracked config dir` / `not in base` | the project keeps no agent files in the repo |

### Ordering is load-bearing

"Already matches base" is checked **before** dirtiness, and this is not cosmetic.
A successful sync leaves the working tree matching base while `HEAD` still has the
old content — so the directory is legitimately dirty afterwards. Checking
dirtiness first made every reload after the first refuse with `local changes`,
because the guard could not distinguish the user's edit from our own previous one.
A test caught this; the first draft had it backwards.

### Backward compatibility

The daemon is baked into the sandbox image, so a running sandbox may predate this.
An older daemon ignores the unknown query parameter and performs the plain
refresh — exactly the previous behaviour. The API therefore sends `config_dir=1`
unconditionally, with no version negotiation, and reads a missing `config_dir` in
the response as `null` ("could not tell"), never `false`.

## Trap 2: never report success for the compiled config alone

`applied` means the compiled config was pushed. It does **not** mean the agent
changed. `reloadDetail()` (`apps/api/src/projects/lib/session-reload.ts`) is the
only place allowed to make that claim, and it may only do so when
`config_dir_synced === true`.

`config_dir_synced` is tri-state and the third state matters:

- `true` — the agent files were brought forward; the agent will behave differently
- `false` — a deliberate refusal; the session's own version was kept
- `null` — an older daemon could not say; claiming either way would be guessing

Reading `null` as `false` would tell a user their agent was deliberately skipped,
which is a different and wrong statement.

## What to check if you touch this

1. The reload must never move a ref. `git rev-parse HEAD` and
   `git branch --show-current` are identical before and after.
2. A session with committed work keeps it, and keeps its files.
3. A session that edited its own agent config keeps that, and is **told** so.
4. After a real merge, the marker appears in `localhost:4096/config` — not just in
   `~/.config/kortix-opencode.json`. The second proves the push; only the first
   proves the agent changed.

Point 4 is the one that was never checked, and it is why this shipped broken.
