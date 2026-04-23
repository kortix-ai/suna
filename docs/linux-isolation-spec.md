# Linux-Level Isolation — Design Spec

**Status:** proposed
**Author:** Saumya
**Audience:** Marko (sign-off), Kortix platform team
**Last updated:** 2026-04-22

---

## 1. Why

Today a Kortix instance is a single Linux container with **one user (`abc`)** shared by every team member. Our permissions module is a **policy layer** — server checks + signed headers + scope cache — but the kernel sees one user. If a member gets a shell, or a tool escapes its sandbox, there is no OS-level wall between their work and a teammate's projects, sessions, or secrets.

Marko's ask: **Supabase identity is the root of Linux identity.** A member cannot access projects, files, processes, or secrets outside their namespace even if they bypass our code.

Policy stays (defense in depth), but the kernel becomes the primary boundary.

## 2. Goals

1. **Identity:** one-to-one Supabase user ↔ Linux uid, inside a given instance.
2. **Filesystem:** a member cannot read or write another member's project files without an explicit grant.
3. **Processes:** a member's opencode daemon runs as their uid; `kill`, `ptrace`, `/proc` leakage is blocked by POSIX + `hidepid`.
4. **Secrets:** team-shared secrets (owner's Anthropic key) never land on a member's disk or in their process memory.
5. **Extensibility:** adding a new resource type (projects, sessions, caches, …) is one file of isolation rules, not a sweep across the codebase.
6. **Clean migration:** existing instances keep working while we cut over.

## 3. Non-goals

- Hardware isolation (VM-per-member). Containers + POSIX + broker is the scope.
- Network isolation between members. Out of scope for v1.
- Multi-tenant within one container beyond `admin` + `member` roles.
- Replacing the policy layer. It stays — this spec adds OS enforcement *underneath* it.

## 4. Architecture

### 4.1 Identity mapping

- Instance container reserves uid range `[10000, 19999]`.
- `supabase_uid_map` table in kortix-master's local SQLite (authoritative inside the instance):
  ```
  supabase_user_id TEXT PRIMARY KEY
  linux_uid        INTEGER UNIQUE
  username         TEXT    UNIQUE   -- "k_<short-hash>"
  primary_gid      INTEGER          -- same as linux_uid, personal group
  created_at       INTEGER
  ```
- Allocation is deterministic: `linux_uid = 10000 + next_free_slot()`; never reused after a member is removed (we tombstone instead).
- Provisioning on first sign-in to the instance:
  1. Insert row in `supabase_uid_map`.
  2. `useradd -u <uid> -g <gid> -M -s /bin/bash k_<hash>`.
  3. `mkdir -p /home/k_<hash> && chown <uid>:<gid> /home/k_<hash> && chmod 700 /home/k_<hash>`.
  4. Seed `~/.kortix/` (0700), `~/projects/` (0700), `~/.config/opencode/` (0700).
- The owner remains the first-provisioned user (uid 10000 by convention) but has no special OS privilege — `sudo` is not granted to anyone. Privilege separation comes from the broker (§4.5), not `sudo`.

### 4.2 Filesystem boundary

One layout, one rule: **a project directory is owned by the creator's uid and a per-project POSIX group.** Members get access by being added to the group.

```
/srv/kortix/
  projects/
    <project_id>/           owner:<creator_uid>  group:proj_<project_id>  mode 2770
      .kortix/
      ... project files ...
  home/
    k_<hash>/               owner:<uid>          group:<gid>              mode 0700
      .kortix/secrets.json  owner:<uid>          mode 0600
      projects/<project_id> -> /srv/kortix/projects/<project_id>   (symlink)
```

- `2770` = setgid on directory, so new files inherit the project group. No `o+r`, no `o+w`, no `o+x`.
- Grant access: `gpasswd -a k_<hash> proj_<project_id>`.
- Revoke: `gpasswd -d k_<hash> proj_<project_id>`; revoke is instant for new processes, effective on next login for existing shells (we terminate the member's opencode daemon on revoke to force re-eval).
- Delete project: remove group, `rm -rf` directory, tombstone id.
- `/proc` mounted with `hidepid=2,gid=<kortix_admin_gid>` so members cannot see each other's processes.

### 4.3 Per-user opencode daemon

Today: one `svc-opencode-serve` runs as `abc` and every request flows through it.

New shape: **one opencode daemon per active member**, supervised by a small Bun service running as root.

- New service `svc-opencode-supervisor` replaces `svc-opencode-serve`.
- Public API (UNIX socket on `/run/kortix/supervisor.sock`, root-owned, 0660, group `kortix_admin`):
  - `POST /daemon/start { supabase_user_id }` → starts opencode under that uid if not already running; returns `{ socket: "/run/kortix/opencode/<uid>.sock" }`.
  - `POST /daemon/stop { supabase_user_id }`
  - `GET /daemon/status`
- Each member's opencode daemon:
  - runs as their uid/gid
  - listens on a UNIX socket in `/run/kortix/opencode/<uid>.sock` (0600, owned by the uid)
  - `HOME=/srv/kortix/home/k_<hash>`
  - `PATH` and config point at the per-user `~/.config/opencode/`
- `svc-kortix-master` (our Hono server) no longer talks to opencode directly. It:
  1. Resolves `MemberContext` (§4.4) from the signed request.
  2. Asks the supervisor to ensure the member's daemon is up.
  3. Proxies the request to that member's socket.
- Idle daemons are killed after N minutes of inactivity (configurable, default 15 min) to cap RAM.

### 4.4 MemberContext abstraction

One struct, threaded through every request path, replacing the current mix of "sandbox user", "session owner", "actor":

```ts
// core/kortix-master/src/services/member-context.ts
export interface MemberContext {
  supabaseUserId: string
  linuxUid: number
  username: string            // k_<hash>
  homeDir: string             // /srv/kortix/home/k_<hash>
  role: 'owner' | 'admin' | 'member'
  scopes: ReadonlySet<string>
}
```

- Built once per request in a single middleware from the verified `X-Kortix-User-Context` header + the uid map.
- Attached to Hono context as `c.var.member`.
- **Every** downstream helper (project routes, session routes, plugin tools) reads from `c.var.member`. No ad-hoc re-derivation.
- Tests get a `buildMemberContext(overrides)` fixture factory.

The abstraction is the seam that makes adding future rules cheap: a new resource type adds one isolation helper that takes `MemberContext` + the resource id, and returns allow/deny plus the concrete Linux side effect (group add, path, etc.).

### 4.5 Secrets (answering the owner-API-key question)

Two scopes:

- **instance-scoped secrets** — shared with the team (e.g. owner's Anthropic API key for opencode). Stored **only** in the root-owned secret store. Never written to any member's disk or env.
- **user-scoped secrets** — personal (member's own GitHub token). Stored in `~/.kortix/secrets.json`, 0600, owned by the member's uid.

Storage:

- `/var/kortix/secrets.db` — SQLite, root:root, 0600.
- Schema: `(scope: 'instance'|'user', owner_uid INTEGER NULL, key TEXT, value_enc BLOB, created_at, updated_at)`.
- At-rest encryption key lives in a root-only env file loaded by the broker at startup.

Access: a **secret broker** daemon running as root, listening on `/run/kortix/secrets.sock` (0660, group `kortix_admin` — only the supervisor and broker itself can connect).

Two patterns, picked per secret type:

1. **Broker-does-the-call** (for high-value secrets like the owner's LLM API key):
   - Member's opencode daemon does not hold the key.
   - When opencode needs to call Anthropic, it calls the broker: `POST /llm/complete { provider, body }`.
   - Broker injects the key, forwards the request, streams the response back.
   - Key never enters the member's uid's memory or `/proc/<pid>/environ`. `ptrace` gets them nothing.
2. **Split-uid env injection** (for low-value secrets that tools need in env):
   - Broker writes the env to the child process's env at `exec` time from the supervisor side.
   - Child runs under member uid; parent (supervisor, uid 0) sets env before `setuid`.
   - Still readable via `/proc/self/environ` by the child, so reserved for secrets we've accepted are in-process.

v1 rule: **all LLM provider keys use broker-does-the-call.** Everything else is case-by-case and defaults to broker-does-the-call when unsure.

## 5. Scope additions

Adds to `apps/api/src/permissions/catalog.ts`:

- `secrets:instance.read` (admin+owner default)
- `secrets:instance.write` (owner only)
- `secrets:user.manage` (self — always allowed for one's own secrets)

No change to the 11-scope shape philosophy; secrets join the catalog as a new group.

## 6. What gets ripped out

- `svc-opencode-serve` (replaced by supervisor + per-user daemons).
- Every `runAs: 'abc'` assumption in `core/kortix-master/scripts/run-opencode-serve.sh` and `core/s6-services/svc-opencode-serve/`.
- Ad-hoc session-owner checks (replaced by `MemberContext` + filesystem group membership).
- Any place that reads a team API key from a shared env var (replaced by the broker).

## 7. Migration

Phased, each phase leaves the instance in a working state.

**Phase 1 — Identity & filesystem (no behavior change for members):**
- Add `supabase_uid_map`, provisioning script, directory layout.
- Backfill existing members.
- Existing opencode daemon still runs as `abc`; we just now *also* have per-uid homes.

**Phase 2 — Supervisor + per-user daemons:**
- Ship `svc-opencode-supervisor`.
- Cut kortix-master's opencode client over to the supervisor.
- Retire `svc-opencode-serve`.

**Phase 3 — Broker + secrets:**
- Ship broker, move owner LLM keys into it, cut opencode's LLM path over to broker-does-the-call.
- Migrate existing team-shared env vars into the instance-scoped secret store.

**Phase 4 — Tighten:**
- `hidepid=2` on `/proc`, remove any remaining world-readable paths, enable setgid on project dirs if not already, add revoke-kills-daemon behavior.

Each phase is merge-to-main behind a kill switch (`KORTIX_LINUX_ISOLATION=on`). Old instances run the old path until flipped.

## 8. Extensibility — adding a new isolation rule later

The pattern we're committing to: one file per resource type, one function per rule.

```
core/kortix-master/src/isolation/
  projects.ts     -> projectAllow(ctx: MemberContext, projectId): Allow | Deny + side effects
  sessions.ts
  secrets.ts
  ...
```

Each module exports pure functions that take `MemberContext` and a resource id, return a structured decision, and — when granting — return the concrete OS action needed (group add, path to chown, etc.). The supervisor executes OS actions; no scattered `execSync`.

New resource = new file. No edits to request middleware, no edits to the permissions resolver. That's the property we need for this to stay clean.

## 9. Open questions for Marko

1. **Revocation speed:** is killing a member's opencode daemon on revoke acceptable (they lose in-flight work), or do we need a graceful "flush then terminate" flow?
2. **Owner privilege:** should owner get a tightly scoped `sudo` (read-only, `hidepid` bypass) for debugging, or stay fully unprivileged like everyone else?
3. **Broker scope:** v1 covers LLM keys. Do you want integrations (Slack, Jira, GitHub App tokens) in the broker day one, or incremental?
4. **VM-per-member:** explicitly out of scope here. Do you want a follow-up spec for that, or is container-level the long-term target?
5. **Instance cloning / backups:** backups currently snapshot the container. With per-uid homes and a root-owned secret store, do backups restore secrets, or do members re-enter them post-restore?

## 10. Risks

- **Kernel version:** setgid-on-dir + `hidepid=2` need modern kernels. The JustVPS baseline is fine, but any custom host needs verification.
- **Daemon fan-out cost:** N opencode daemons = N × ~150MB RAM. Idle-kill mitigates; we should size instances for `concurrent_active_members`, not `total_members`.
- **Broker as SPOF:** if the broker dies, no LLM calls work. Mitigation: s6 supervision + health check + short-lived request retry in opencode's LLM client.
- **Migration error surface:** Phase 2 is the sharpest cut. Need a rehearsal on a staging instance with a handful of real members before flipping any production instance.

---

## Appendix A — Touched files (rough)

- `core/s6-services/svc-opencode-supervisor/` (new)
- `core/s6-services/svc-kortix-secrets-broker/` (new)
- `core/s6-services/svc-opencode-serve/` (delete after Phase 2)
- `core/kortix-master/src/services/member-context.ts` (new)
- `core/kortix-master/src/services/uid-map.ts` (new)
- `core/kortix-master/src/isolation/*.ts` (new module)
- `core/kortix-master/src/services/kortix-user-middleware.ts` (extend with MemberContext build)
- `core/kortix-master/src/index.ts`, `routes/projects.ts`, `routes/sessions.ts` (read from `c.var.member`)
- `core/kortix-master/opencode/plugin/kortix-system/*` (call broker for LLM, use member socket)
- `apps/api/src/permissions/catalog.ts` (add `secrets:*` scopes)
- `apps/web/src/app/instances/_components/*` (scope matrix picks up new scopes automatically)

## Appendix B — What stays exactly as-is

- Supabase as identity provider.
- HMAC-signed `X-Kortix-User-Context` header.
- The 11-scope catalog (grows by 3 to 14).
- The policy layer (`effectiveScopes`, `useCan`, `ACTION_TO_SCOPE`). It runs *before* we hit the OS boundary.
- Drizzle + Postgres for platform-level data.
